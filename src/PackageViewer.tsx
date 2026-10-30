import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { SatelliteCompare } from './SatelliteCompare'
import { exportAlignmentPackage } from './exportApi'
import proj4 from 'proj4'
import {
  type AffineTransform,
  type ControlPoint,
  EPSG3857,
  type GeometrySegment,
  type Point,
  applyAffine,
  fitToViewport,
  formatNumber,
  getBounds,
  invertAffine,
  transformGeoJson,
} from './geo'

type LatLng = {
  lng: number
  lat: number
}

type PackageData = {
  imageName: string
  imageUrl: string
  image: HTMLImageElement
  imageFile: File
  controlPoints: ControlPoint[]
  transform: AffineTransform
  inverse: AffineTransform
  crs: string
  imageWidth: number
  imageHeight: number
  segments: GeometrySegment[]
  warning: string | null
}

type Viewport = {
  scale: number
  offsetX: number
  offsetY: number
}

const DEFAULT_VIEWPORT: Viewport = { scale: 1, offsetX: 0, offsetY: 0 }

export function PackageViewer() {
  const [data, setData] = useState<PackageData | null>(null)
  const [status, setStatus] = useState('选择一个后端导出的 *-geoalign.zip。')
  const [cursor, setCursor] = useState<{ pixel: Point; world: Point } | null>(null)
  const [recording, setRecording] = useState(false)
  const [routePixels, setRoutePixels] = useState<Point[]>([])
  const [showSatellite, setShowSatellite] = useState(false)
  const [satelliteOffset, setSatelliteOffset] = useState({ east: 0, north: 0 })
  const [isExporting, setIsExporting] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<Viewport>({ ...DEFAULT_VIEWPORT })
  const imageToScreenRef = useRef<AffineTransform | null>(null)
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

  const bounds = useMemo(() => (data?.segments.length ? getBounds(data.segments) : null), [data?.segments])

  useEffect(() => {
    return () => {
      if (data?.imageUrl) URL.revokeObjectURL(data.imageUrl)
    }
  }, [data?.imageUrl])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || !data) return
    const view = sizeCanvas(canvas)
    context.clearRect(0, 0, view.width, view.height)
    context.fillStyle = '#f5f7fb'
    context.fillRect(0, 0, view.width, view.height)

    const imageToScreen = composeViewport(
      fitToViewport({ minX: 0, minY: 0, maxX: data.imageWidth, maxY: data.imageHeight }, view.width, view.height, 28),
      viewportRef.current,
    )
    imageToScreenRef.current = imageToScreen
    const topLeft = applyAffine(imageToScreen, { x: 0, y: 0 })
    const bottomRight = applyAffine(imageToScreen, { x: data.imageWidth, y: data.imageHeight })
    context.drawImage(data.image, topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)

    if (data.segments.length) {
      const worldToImage = invertAffine(data.transform)
      drawSegments(context, data.segments, (point) => applyAffine(imageToScreen, applyAffine(worldToImage, point)))
    }

    if (routePixels.length) {
      drawRoute(context, routePixels, (point) => applyAffine(imageToScreen, point))
    }
  }, [data, routePixels])

  useEffect(() => {
    draw()
  }, [draw])

  const onPackageFile = async (file?: File) => {
    if (!file) return
    try {
      setStatus('正在读取 zip...')
      const zip = await JSZip.loadAsync(file)
      const jsonEntry = findEntry(zip, (name) => name.endsWith('.geoalign.json'))
      if (!jsonEntry) throw new Error('zip 内没有 .geoalign.json。')
      const metadata = JSON.parse(await jsonEntry.async('string')) as {
        image: string
        crs?: string
        imageWidth?: number
        imageHeight?: number
        transform: AffineTransform
        controlPoints?: ControlPoint[]
        segmentsFile?: string
        segments?: GeometrySegment[]
      }
      const imageEntry = zip.file(metadata.image) ?? findEntry(zip, (name) => /\.(jpe?g|png)$/i.test(name))
      if (!imageEntry) throw new Error('zip 内没有图片文件。')

      const imageBlob = await imageEntry.async('blob')
      const imageUrl = URL.createObjectURL(imageBlob)
      const image = await loadImage(imageUrl)
      const segmentsEntry = metadata.segmentsFile ? zip.file(metadata.segmentsFile) : findEntry(zip, (name) => name.endsWith('.segments.geojson'))
      const inlineSegments = Array.isArray(metadata.segments) ? metadata.segments : []
      const segments = segmentsEntry
        ? transformGeoJson(JSON.parse(await segmentsEntry.async('string')), 'raw')
        : inlineSegments
      const imageWidth = metadata.imageWidth ?? image.naturalWidth
      const imageHeight = metadata.imageHeight ?? image.naturalHeight
      const warning = getVectorWarning(segments, metadata.transform, imageWidth, imageHeight, Boolean(segmentsEntry), inlineSegments.length)

      viewportRef.current = { ...DEFAULT_VIEWPORT }
      setCursor(null)
      setRecording(false)
      setRoutePixels([])
      setData({
        imageName: imageEntry.name,
        imageUrl,
        image,
        imageFile: new File([imageBlob], imageEntry.name, { type: imageBlob.type || 'image/png' }),
        controlPoints: metadata.controlPoints ?? [],
        transform: metadata.transform,
        inverse: invertAffine(metadata.transform),
        crs: metadata.crs ?? 'unknown',
        imageWidth,
        imageHeight,
        segments,
        warning,
      })
      setStatus(warning ? `已加载 ${file.name}，但需要处理：${warning}` : `已加载 ${file.name}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出包读取失败。')
    }
  }

  const zoom = (factor: number, anchor?: Point) => {
    const canvas = canvasRef.current
    const fallbackAnchor = canvas
      ? { x: canvas.getBoundingClientRect().width / 2, y: canvas.getBoundingClientRect().height / 2 }
      : { x: 0, y: 0 }
    const zoomAnchor = anchor ?? fallbackAnchor
    const viewport = viewportRef.current
    const scale = clamp(viewport.scale * factor, 0.1, 80)
    const ratio = scale / viewport.scale
    viewportRef.current = {
      scale,
      offsetX: zoomAnchor.x - (zoomAnchor.x - viewport.offsetX) * ratio,
      offsetY: zoomAnchor.y - (zoomAnchor.y - viewport.offsetY) * ratio,
    }
    draw()
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08, { x: event.clientX - rect.left, y: event.clientY - rect.top })
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current
    if (pan && pan.pointerId === event.pointerId) {
      viewportRef.current = {
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + event.clientX - pan.lastX,
        offsetY: viewportRef.current.offsetY + event.clientY - pan.lastY,
      }
      pan.lastX = event.clientX
      pan.lastY = event.clientY
      draw()
      return
    }
    if (!data || !imageToScreenRef.current) return
    const pixel = screenToLocal(event, canvasRef.current, imageToScreenRef.current)
    if (!pixel) return
    setCursor({ pixel, world: applyAffine(data.transform, pixel) })
  }

  const onRouteClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!recording || !data || !imageToScreenRef.current) return
    const pixel = screenToLocal(event, canvasRef.current, imageToScreenRef.current)
    if (!pixel) return
    if (pixel.x < 0 || pixel.y < 0 || pixel.x > data.imageWidth || pixel.y > data.imageHeight) return
    setRoutePixels((current) => [...current, pixel])
  }

  const exportRoute = () => {
    if (!data || routePixels.length === 0) return
    const coordinates: LatLng[] = routePixels.map((pixel) => {
      const world = applyAffine(data.transform, pixel)
      return worldToLatLng(world, data.crs)
    })
    downloadJson(coordinates, 'route.json')
  }

  const exportCorrectedPackage = async () => {
    if (!data || isExporting) return
    setIsExporting(true)
    try {
      const dx = satelliteOffset.east
      const dy = satelliteOffset.north
      const transform = { ...data.transform, c: data.transform.c + dx, f: data.transform.f + dy }
      const points = data.controlPoints.map((point) => point.world ? { ...point, world: { x: point.world.x + dx, y: point.world.y + dy } } : point)
      const segments = data.segments.map((segment) => ({
        ...segment,
        rings: segment.rings.map((ring) => ring.map((point) => ({ x: point.x + dx, y: point.y + dy }))),
      }))
      setStatus('正在导出修正包...')
      await exportAlignmentPackage({
        imageFile: data.imageFile,
        imageWidth: data.imageWidth,
        imageHeight: data.imageHeight,
        controlPoints: points,
        segments,
        transform,
        crs: data.crs,
      })
      setStatus(`已导出修正包：ΔE ${dx.toFixed(1)} m / ΔN ${dy.toFixed(1)} m`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出失败，请确认 Python 服务已启动。')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section className="viewer-layout">
      <aside className="viewer-sidebar">
        <label className="file-input">
          <span>GeoAlign Zip</span>
          <input type="file" accept=".zip,application/zip" onChange={(event) => onPackageFile(event.target.files?.[0])} />
          <strong>选择导出包</strong>
        </label>
        <div className="viewer-card">
          <h2>包信息</h2>
          <div className="metric-row"><span>状态</span><strong>{status}</strong></div>
          {data?.warning ? <div className="viewer-alert">{data.warning}</div> : null}
          <div className="metric-row"><span>图片</span><strong>{data?.imageName ?? '-'}</strong></div>
          <div className="metric-row"><span>尺寸</span><strong>{data ? `${data.imageWidth} x ${data.imageHeight}` : '-'}</strong></div>
          <div className="metric-row"><span>CRS</span><strong>{data?.crs ?? '-'}</strong></div>
          <div className="metric-row"><span>矢量</span><strong>{data ? `${data.segments.length} 个对象` : '-'}</strong></div>
          <div className="metric-row"><span>范围</span><strong>{bounds ? `${formatNumber(bounds.maxX - bounds.minX, 2)} x ${formatNumber(bounds.maxY - bounds.minY, 2)}` : '-'}</strong></div>
        </div>
        <div className="viewer-card">
          <h2>卫星比对 / 平移</h2>
          <div className="metric-row"><span>平移</span><strong>ΔE {satelliteOffset.east.toFixed(1)} / ΔN {satelliteOffset.north.toFixed(1)} m</strong></div>
          <div className="viewer-route-tools">
            <button type="button" disabled={!data} onClick={() => setShowSatellite(true)}>卫星比对</button>
            <button type="button" disabled={!data || isExporting} onClick={exportCorrectedPackage}>
              {isExporting ? '导出中...' : '导出修正包'}
            </button>
            <button type="button" className="ghost" disabled={!data || (!satelliteOffset.east && !satelliteOffset.north)} onClick={() => setSatelliteOffset({ east: 0, north: 0 })}>
              平移清零
            </button>
          </div>
          <p className="viewer-route-hint">在卫星图上拖动 CAD 对齐后，回到这里点「导出修正包」。</p>
        </div>

        <div className="viewer-card">
          <h2>鼠标位置</h2>
          <div className="metric-row"><span>像素</span><strong>{cursor ? `${formatNumber(cursor.pixel.x, 1)}, ${formatNumber(cursor.pixel.y, 1)}` : '-'}</strong></div>
          <div className="metric-row"><span>地图</span><strong>{cursor ? `${formatNumber(cursor.world.x, 4)}, ${formatNumber(cursor.world.y, 4)}` : '-'}</strong></div>
        </div>
        <div className="viewer-card">
          <h2>路线录制</h2>
          <div className="viewer-route-tools">
            <button
              type="button"
              className={recording ? 'selected' : ''}
              disabled={!data}
              onClick={() => setRecording((current) => !current)}
            >
              {recording ? '停止录制' : '录制路线'}
            </button>
            <button type="button" disabled={routePixels.length === 0} onClick={exportRoute}>
              导出路线
            </button>
            <button type="button" className="ghost" disabled={routePixels.length === 0} onClick={() => setRoutePixels([])}>
              清除路线
            </button>
          </div>
          <div className="metric-row"><span>点数</span><strong>{routePixels.length}</strong></div>
          <p className="viewer-route-hint">
            {recording
              ? '在 canvas 上连续点击添加路线点，Shift+拖动仍可平移。'
              : '点击「录制路线」后，在图片上点击即可按顺序连线。'}
          </p>
        </div>
      </aside>
      <div className="canvas-panel viewer-panel">
        <div className="panel-title">
          <div>
            <h2>导出包预览</h2>
            <span>
              滚轮缩放，Shift+拖动平移；红色线为导出包内的 GeoJSON 线稿
              {recording ? '；蓝色线为正在录制的路线' : ''}
            </span>
          </div>
          <div className="view-tools">
            <button type="button" onClick={() => zoom(1.25)}>+</button>
            <button type="button" onClick={() => zoom(0.8)}>-</button>
            <button type="button" onClick={() => { viewportRef.current = { ...DEFAULT_VIEWPORT }; draw() }}>重置</button>
          </div>
        </div>
        <div className="canvas-viewport">
          {data?.warning ? <div className="canvas-alert">{data.warning}</div> : null}
          <canvas
            ref={canvasRef}
            onWheel={onWheel}
            onPointerDown={(event) => {
              if (!event.shiftKey && event.button === 0) {
                if (recording) onRouteClick(event)
                return
              }
              if (!event.shiftKey && event.button !== 1) return
              event.currentTarget.setPointerCapture(event.pointerId)
              panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
            }}
            onPointerMove={onPointerMove}
            onPointerUp={() => { panRef.current = null }}
            onPointerCancel={() => { panRef.current = null }}
          />
        </div>
      </div>
      {showSatellite && data && (
        <SatelliteCompare
          image={data.image}
          imageWidth={data.imageWidth}
          imageHeight={data.imageHeight}
          imageName={data.imageName}
          transform={data.transform}
          focusBounds={bounds}
          initialOffset={satelliteOffset}
          onApply={(offset) => {
            setSatelliteOffset(offset)
            setStatus(`卫星平移已记录：ΔE ${offset.east.toFixed(1)} m / ΔN ${offset.north.toFixed(1)} m，点「导出修正包」写入 zip。`)
          }}
          onClose={() => setShowSatellite(false)}
        />
      )}
    </section>
  )
}

function findEntry(zip: JSZip, predicate: (name: string) => boolean) {
  return Object.values(zip.files).find((entry) => !entry.dir && predicate(entry.name)) ?? null
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败。'))
    image.src = url
  })
}

function sizeCanvas(canvas: HTMLCanvasElement) {
  const rect = (canvas.parentElement ?? canvas).getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(Math.floor(rect.width), 300)
  const height = Math.max(Math.floor(rect.height), 260)
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { width, height }
}

function composeViewport(base: AffineTransform, viewport: Viewport): AffineTransform {
  return {
    a: viewport.scale * base.a,
    b: viewport.scale * base.b,
    c: viewport.scale * base.c + viewport.offsetX,
    d: viewport.scale * base.d,
    e: viewport.scale * base.e,
    f: viewport.scale * base.f + viewport.offsetY,
  }
}

function screenToLocal(event: React.PointerEvent, canvas: HTMLCanvasElement | null, transform: AffineTransform): Point | null {
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  const determinant = transform.a * transform.e - transform.b * transform.d
  if (Math.abs(determinant) < 1e-12) return null
  return {
    x: (transform.e * (screenPoint.x - transform.c) - transform.b * (screenPoint.y - transform.f)) / determinant,
    y: (-transform.d * (screenPoint.x - transform.c) + transform.a * (screenPoint.y - transform.f)) / determinant,
  }
}

function drawRoute(context: CanvasRenderingContext2D, pixels: Point[], project: (point: Point) => Point) {
  if (!pixels.length) return
  context.lineWidth = 2.5
  context.strokeStyle = '#2563eb'
  context.fillStyle = '#2563eb'
  context.beginPath()
  pixels.forEach((pixel, index) => {
    const point = project(pixel)
    if (index === 0) context.moveTo(point.x, point.y)
    else context.lineTo(point.x, point.y)
  })
  context.stroke()
  for (const pixel of pixels) {
    const point = project(pixel)
    context.beginPath()
    context.arc(point.x, point.y, 4, 0, Math.PI * 2)
    context.fill()
  }
}

function worldToLatLng(point: Point, crs: string): LatLng {
  if (crs === 'EPSG:3857') {
    const [lng, lat] = proj4(EPSG3857, 'EPSG:4326', [point.x, point.y])
    return { lng, lat }
  }
  return { lng: point.x, lat: point.y }
}

function downloadJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function drawSegments(context: CanvasRenderingContext2D, segments: GeometrySegment[], project: (point: Point) => Point) {
  context.lineWidth = 1.5
  context.strokeStyle = '#ef4444'
  context.fillStyle = 'rgba(239, 68, 68, 0.14)'
  for (const segment of segments) {
    for (const ring of segment.rings) {
      if (!ring.length) continue
      context.beginPath()
      ring.forEach((source, index) => {
        const point = project(source)
        if (index === 0) context.moveTo(point.x, point.y)
        else context.lineTo(point.x, point.y)
      })
      if (segment.type === 'Polygon') {
        context.closePath()
        context.fill()
      }
      context.stroke()
    }
  }
}

function getVectorWarning(
  segments: GeometrySegment[],
  transform: AffineTransform,
  imageWidth: number,
  imageHeight: number,
  hasSegmentsFile: boolean,
  inlineSegmentsCount: number,
) {
  if (!segments.length) {
    if (!hasSegmentsFile && inlineSegmentsCount === 0) {
      return '这个包有 geoalign.json，但没有可绘制的 GeoJSON 线稿：缺少 *.segments.geojson，geoalign.json 里也没有内嵌 segments。请回到配准页重新导出最新 zip。'
    }
    return '线稿数据为空，预览只能显示图片和坐标。请确认导出前已经加载 GeoJSON。'
  }

  const worldToImage = invertAffine(transform)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const segment of segments) {
    for (const ring of segment.rings) {
      for (const point of ring) {
        const pixel = applyAffine(worldToImage, point)
        minX = Math.min(minX, pixel.x)
        minY = Math.min(minY, pixel.y)
        maxX = Math.max(maxX, pixel.x)
        maxY = Math.max(maxY, pixel.y)
      }
    }
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return '线稿坐标解析失败，无法绘制线稿。'
  }

  const padding = Math.max(imageWidth, imageHeight) * 0.05
  const outsideImage =
    maxX < -padding ||
    maxY < -padding ||
    minX > imageWidth + padding ||
    minY > imageHeight + padding

  if (outsideImage) {
    return `线稿存在，但被当前 transform 投到图片范围外：像素范围 ${formatNumber(minX, 1)}, ${formatNumber(minY, 1)} 到 ${formatNumber(maxX, 1)}, ${formatNumber(maxY, 1)}。请检查是否加载了匹配的图片和导出包。`
  }

  return null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
