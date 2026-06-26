import type { AffineTransform } from './geo'

export type ExportOptions = {
  image: HTMLImageElement
  imageFile: File
  transform: AffineTransform
  epsg: '4326' | '3857' | 'raw'
  filename: string
  onProgress?: (message: string) => void
}

const MAX_UNCOMPRESSED_TIFF_BYTES = 512 * 1024 * 1024
const WORKER_TIMEOUT_MS = 90_000

export async function exportGeoTiff(options: ExportOptions) {
  const estimatedBytes = options.image.naturalWidth * options.image.naturalHeight * 3
  if (estimatedBytes > MAX_UNCOMPRESSED_TIFF_BYTES) {
    throw new Error(
      `预计未压缩 GeoTIFF 约 ${formatBytes(estimatedBytes)}，超过当前浏览器安全上限 ${formatBytes(MAX_UNCOMPRESSED_TIFF_BYTES)}。请改用 JPG + 配准 JSON，或先降采样导出。`,
    )
  }

  options.onProgress?.('正在读取原始图片...')
  const imageBuffer = await options.imageFile.arrayBuffer()
  options.onProgress?.(`正在后台解码并生成 GeoTIFF（${options.image.naturalWidth} x ${options.image.naturalHeight}）...`)
  let arrayBuffer: ArrayBuffer
  try {
    arrayBuffer = await runExportWorker(
      {
      mode: 'image',
      imageBuffer,
      mimeType: options.imageFile.type || 'image/jpeg',
      transform: options.transform,
      epsg: options.epsg,
      },
      options.onProgress,
    )
  } catch (error) {
    options.onProgress?.('后台解码失败，正在使用兼容模式读取像素...')
    const imageData = readImageDataOnMainThread(options.image)
    arrayBuffer = await runExportWorker(
      {
        mode: 'rgba',
        rgba: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
        transform: options.transform,
        epsg: options.epsg,
      },
      options.onProgress,
    )
    if (error instanceof Error) {
      console.warn(error)
    }
  }
  downloadBlob(new Blob([arrayBuffer], { type: 'image/tiff' }), options.filename)
}

type WorkerPayload =
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

function runExportWorker(payload: WorkerPayload, onProgress?: (message: string) => void) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL('./geotiffWorker.ts', import.meta.url), { type: 'module' })
    const timeout = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('GeoTIFF Worker 超时，已停止导出。建议改用 JPG + 配准 JSON 或降采样。'))
    }, WORKER_TIMEOUT_MS)

    worker.onmessage = (event: MessageEvent<{ ok: true; buffer: ArrayBuffer } | { ok: false; error: string } | { ok: false; progress: string }>) => {
      if ('progress' in event.data) {
        onProgress?.(event.data.progress)
        return
      }
      window.clearTimeout(timeout)
      worker.terminate()
      if (event.data.ok) {
        resolve(event.data.buffer)
      } else {
        reject(new Error(event.data.error))
      }
    }
    worker.onerror = (event) => {
      window.clearTimeout(timeout)
      worker.terminate()
      reject(new Error(event.message || 'GeoTIFF Worker 执行失败。'))
    }
    worker.postMessage(payload, [payload.mode === 'image' ? payload.imageBuffer : payload.rgba])
  })
}

function readImageDataOnMainThread(image: HTMLImageElement) {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('浏览器不支持 Canvas 读取。')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)}GB`
  }
  return `${(bytes / 1024 ** 2).toFixed(0)}MB`
}
