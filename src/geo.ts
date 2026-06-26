import proj4 from 'proj4'

export type Point = {
  x: number
  y: number
}

export type ControlPoint = {
  id: string
  image?: Point
  world?: Point
  residual?: number
}

export type AffineTransform = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export type FitResult = {
  transform: AffineTransform
  inverse: AffineTransform
  rms: number
  maxResidual: number
  residuals: Map<string, number>
}

export type GeometrySegment = {
  id: string
  type: 'Point' | 'LineString' | 'Polygon'
  rings: Point[][]
}

export type Bounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const EPSG3857 = '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs'

export function applyAffine(transform: AffineTransform, point: Point): Point {
  return {
    x: transform.a * point.x + transform.b * point.y + transform.c,
    y: transform.d * point.x + transform.e * point.y + transform.f,
  }
}

export function invertAffine(transform: AffineTransform): AffineTransform {
  const det = transform.a * transform.e - transform.b * transform.d
  if (Math.abs(det) < 1e-12) {
    throw new Error('控制点接近共线，无法反算变换。')
  }

  return {
    a: transform.e / det,
    b: -transform.b / det,
    c: (transform.b * transform.f - transform.e * transform.c) / det,
    d: -transform.d / det,
    e: transform.a / det,
    f: (transform.d * transform.c - transform.a * transform.f) / det,
  }
}

export function fitAffine(points: ControlPoint[]): FitResult | null {
  const complete = points.filter((point) => point.image && point.world)
  if (complete.length < 3) {
    return null
  }

  const normal = Array.from({ length: 6 }, () => Array(6).fill(0) as number[])
  const rhs = Array(6).fill(0) as number[]

  for (const point of complete) {
    const image = point.image as Point
    const world = point.world as Point
    addEquation(normal, rhs, [image.x, image.y, 1, 0, 0, 0], world.x)
    addEquation(normal, rhs, [0, 0, 0, image.x, image.y, 1], world.y)
  }

  const solution = solveLinearSystem(normal, rhs)
  if (!solution) {
    return null
  }

  const transform = {
    a: solution[0],
    b: solution[1],
    c: solution[2],
    d: solution[3],
    e: solution[4],
    f: solution[5],
  }
  const inverse = invertAffine(transform)
  const residuals = new Map<string, number>()
  let sumSquares = 0
  let maxResidual = 0

  for (const point of complete) {
    const predicted = applyAffine(transform, point.image as Point)
    const world = point.world as Point
    const residual = Math.hypot(predicted.x - world.x, predicted.y - world.y)
    residuals.set(point.id, residual)
    sumSquares += residual * residual
    maxResidual = Math.max(maxResidual, residual)
  }

  return {
    transform,
    inverse,
    rms: Math.sqrt(sumSquares / complete.length),
    maxResidual,
    residuals,
  }
}

export function evaluateAffine(points: ControlPoint[], transform: AffineTransform): FitResult | null {
  const complete = points.filter((point) => point.image && point.world)
  if (complete.length < 1) {
    return null
  }

  const inverse = invertAffine(transform)
  const residuals = new Map<string, number>()
  let sumSquares = 0
  let maxResidual = 0

  for (const point of complete) {
    const predicted = applyAffine(transform, point.image as Point)
    const world = point.world as Point
    const residual = Math.hypot(predicted.x - world.x, predicted.y - world.y)
    residuals.set(point.id, residual)
    sumSquares += residual * residual
    maxResidual = Math.max(maxResidual, residual)
  }

  return {
    transform,
    inverse,
    rms: Math.sqrt(sumSquares / complete.length),
    maxResidual,
    residuals,
  }
}

