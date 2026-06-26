import type { AffineTransform, ControlPoint, GeometrySegment } from './geo'

export type RefineRequest = {
  imageFile: File
  imageWidth: number
  imageHeight: number
  segments: GeometrySegment[]
  controlPoints: ControlPoint[]
  transform: AffineTransform
}

export type RefineResponse = {
  transform: AffineTransform
  correlation: number
  delta: AffineTransform
  message: string
  scale: number
}

const REFINE_ENDPOINT = 'http://127.0.0.1:8765/refine'

export async function refineAlignment(request: RefineRequest): Promise<RefineResponse> {
  const form = new FormData()
  form.append('image', request.imageFile)
  form.append(
    'payload',
    JSON.stringify({
      imageWidth: request.imageWidth,
      imageHeight: request.imageHeight,
      segments: request.segments,
      controlPoints: request.controlPoints,
      transform: request.transform,
    }),
  )

  const response = await fetch(REFINE_ENDPOINT, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `自动精修失败：${response.status}`)
  }

  return response.json() as Promise<RefineResponse>
}
