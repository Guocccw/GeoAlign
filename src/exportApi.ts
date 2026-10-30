import type { AffineTransform, ControlPoint, GeometrySegment } from './geo'

export type BackendExportRequest = {
  imageFile: File
  imageWidth: number
  imageHeight: number
  controlPoints: ControlPoint[]
  segments: GeometrySegment[]
  transform: AffineTransform
  crs: string
}

const EXPORT_ENDPOINT = 'http://127.0.0.1:8765/export'

export async function exportAlignmentPackage(request: BackendExportRequest) {
  const form = new FormData()
  form.append('image', request.imageFile)
  form.append(
    'payload',
    JSON.stringify({
      imageWidth: request.imageWidth,
      imageHeight: request.imageHeight,
      controlPoints: request.controlPoints,
      segments: request.segments,
      transform: request.transform,
      crs: request.crs,
    }),
  )

  const response = await fetch(EXPORT_ENDPOINT, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `后端导出失败：${response.status}`)
  }

  const blob = await response.blob()
  const filename = parseDownloadFilename(response.headers.get('content-disposition')) ?? `${stripExtension(request.imageFile.name)}-geoalign.zip`
  downloadBlob(blob, filename)
}

function parseDownloadFilename(disposition: string | null) {
  const encodedMatch = disposition?.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    return decodeURIComponent(encodedMatch[1])
  }
  const match = disposition?.match(/filename="([^"]+)"/)
  return match?.[1]
}

function stripExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, '')
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
