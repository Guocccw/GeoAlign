import { writeArrayBuffer } from 'geotiff'
import type { AffineTransform } from './geo'

type WorkerScope = {
  onmessage: ((event: MessageEvent<ExportPayload>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

type ExportPayload =
  | {
      mode: 'image'
      imageBuffer: ArrayBuffer
      mimeType: string
      transform: AffineTransform
      epsg: '4326' | '3857' | 'raw'
    }
  | {
      mode: 'rgba'
      rgba: ArrayBuffer
      width: number
      height: number
      transform: AffineTransform
      epsg: '4326' | '3857' | 'raw'
    }

const workerScope = self as unknown as WorkerScope

workerScope.onmessage = async (event: MessageEvent<ExportPayload>) => {
  try {
    workerScope.postMessage({ ok: false, progress: 'Worker 已启动，正在处理图片像素...' })
    const buffer = await writeGeoTiff(event.data)
    workerScope.postMessage({ ok: true, buffer }, [buffer])
  } catch (error) {
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.message : 'GeoTIFF 生成失败。' })
  }
}

async function writeGeoTiff(payload: ExportPayload) {
  let rgba: Uint8ClampedArray | Uint8Array
  let width: number
  let height: number

  if (payload.mode === 'image') {
    const imageBitmap = await createImageBitmap(new Blob([payload.imageBuffer], { type: payload.mimeType }))
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('Worker 无法读取图片像素。')
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(imageBitmap, 0, 0)
    imageBitmap.close()
    rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    width = canvas.width
    height = canvas.height
  } else {
    rgba = new Uint8Array(payload.rgba)
    width = payload.width
    height = payload.height
  }

  workerScope.postMessage({ ok: false, progress: `正在展开 RGB 像素（${width} x ${height}）...` })
  const rgb = new Uint8Array(width * height * 3)
  let sum = 0

  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    const alpha = rgba[source + 3] / 255
    const red = Math.round(rgba[source] * alpha + 255 * (1 - alpha))
    const green = Math.round(rgba[source + 1] * alpha + 255 * (1 - alpha))
    const blue = Math.round(rgba[source + 2] * alpha + 255 * (1 - alpha))
    rgb[target] = red
    rgb[target + 1] = green
    rgb[target + 2] = blue
    sum += red + green + blue
  }

  if (sum === 0) {
    throw new Error('导出的像素全为黑色，图片解码失败。')
  }

  const metadata: Record<string, unknown> = {
    width,
    height,
    BitsPerSample: [8, 8, 8],
    SamplesPerPixel: [3],
    PhotometricInterpretation: 2,
    PlanarConfiguration: 1,
    Compression: 1,
    SampleFormat: [1, 1, 1],
    ExtraSamples: [],
    Software: 'GeoAlign browser exporter',
    ModelTransformation: [
      payload.transform.a,
      payload.transform.b,
      0,
      payload.transform.c,
      payload.transform.d,
      payload.transform.e,
      0,
      payload.transform.f,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
    ],
    GTRasterTypeGeoKey: 1,
  }

  if (payload.epsg === '4326') {
    metadata.GeographicTypeGeoKey = 4326
    metadata.GeogCitationGeoKey = 'WGS 84'
    metadata.GTModelTypeGeoKey = 2
  }
  if (payload.epsg === '3857') {
    metadata.ProjectedCSTypeGeoKey = 3857
    metadata.PCSCitationGeoKey = 'WGS 84 / Pseudo-Mercator'
    metadata.ProjLinearUnitsGeoKey = 9001
    metadata.GTModelTypeGeoKey = 1
  }

  workerScope.postMessage({ ok: false, progress: '正在写入 GeoTIFF 二进制...' })
  return writeArrayBuffer(rgb, metadata as never)
}