export function transformGeoJson(input: unknown, mode: 'raw' | 'epsg3857' | 'custom', customProj?: string): GeometrySegment[] {
  const segments: GeometrySegment[] = []
  const projection = mode === 'epsg3857' ? EPSG3857 : mode === 'custom' ? customProj?.trim() : ''

  const convert = (coordinate: unknown): Point | null => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      return null
    }
    const lon = Number(coordinate[0])
    const lat = Number(coordinate[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return null
    }
    if (projection) {
      const [x, y] = proj4('EPSG:4326', projection, [lon, lat])
      return { x, y }
    }
    return { x: lon, y: lat }
  }

  const visitGeometry = (geometry: any, idPrefix: string) => {
    if (!geometry) return
    if (geometry.type === 'GeometryCollection') {
      geometry.geometries?.forEach((item: unknown, index: number) => visitGeometry(item, `${idPrefix}.${index}`))
      return
    }
    if (geometry.type === 'Point') {
      const point = convert(geometry.coordinates)
      if (point) segments.push({ id: idPrefix, type: 'Point', rings: [[point]] })
      return
    }
    if (geometry.type === 'MultiPoint') {
      geometry.coordinates?.forEach((coordinate: unknown, index: number) => {
        const point = convert(coordinate)
        if (point) segments.push({ id: `${idPrefix}.${index}`, type: 'Point', rings: [[point]] })
      })
      return
    }
    if (geometry.type === 'LineString') {
      const ring = convertLine(geometry.coordinates, convert)
      if (ring.length) segments.push({ id: idPrefix, type: 'LineString', rings: [ring] })
      return
    }
    if (geometry.type === 'MultiLineString') {
      geometry.coordinates?.forEach((line: unknown, index: number) => {
        const ring = convertLine(line, convert)
        if (ring.length) segments.push({ id: `${idPrefix}.${index}`, type: 'LineString', rings: [ring] })
      })
      return
    }
    if (geometry.type === 'Polygon') {
      const rings = geometry.coordinates?.map((ring: unknown) => convertLine(ring, convert)).filter((ring: Point[]) => ring.length) ?? []
      if (rings.length) segments.push({ id: idPrefix, type: 'Polygon', rings })
      return
    }
    if (geometry.type === 'MultiPolygon') {
      geometry.coordinates?.forEach((polygon: unknown, index: number) => {
        const rings = Array.isArray(polygon)
          ? polygon.map((ring: unknown) => convertLine(ring, convert)).filter((ring: Point[]) => ring.length)
          : []
        if (rings.length) segments.push({ id: `${idPrefix}.${index}`, type: 'Polygon', rings })
      })
    }
  }

  const source: any = input
  if (source?.type === 'FeatureCollection') {
    source.features?.forEach((feature: any, index: number) => visitGeometry(feature.geometry, String(feature.id ?? index + 1)))
  } else if (source?.type === 'Feature') {
    visitGeometry(source.geometry, String(source.id ?? 1))
  } else {
    visitGeometry(source, '1')
  }

  return segments
}

export function getBounds(segments: GeometrySegment[]): Bounds | null {
  let bounds: Bounds | null = null
  for (const segment of segments) {
    for (const ring of segment.rings) {
      for (const point of ring) {
        bounds = expandBounds(bounds, point)
      }
    }
  }
  return bounds
}

export function expandBounds(bounds: Bounds | null, point: Point): Bounds {
  if (!bounds) {
    return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }
  }
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }
}

export function fitToViewport(bounds: Bounds, width: number, height: number, padding = 32): AffineTransform {
  const safeWidth = Math.max(bounds.maxX - bounds.minX, 1)
  const safeHeight = Math.max(bounds.maxY - bounds.minY, 1)
  const scale = Math.min((width - padding * 2) / safeWidth, (height - padding * 2) / safeHeight)
  const offsetX = (width - safeWidth * scale) / 2
  const offsetY = (height - safeHeight * scale) / 2

  return {
    a: scale,
    b: 0,
    c: offsetX - bounds.minX * scale,
    d: 0,
    e: -scale,
    f: offsetY + bounds.maxY * scale,
  }
}

export function formatNumber(value?: number, digits = 3): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs !== 0 && (abs >= 100000 || abs < 0.001)) {
    return value.toExponential(2)
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

function convertLine(line: unknown, convert: (coordinate: unknown) => Point | null): Point[] {
  if (!Array.isArray(line)) return []
  return line.map(convert).filter(Boolean) as Point[]
}

function addEquation(normal: number[][], rhs: number[], row: number[], value: number) {
  for (let i = 0; i < row.length; i += 1) {
    rhs[i] += row[i] * value
    for (let j = 0; j < row.length; j += 1) {
      normal[i][j] += row[i] * row[j]
    }
  }
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length
  const augmented = matrix.map((row, index) => [...row, vector[index]])

  for (let column = 0; column < size; column += 1) {
    let pivot = column
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row
      }
    }

    if (Math.abs(augmented[pivot][column]) < 1e-10) {
      return null
    }

    ;[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]]
    const divisor = augmented[column][column]
    for (let col = column; col <= size; col += 1) {
      augmented[column][col] /= divisor
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue
      const factor = augmented[row][column]
      for (let col = column; col <= size; col += 1) {
        augmented[row][col] -= factor * augmented[column][col]
      }
    }
  }

  return augmented.map((row) => row[size])
}
