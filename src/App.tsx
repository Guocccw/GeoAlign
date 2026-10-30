import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  type AffineTransform,
  type Bounds,
  type ControlPoint,
  type GeometrySegment,
  type Point,
  applyAffine,
  evaluateAffine,
  fitAffine,
  fitToViewport,
  formatNumber,
  getBounds,
  transformGeoJson,
} from './geo'
import { exportAlignmentPackage } from './exportApi'
import { PackageViewer } from './PackageViewer'
import { SatelliteCompare } from './SatelliteCompare'
import { refineAlignment } from './refineApi'
import './index.css'

type ProjectionMode = 'raw' | 'epsg3857' | 'custom'

type ImageState = {
  element: HTMLImageElement
  file: File
  name: string
  url: string
  width: number
  height: number
}

type GeoJsonState = {
  name: string
  raw: unknown
  segments: GeometrySegment[]
  bounds: Bounds | null
}

type ViewState = {
  width: number
  height: number
  imageToScreen: AffineTransform | null
  geoToScreen: AffineTransform | null
}

type CanvasKind = 'image' | 'geo'

type CanvasViewport = {
  scale: number
  offsetX: number
  offsetY: number
}

type PanState = {
  kind: CanvasKind
  pointerId: number
  lastX: number
  lastY: number
  moved: boolean
}

type AlignmentMetadata = {
  image?: string
  crs?: string
  imageWidth?: number
  imageHeight?: number
  transform?: AffineTransform
  controlPoints?: ControlPoint[]
  segments?: GeometrySegment[]
  segmentsFile?: string
}

const DEFAULT_VIEW: ViewState = {
  width: 900,
  height: 620,
  imageToScreen: null,
  geoToScreen: null,
}

const DEFAULT_VIEWPORT: CanvasViewport = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
}

const DRAFT_KEY = 'geoalign:draft:v1'

function App() {
  const [mode, setMode] = useState<'align' | 'viewer'>('align')
  const [image, setImage] = useState<ImageState | null>(null)
  const [geoJson, setGeoJson] = useState<GeoJsonState | null>(null)
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('raw')
  const [customProj, setCustomProj] = useState('')
  const [points, setPoints] = useState<ControlPoint[]>([])
  const [activePointId, setActivePointId] = useState<string | null>(null)
  const [showWarpedGeoJson, setShowWarpedGeoJson] = useState(true)
  const [showControlLabels, setShowControlLabels] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [isRefining, setIsRefining] = useState(false)
  const [refinedTransform, setRefinedTransform] = useState<AffineTransform | null>(null)
  const [showSatellite, setShowSatellite] = useState(false)
  const [satelliteOffset, setSatelliteOffset] = useState({ east: 0, north: 0 })
  const [message, setMessage] = useState('导入 JPG 和 GeoJSON 后，至少添加 3 对同名控制点。')
  const imageCanvas = useRef<HTMLCanvasElement | null>(null)
  const geoCanvas = useRef<HTMLCanvasElement | null>(null)
  const imageView = useRef<ViewState>(DEFAULT_VIEW)
  const geoView = useRef<ViewState>(DEFAULT_VIEW)
  const imageViewportRef = useRef<CanvasViewport>({ ...DEFAULT_VIEWPORT })
  const geoViewportRef = useRef<CanvasViewport>({ ...DEFAULT_VIEWPORT })
  const projectionKeyRef = useRef('')
  const panRef = useRef<PanState | null>(null)
  const wheelHandlerRef = useRef<(kind: CanvasKind, event: WheelEvent) => void>(() => {})

  const manualFit = useMemo(() => fitAffine(points), [points])
  const fit = useMemo(() => (refinedTransform ? evaluateAffine(points, refinedTransform) : manualFit), [manualFit, points, refinedTransform])
  const exportTransform = useMemo(() => {
    if (!fit) return null
    return {
      ...fit.transform,
      c: fit.transform.c + satelliteOffset.east,
      f: fit.transform.f + satelliteOffset.north,
    }
  }, [fit, satelliteOffset])
  const completePoints = points.filter((point) => point.image && point.world)
  const activePoint = points.find((point) => point.id === activePointId)
  const exportEpsg = projectionMode === 'epsg3857' ? '3857' : projectionMode === 'raw' ? '4326' : 'raw'
  const geoJsonRaw = geoJson?.raw
  const projectionKey = `${projectionMode}:${customProj}`

  useEffect(() => {
    return () => {
      if (image?.url) URL.revokeObjectURL(image.url)
    }
  }, [image?.url])

  useEffect(() => {
    const draft = loadDraft()
    if (!draft) return
    setPoints(draft.points)
    setProjectionMode(draft.projectionMode)
    setCustomProj(draft.customProj)
    setMessage('已恢复上次控制点草稿。若重新选择同一 JPG/GeoJSON，可继续导出。')
  }, [])

  useEffect(() => {
    saveDraft({
      points,
      projectionMode,
      customProj,
      imageName: image?.name ?? '',
      geoJsonName: geoJson?.name ?? '',
      savedAt: Date.now(),
    })
  }, [points, projectionMode, customProj, image?.name, geoJson?.name])

  useEffect(() => {
    if (!geoJsonRaw) {
      projectionKeyRef.current = projectionKey
      return
    }
    if (projectionKeyRef.current === projectionKey) return
    projectionKeyRef.current = projectionKey
    try {
      const segments = transformGeoJson(geoJsonRaw, projectionMode, customProj)
      setGeoJson((current) => current && { ...current, segments, bounds: getBounds(segments) })
      setPoints((current) => current.map((point) => ({ ...point, world: undefined })))
      setRefinedTransform(null)
      setActivePointId(null)
      setMessage('坐标投影已切换，GeoJSON 目标点已清空，请重新点选。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '投影转换失败。')
    }
  }, [projectionKey, projectionMode, customProj, geoJsonRaw])

  const onImageFile = async (file?: File) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const element = new Image()
    element.decoding = 'async'
    element.onload = () => {
      setImage({
        element,
        file,
        name: file.name,
        url,
        width: element.naturalWidth,
        height: element.naturalHeight,
      })
      resetViewportRef('image')
      drawImageCanvas()
      setMessage(`已载入 JPG：${file.name}，尺寸 ${element.naturalWidth} x ${element.naturalHeight}`)
    }
    element.onerror = () => setMessage('图片读取失败，请确认文件是 JPG/PNG。')
    element.src = url
  }

  const onGeoJsonFile = async (file?: File) => {
    if (!file) return
    try {
      const raw = JSON.parse(await file.text())
      const segments = transformGeoJson(raw, projectionMode, customProj)
      projectionKeyRef.current = projectionKey
      setGeoJson({ name: file.name, raw, segments, bounds: getBounds(segments) })
      resetViewportRef('geo')
      drawGeoCanvas()
      setMessage(`已载入 GeoJSON：${file.name}，解析 ${segments.length} 个几何对象。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'GeoJSON 解析失败。')
    }
  }

  const onAlignmentPackageFile = async (file?: File) => {
    if (!file) return
    try {
      if (file.name.toLowerCase().endsWith('.zip')) {
        await loadAlignmentZip(file)
      } else {
        const metadata = JSON.parse(await file.text()) as AlignmentMetadata
        applyAlignmentMetadata(metadata, file.name)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配准文件加载失败。')
    }
  }

  const loadAlignmentZip = async (file: File) => {
    const zip = await JSZip.loadAsync(file)
    const metadataEntry = findZipEntry(zip, (name) => name.endsWith('.geoalign.json'))
    if (!metadataEntry) throw new Error('zip 里没有 .geoalign.json 配准元数据。')

    const metadata = JSON.parse(await metadataEntry.async('string')) as AlignmentMetadata
    const imageEntry = metadata.image
      ? zip.file(metadata.image)
      : findZipEntry(zip, (name) => /\.(jpe?g|png)$/i.test(name))
    const segmentsEntry = metadata.segmentsFile
      ? zip.file(metadata.segmentsFile)
      : findZipEntry(zip, (name) => name.endsWith('.segments.geojson'))

    if (imageEntry) {
      const imageBlob = await imageEntry.async('blob')
      await loadImageFromFile(new File([imageBlob], basename(imageEntry.name), { type: imageBlob.type || guessImageMime(imageEntry.name) }))
    }

    if (segmentsEntry) {
      const raw = JSON.parse(await segmentsEntry.async('string'))
      const segments = transformGeoJson(raw, 'raw')
      projectionKeyRef.current = projectionKey
      setGeoJson({ name: basename(segmentsEntry.name), raw, segments, bounds: getBounds(segments) })
      resetViewportRef('geo')
    } else if (metadata.segments?.length) {
      const raw = buildGeoJsonFromSegments(metadata.segments)
      projectionKeyRef.current = projectionKey
      setGeoJson({ name: 'geoalign.json 内嵌线稿', raw, segments: metadata.segments, bounds: getBounds(metadata.segments) })
      resetViewportRef('geo')
    }

    applyAlignmentMetadata(metadata, file.name)
    const missing = [
      imageEntry ? '' : '图片',
      segmentsEntry || metadata.segments?.length ? '' : '线稿',
    ].filter(Boolean)
    setMessage(missing.length
      ? `已加载配准包 ${file.name}，但包内缺少 ${missing.join('、')}；已尽量恢复控制点和 transform。`
      : `已加载配准包 ${file.name}：图片、线稿、控制点和 transform 已恢复。`)
  }

  const loadImageFromFile = (file: File) => {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const element = new Image()
      element.decoding = 'async'
      element.onload = () => {
        setImage({
          element,
          file,
          name: file.name,
          url,
          width: element.naturalWidth,
          height: element.naturalHeight,
        })
        resetViewportRef('image')
        resolve()
      }
      element.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('配准包里的图片读取失败。'))
      }
      element.src = url
    })
  }

  const applyAlignmentMetadata = (metadata: AlignmentMetadata, sourceName: string) => {
    const nextPoints = normalizeControlPoints(metadata.controlPoints ?? [])
    if (nextPoints.length) {
      setPoints(nextPoints)
      setActivePointId(nextPoints[0]?.id ?? null)
    }
    setRefinedTransform(metadata.transform ?? null)
    if (metadata.segments?.length) {
      const raw = buildGeoJsonFromSegments(metadata.segments)
      projectionKeyRef.current = projectionKey
      setGeoJson({ name: `${sourceName} 内嵌线稿`, raw, segments: metadata.segments, bounds: getBounds(metadata.segments) })
      resetViewportRef('geo')
    }
    if (!nextPoints.length && !metadata.transform) {
      throw new Error(`${sourceName} 里没有 controlPoints 或 transform，不能恢复配准。`)
    }
    setMessage(`已加载 ${sourceName} 的配准信息：${nextPoints.length} 个控制点${metadata.transform ? '，transform 已恢复' : ''}。`)
  }

  const addPoint = () => {
    const id = String(points.length + 1)
    setPoints((current) => [...current, { id }])
    setActivePointId(id)
  }

  const removePoint = (id: string) => {
    setPoints((current) => current.filter((point) => point.id !== id).map((point, index) => ({ ...point, id: String(index + 1) })))
    setActivePointId(null)
  }

  const clearPoints = () => {
    setPoints([])
    setRefinedTransform(null)
    setActivePointId(null)
    window.localStorage.removeItem(DRAFT_KEY)
  }

  const setControlPoint = (side: 'image' | 'world', point: Point) => {
    let nextId = activePointId
    setRefinedTransform(null)
    setPoints((current) => {
      let next = [...current]
      if (!nextId || !next.some((item) => item.id === nextId)) {
        const pending = next.find((item) => !item[side])
        if (pending) {
          nextId = pending.id
        } else {
          nextId = String(next.length + 1)
          next.push({ id: nextId })
        }
      }
      next = next.map((item) => (item.id === nextId ? { ...item, [side]: point } : item))
      return next
    })
    setActivePointId(nextId)
  }

  const onImageCanvasClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.moved) return
    if (!image || !imageView.current.imageToScreen) return
    const point = screenToLocal(event, imageCanvas.current, imageView.current.imageToScreen)
    if (!point) return
    if (point.x < 0 || point.y < 0 || point.x > image.width || point.y > image.height) return
    setControlPoint('image', point)
  }

  const onGeoCanvasClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.moved) return
    if (!geoJson?.bounds || !geoView.current.geoToScreen) return
    const point = screenToLocal(event, geoCanvas.current, geoView.current.geoToScreen)
    if (!point) return
    setControlPoint('world', point)
  }

  const onExport = async () => {
    if (!image || !fit || !exportTransform) {
      setMessage('至少需要 3 对有效控制点才能导出配准包。')
      return
    }
    if (isExporting) return
    setIsExporting(true)
    try {
      setMessage('正在调用后端导出配准包...')
      const dx = satelliteOffset.east
      const dy = satelliteOffset.north
      const exportPoints = (dx || dy)
        ? completePoints.map((point) => point.world ? { ...point, world: { x: point.world.x + dx, y: point.world.y + dy } } : point)
        : completePoints
      const exportSegments = (dx || dy)
        ? (geoJson?.segments ?? []).map((segment) => ({
            ...segment,
            rings: segment.rings.map((ring) => ring.map((point) => ({ x: point.x + dx, y: point.y + dy }))),
          }))
        : (geoJson?.segments ?? [])
      await exportAlignmentPackage({
        imageFile: image.file,
        imageWidth: image.width,
        imageHeight: image.height,
        controlPoints: exportPoints,
        segments: exportSegments,
        transform: exportTransform,
        crs: exportEpsg === 'raw' ? 'unknown' : `EPSG:${exportEpsg}`,
      })
      setMessage('后端配准包已生成：包含原图、geoalign.json、world file 和蓝色线稿数据。请加载最新下载的 zip。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后端导出失败，请确认 Python 服务已启动。')
    } finally {
      setIsExporting(false)
    }
  }

  const onAutoRefine = async () => {
    if (!image || !geoJson || !fit) {
      setMessage('需要先导入 JPG、GeoJSON，并完成至少 3 对控制点。')
      return
    }
    if (completePoints.length < 3) {
      setMessage('自动精修需要至少 3 对粗略控制点作为初始值。')
      return
    }
    if (isRefining) return

    setIsRefining(true)
    setMessage('正在调用本地 OpenCV 服务自动精修...')
    try {
      const result = await refineAlignment({
        imageFile: image.file,
        imageWidth: image.width,
        imageHeight: image.height,
        segments: geoJson.segments,
        controlPoints: completePoints,
        transform: fit.transform,
      })
      setRefinedTransform(result.transform)
      setMessage(`${result.message}，ECC=${formatNumber(result.correlation, 5)}，采样比例=${formatNumber(result.scale, 3)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '自动精修失败，请确认 Python 服务已启动。')
    } finally {
      setIsRefining(false)
    }
  }

  const onCanvasWheel = (kind: CanvasKind, event: WheelEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const canvas = kind === 'image' ? imageCanvas.current : geoCanvas.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
    zoomViewport(kind, factor, anchor)
  }
  wheelHandlerRef.current = onCanvasWheel

  const onCanvasPointerDown = (kind: CanvasKind, event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!event.shiftKey && event.button !== 1) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      kind,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
  }

  const onCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    const dx = event.clientX - pan.lastX
    const dy = event.clientY - pan.lastY
    if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
      pan.moved = true
    }
    pan.lastX = event.clientX
    pan.lastY = event.clientY
    updateViewportRef(pan.kind, (viewport) => ({
      ...viewport,
      offsetX: viewport.offsetX + dx,
      offsetY: viewport.offsetY + dy,
    }))
    drawCanvas(pan.kind)
  }

  const onCanvasPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
  }

  const zoomViewport = (kind: CanvasKind, factor: number, anchor?: Point) => {
    const canvas = kind === 'image' ? imageCanvas.current : geoCanvas.current
    const fallbackAnchor = canvas
      ? { x: canvas.getBoundingClientRect().width / 2, y: canvas.getBoundingClientRect().height / 2 }
      : { x: 0, y: 0 }
    const zoomAnchor = anchor ?? fallbackAnchor
    updateViewportRef(kind, (viewport) => {
      const scale = clamp(viewport.scale * factor, 0.1, 80)
      const ratio = scale / viewport.scale
      return {
        scale,
        offsetX: zoomAnchor.x - (zoomAnchor.x - viewport.offsetX) * ratio,
        offsetY: zoomAnchor.y - (zoomAnchor.y - viewport.offsetY) * ratio,
      }
    })
    drawCanvas(kind)
  }

  const updateViewportRef = (kind: CanvasKind, updater: (viewport: CanvasViewport) => CanvasViewport) => {
    const ref = kind === 'image' ? imageViewportRef : geoViewportRef
    ref.current = updater(ref.current)
  }

  const resetViewportRef = (kind: CanvasKind) => {
    const ref = kind === 'image' ? imageViewportRef : geoViewportRef
    ref.current = { ...DEFAULT_VIEWPORT }
  }

  const resetViewport = (kind: CanvasKind) => {
    resetViewportRef(kind)
    drawCanvas(kind)
  }

  const drawCanvas = (kind: CanvasKind) => {
    if (kind === 'image') {
      drawImageCanvas()
    } else {
      drawGeoCanvas()
    }
  }

  const drawImageCanvas = useCallback(() => {
    const canvas = imageCanvas.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const view = sizeCanvas(canvas)
    context.clearRect(0, 0, view.width, view.height)
    context.fillStyle = '#f5f7fb'
    context.fillRect(0, 0, view.width, view.height)

    if (!image) {
      drawEmpty(context, view.width, view.height, '导入 JPG 平面图')
      imageView.current = { ...view, imageToScreen: null, geoToScreen: null }
      return
    }

    const imageBounds = { minX: 0, minY: 0, maxX: image.width, maxY: image.height }
    const imageToScreen = composeViewport(fitToViewport(imageBounds, view.width, view.height, 28), imageViewportRef.current)
    imageView.current = { ...view, imageToScreen, geoToScreen: null }
    const topLeft = applyAffine(imageToScreen, { x: 0, y: 0 })
    const bottomRight = applyAffine(imageToScreen, { x: image.width, y: image.height })
    context.drawImage(image.element, topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)

    if (showWarpedGeoJson && geoJson && fit) {
      drawSegments(context, geoJson.segments, (point) => applyAffine(imageToScreen, applyAffine(fit.inverse, point)), {
        line: '#ef4444',
        fill: 'rgba(239, 68, 68, 0.14)',
        point: '#dc2626',
      })
    }

    drawControlPoints(context, points, imageToScreen, 'image', activePointId, showControlLabels)
  }, [image, geoJson, fit, points, activePointId, showWarpedGeoJson, showControlLabels])

  const drawGeoCanvas = useCallback(() => {
    const canvas = geoCanvas.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const view = sizeCanvas(canvas)
    context.clearRect(0, 0, view.width, view.height)
    context.fillStyle = '#f5f7fb'
    context.fillRect(0, 0, view.width, view.height)

    if (!geoJson?.bounds) {
      drawEmpty(context, view.width, view.height, '导入 GeoJSON')
      geoView.current = { ...view, imageToScreen: null, geoToScreen: null }
      return
    }

    const geoToScreen = composeViewport(fitToViewport(geoJson.bounds, view.width, view.height, 28), geoViewportRef.current)
    geoView.current = { ...view, imageToScreen: null, geoToScreen }
    drawSegments(context, geoJson.segments, (point) => applyAffine(geoToScreen, point), {
      line: '#2563eb',
      fill: 'rgba(37, 99, 235, 0.12)',
      point: '#1d4ed8',
    })
    drawControlPoints(context, points, geoToScreen, 'world', activePointId, showControlLabels)
  }, [geoJson, points, activePointId, showControlLabels])

  useEffect(() => {
    drawImageCanvas()
  }, [drawImageCanvas])

  useEffect(() => {
    drawGeoCanvas()
  }, [drawGeoCanvas])

  useEffect(() => {
    const imageElement = imageCanvas.current
    const geoElement = geoCanvas.current
    const imageWheel = (event: WheelEvent) => wheelHandlerRef.current('image', event)
    const geoWheel = (event: WheelEvent) => wheelHandlerRef.current('geo', event)
    imageElement?.addEventListener('wheel', imageWheel, { passive: false })
    geoElement?.addEventListener('wheel', geoWheel, { passive: false })
    return () => {
      imageElement?.removeEventListener('wheel', imageWheel)
      geoElement?.removeEventListener('wheel', geoWheel)
    }
  }, [])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoAlign</p>
          <h1>{mode === 'align' ? 'JPG 平面图与 GeoJSON 配准工具' : '导出包加载与 Canvas 预览'}</h1>
        </div>
        <div className="top-actions">
          <div className="mode-switch">
            <button type="button" className={mode === 'align' ? 'selected' : ''} onClick={() => setMode('align')}>配准</button>
            <button type="button" className={mode === 'viewer' ? 'selected' : ''} onClick={() => setMode('viewer')}>加载导出包</button>
          </div>
          {mode === 'align' && (
            <>
              <label className="import-button">
                <input type="file" accept=".zip,.json,application/zip,application/json" onChange={(event) => onAlignmentPackageFile(event.target.files?.[0])} />
                <span>加载配准 JSON/ZIP</span>
              </label>
              <button type="button" onClick={addPoint}>添加控制点</button>
              <button type="button" onClick={onAutoRefine} disabled={!fit || !image || !geoJson || isRefining}>
                {isRefining ? '精修中...' : '自动精修'}
              </button>
              <button type="button" onClick={() => setShowSatellite(true)} disabled={!fit || !image}>
                卫星比对 / 平移
              </button>
              <button type="button" className="primary" onClick={onExport} disabled={!fit || !image || isExporting}>
                {isExporting ? '导出中...' : '后端导出配准包'}
              </button>
            </>
          )}
        </div>
      </header>

      {mode === 'viewer' ? <PackageViewer /> : (
        <>

      <section className="control-strip">
        <label className="file-input">
          <span>JPG / PNG</span>
          <input type="file" accept="image/jpeg,image/png" onChange={(event) => onImageFile(event.target.files?.[0])} />
          <strong>{image?.name ?? '选择平面图'}</strong>
        </label>
        <label className="file-input">
          <span>GeoJSON</span>
          <input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={(event) => onGeoJsonFile(event.target.files?.[0])} />
          <strong>{geoJson?.name ?? '选择矢量文件'}</strong>
        </label>
        <label>
          <span>坐标处理</span>
          <select value={projectionMode} onChange={(event) => setProjectionMode(event.target.value as ProjectionMode)}>
            <option value="raw">保持 GeoJSON 原坐标 / EPSG:4326</option>
            <option value="epsg3857">经纬度转 EPSG:3857 米制</option>
            <option value="custom">自定义 Proj4</option>
          </select>
        </label>
        <label className="custom-proj">
          <span>Proj4</span>
          <input
            disabled={projectionMode !== 'custom'}
            value={customProj}
            onChange={(event) => setCustomProj(event.target.value)}
            placeholder="+proj=tmerc ..."
          />
        </label>
      </section>

      <section className="workspace">
        <div className="canvas-panel">
          <div className="panel-title">
            <div>
              <h2>平面图</h2>
              <span>滚轮缩放，Shift+拖动平移，点击设置当前控制点</span>
            </div>
            <div className="view-tools">
              <button type="button" onClick={() => zoomViewport('image', 1.25)}>+</button>
              <button type="button" onClick={() => zoomViewport('image', 0.8)}>-</button>
              <button type="button" onClick={() => resetViewport('image')}>重置</button>
            </div>
          </div>
          <div className="canvas-viewport">
            <canvas
              ref={imageCanvas}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                onCanvasPointerDown('image', event)
                if (!event.shiftKey && event.button === 0) onImageCanvasClick(event)
              }}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            />
          </div>
        </div>
        <div className="canvas-panel">
          <div className="panel-title">
            <div>
              <h2>GeoJSON</h2>
              <span>滚轮缩放，Shift+拖动平移，点击设置当前控制点</span>
            </div>
            <div className="view-tools">
              <button type="button" onClick={() => zoomViewport('geo', 1.25)}>+</button>
              <button type="button" onClick={() => zoomViewport('geo', 0.8)}>-</button>
              <button type="button" onClick={() => resetViewport('geo')}>重置</button>
            </div>
          </div>
          <div className="canvas-viewport">
            <canvas
              ref={geoCanvas}
              onContextMenu={(event) => event.preventDefault()}
              onPointerDown={(event) => {
                onCanvasPointerDown('geo', event)
                if (!event.shiftKey && event.button === 0) onGeoCanvasClick(event)
              }}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            />
          </div>
        </div>
      </section>

      <section className="bottom-grid">
        <aside className="metrics">
          <h2>配准质量</h2>
          <div className="metric-row">
            <span>有效控制点</span>
            <strong>{completePoints.length}</strong>
          </div>
          <div className="metric-row">
            <span>RMS 残差</span>
            <strong>{fit ? formatNumber(fit.rms, 4) : '-'}</strong>
          </div>
          <div className="metric-row">
            <span>最大残差</span>
            <strong>{fit ? formatNumber(fit.maxResidual, 4) : '-'}</strong>
          </div>
          <div className="metric-row">
            <span>导出坐标</span>
            <strong>{exportEpsg === 'raw' ? '自定义/未知' : `EPSG:${exportEpsg}`}</strong>
          </div>
          <div className="metric-row">
            <span>配准来源</span>
            <strong>{refinedTransform ? 'OpenCV 精修' : '手工控制点'}</strong>
          </div>
          <div className="metric-row">
            <span>卫星平移</span>
            <strong>ΔE {formatNumber(satelliteOffset.east, 1)} / ΔN {formatNumber(satelliteOffset.north, 1)} m</strong>
          </div>
          {(satelliteOffset.east !== 0 || satelliteOffset.north !== 0) && (
            <button type="button" className="ghost" onClick={() => setSatelliteOffset({ east: 0, north: 0 })}>卫星平移清零</button>
          )}
          <label className="check-row">
            <input type="checkbox" checked={showWarpedGeoJson} onChange={(event) => setShowWarpedGeoJson(event.target.checked)} />
            <span>在平面图上叠加配准后的 GeoJSON</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={showControlLabels} onChange={(event) => setShowControlLabels(event.target.checked)} />
            <span>显示控制点编号</span>
          </label>
          <p className="status">{message}</p>
        </aside>

        <div className="point-table">
          <div className="table-header">
            <h2>控制点</h2>
            <button type="button" className="ghost" onClick={clearPoints}>清空</button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>图片 X/Y</th>
                  <th>地图 X/Y</th>
                  <th>残差</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {points.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-row">添加控制点后，分别在两侧画布点击同名位置。</td>
                  </tr>
                )}
                {points.map((point) => (
                  <tr key={point.id} className={point.id === activePointId ? 'active-row' : ''} onClick={() => setActivePointId(point.id)}>
                    <td>{point.id}</td>
                    <td>{point.image ? `${formatNumber(point.image.x, 1)}, ${formatNumber(point.image.y, 1)}` : '-'}</td>
                    <td>{point.world ? `${formatNumber(point.world.x, 4)}, ${formatNumber(point.world.y, 4)}` : '-'}</td>
                    <td>{formatNumber(fit?.residuals.get(point.id), 4)}</td>
                    <td><button type="button" className="icon-btn" onClick={() => removePoint(point.id)}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {showSatellite && image && fit && (
        <SatelliteCompare
          image={image.element}
          imageWidth={image.width}
          imageHeight={image.height}
          imageName={image.name}
          transform={fit.transform}
          focusBounds={geoJson?.bounds ?? null}
          initialOffset={satelliteOffset}
          onApply={(offset) => {
            setSatelliteOffset(offset)
            setMessage(`卫星平移已写入：ΔE ${formatNumber(offset.east, 1)} m / ΔN ${formatNumber(offset.north, 1)} m`)
          }}
          onClose={() => setShowSatellite(false)}
        />
      )}

      {activePoint && (
        <footer className="hintbar">
          当前控制点 #{activePoint.id}：在左侧点 JPG 位置，在右侧点 GeoJSON 对应位置。用 4 个以上点可以看残差并剔除误差大的点。
        </footer>
      )}
        </>
      )}
    </main>
  )
}

function sizeCanvas(canvas: HTMLCanvasElement) {
  const rect = (canvas.parentElement ?? canvas).getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(Math.floor(rect.width), 300)
  const height = Math.max(Math.floor(rect.height), 260)
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  const context = canvas.getContext('2d')
  context?.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { width, height }
}

function composeViewport(base: AffineTransform, viewport: CanvasViewport): AffineTransform {
  return {
    a: viewport.scale * base.a,
    b: viewport.scale * base.b,
    c: viewport.scale * base.c + viewport.offsetX,
    d: viewport.scale * base.d,
    e: viewport.scale * base.e,
    f: viewport.scale * base.f + viewport.offsetY,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
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

function drawEmpty(context: CanvasRenderingContext2D, width: number, height: number, text: string) {
  context.strokeStyle = '#d6dbe6'
  context.setLineDash([8, 8])
  context.strokeRect(24, 24, width - 48, height - 48)
  context.setLineDash([])
  context.fillStyle = '#687084'
  context.font = '600 15px Inter, system-ui, sans-serif'
  context.textAlign = 'center'
  context.fillText(text, width / 2, height / 2)
}

function drawSegments(
  context: CanvasRenderingContext2D,
  segments: GeometrySegment[],
  project: (point: Point) => Point,
  colors: { line: string; fill: string; point: string },
) {
  context.lineWidth = 1.5
  for (const segment of segments) {
    if (segment.type === 'Point') {
      const point = project(segment.rings[0][0])
      context.fillStyle = colors.point
      context.beginPath()
      context.arc(point.x, point.y, 4, 0, Math.PI * 2)
      context.fill()
      continue
    }

    context.strokeStyle = colors.line
    context.fillStyle = colors.fill
    for (const ring of segment.rings) {
      if (ring.length < 2) continue
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

function drawControlPoints(
  context: CanvasRenderingContext2D,
  points: ControlPoint[],
  transform: AffineTransform,
  side: 'image' | 'world',
  activeId: string | null,
  showLabel: boolean,
) {
  for (const point of points) {
    const source = point[side]
    if (!source) continue
    const screen = applyAffine(transform, source)
    const active = point.id === activeId
    context.fillStyle = active ? '#f59e0b' : '#111827'
    context.strokeStyle = '#ffffff'
    context.lineWidth = 3
    context.beginPath()
    context.arc(screen.x, screen.y, active ? 6 : 5, 0, Math.PI * 2)
    context.stroke()
    context.fill()
    if (showLabel) {
      context.fillStyle = '#111827'
      context.font = '700 12px Inter, system-ui, sans-serif'
      context.fillText(point.id, screen.x + 9, screen.y - 9)
    }
  }
}

function saveDraft(draft: {
  points: ControlPoint[]
  projectionMode: ProjectionMode
  customProj: string
  imageName: string
  geoJsonName: string
  savedAt: number
}) {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // localStorage can be unavailable in private mode.
  }
}

function loadDraft():
  | {
      points: ControlPoint[]
      projectionMode: ProjectionMode
      customProj: string
    }
  | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const draft = JSON.parse(raw) as {
      points?: ControlPoint[]
      projectionMode?: ProjectionMode
      customProj?: string
    }
    if (!Array.isArray(draft.points)) return null
    return {
      points: draft.points,
      projectionMode: draft.projectionMode ?? 'raw',
      customProj: draft.customProj ?? '',
    }
  } catch {
    return null
  }
}

function findZipEntry(zip: JSZip, predicate: (name: string) => boolean) {
  return Object.values(zip.files).find((entry) => !entry.dir && predicate(entry.name)) ?? null
}

function basename(path: string) {
  return path.split('/').pop() || path
}

function guessImageMime(filename: string) {
  return filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
}

function normalizeControlPoints(points: ControlPoint[]) {
  return points
    .filter((point) => point && (point.image || point.world))
    .map((point, index) => ({
      id: String(point.id || index + 1),
      image: point.image,
      world: point.world,
    }))
}

function buildGeoJsonFromSegments(segments: GeometrySegment[]) {
  return {
    type: 'FeatureCollection',
    features: segments.map((segment) => ({
      type: 'Feature',
      properties: { id: segment.id },
      geometry: segmentToGeometry(segment),
    })),
  }
}

function segmentToGeometry(segment: GeometrySegment) {
  if (segment.type === 'Point') {
    const point = segment.rings[0]?.[0] ?? { x: 0, y: 0 }
    return { type: 'Point', coordinates: [point.x, point.y] }
  }
  if (segment.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: segment.rings.map((ring) => ring.map((point) => [point.x, point.y])),
    }
  }
  return {
    type: 'LineString',
    coordinates: (segment.rings[0] ?? []).map((point) => [point.x, point.y]),
  }
}

export default App
