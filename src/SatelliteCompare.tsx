import { useCallback, useEffect, useRef, useState } from 'react'
import type { AffineTransform } from './geo'

type Offset = { east: number; north: number }

type Props = {
  image: HTMLImageElement
  imageWidth: number
  imageHeight: number
  imageName?: string
  transform: AffineTransform
  focusBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null
  initialOffset: Offset
  onApply: (offset: Offset) => void
  onClose: () => void
}

const MERCATOR_ORIGIN = 20037508.342789244
const EARTH_CIRCUMFERENCE = 2 * MERCATOR_ORIGIN
const TILE_SIZE = 256
const MIN_ZOOM = 2
const MAX_ZOOM = 20

function metersPerPixel(zoom: number) {
  return EARTH_CIRCUMFERENCE / (TILE_SIZE * 2 ** zoom)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/**
 * 卫星影像比对 / 平移校正
 * - Esri World Imagery 作为底图（EPSG:3857，和 geoalign transform 同一坐标系）
 * - 左侧 CAD 图按当前 transform + 平移量叠加
 * - 「拖动 CAD」模式下直接拖图，ΔE/ΔN 实时变化
 */
export function SatelliteCompare({ image, imageWidth, imageHeight, imageName, transform, focusBounds, initialOffset, onApply, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef({ cx: 0, cy: 0, z: 16 })
  const offsetRef = useRef<Offset>({ ...initialOffset })
  const opacityRef = useRef(0.55)
  const showCadRef = useRef(true)
  const lineOnlyRef = useRef(true)
  const lineCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const toolRef = useRef<'pan' | 'cad'>('cad')
  const tilesRef = useRef(new Map<string, HTMLImageElement>())
  const rafRef = useRef(0)
  const redrawRef = useRef<() => void>(() => {})
  const didFitRef = useRef(false)
  const dragRef = useRef<null | { mode: 'pan' | 'cad'; pointerId: number; x: number; y: number; cx: number; cy: number; east: number; north: number }>(null)
  const [east, setEast] = useState(initialOffset.east)
  const [north, setNorth] = useState(initialOffset.north)
  const [zoom, setZoom] = useState(16)
  const [opacity, setOpacity] = useState(0.55)
  const [tool, setTool] = useState<'pan' | 'cad'>('cad')
  const [showCad, setShowCad] = useState(true)
  const [lineOnly, setLineOnly] = useState(true)
  const [cursor, setCursor] = useState('')
  const [appliedTip, setAppliedTip] = useState('')

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, w, h)

    const { cx, cy, z } = viewRef.current
    const mpp = metersPerPixel(z)
    const n = 2 ** z
    const span = TILE_SIZE * mpp
    const left = cx - (w / 2) * mpp
    const right = cx + (w / 2) * mpp
    const top = cy + (h / 2) * mpp
    const bottom = cy - (h / 2) * mpp
    const tx0 = clamp(Math.floor((left + MERCATOR_ORIGIN) / span), 0, n - 1)
    const tx1 = clamp(Math.floor((right + MERCATOR_ORIGIN) / span), 0, n - 1)
    const ty0 = clamp(Math.floor((MERCATOR_ORIGIN - top) / span), 0, n - 1)
    const ty1 = clamp(Math.floor((MERCATOR_ORIGIN - bottom) / span), 0, n - 1)

    let loading = 0
    for (let ty = ty0; ty <= ty1; ty += 1) {
      for (let tx = tx0; tx <= tx1; tx += 1) {
        const key = `${z}/${tx}/${ty}`
        let tile = tilesRef.current.get(key)
        if (!tile) {
          const img = new Image()
          img.decoding = 'async'
          img.onload = () => redrawRef.current()
          img.onerror = () => { tilesRef.current.delete(key) }
          img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`
          tilesRef.current.set(key, img)
          tile = img
        }
        if (!tile.complete || !tile.naturalWidth) {
          loading += 1
          continue
        }
        const wx0 = tx * span - MERCATOR_ORIGIN
        const wy1 = MERCATOR_ORIGIN - ty * span
        const sx = (wx0 - cx) / mpp + w / 2
        const sy = (cy - wy1) / mpp + h / 2
        ctx.drawImage(tile, sx, sy, TILE_SIZE, TILE_SIZE)
      }
    }
    if (loading > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.font = '12px Inter, system-ui, sans-serif'
      ctx.fillText(`卫星瓦片加载中 ${loading}...`, 14, 22)
    }

    if (showCadRef.current) {
      const t = transform
      const H = imageHeight
      const eastNow = offsetRef.current.east
      const northNow = offsetRef.current.north
      // 图像像素 (x,row) -> 3857 -> 屏幕，合成一个仿射
      const A = t.a / mpp
      const B = -t.b / mpp
      const C = ((t.b * H + t.c + eastNow) - cx) / mpp + w / 2
      const D = -t.d / mpp
      const E = t.e / mpp
      const F = -((t.e * H + t.f + northNow) - cy) / mpp + h / 2
      ctx.save()
      ctx.globalAlpha = opacityRef.current
      ctx.imageSmoothingEnabled = true
      ctx.setTransform(dpr * A, dpr * D, dpr * B, dpr * E, dpr * C, dpr * F)
      const source = lineOnlyRef.current && lineCanvasRef.current ? lineCanvasRef.current : image
      ctx.drawImage(source, 0, 0)
      ctx.restore()
    }

    // 中心十字 + 比例尺 + 版权
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(w / 2 - 10, h / 2); ctx.lineTo(w / 2 + 10, h / 2)
    ctx.moveTo(w / 2, h / 2 - 10); ctx.lineTo(w / 2, h / 2 + 10)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(15,118,110,0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = '12px Inter, system-ui, sans-serif'
    ctx.fillText(`z${z} · ${mpp.toFixed(2)} m/px`, 14, h - 34)
    ctx.fillText('Esri World Imagery', 14, h - 14)
    ctx.textAlign = 'right'
    ctx.fillText(`ΔE ${offsetRef.current.east.toFixed(1)} m · ΔN ${offsetRef.current.north.toFixed(1)} m`, w - 14, h - 14)
    ctx.textAlign = 'left'
    if (!tilesRef.current.size) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fillText('正在加载卫星影像...', 14, 44)
    }
  }, [image, imageHeight, transform])

  useEffect(() => { redrawRef.current = redraw }, [redraw])

  const scheduleRedraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      redraw()
    })
  }, [redraw])

  const fitToCad = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth || 1000
    const h = canvas.clientHeight || 700
    const t = transform
    const H = imageHeight
    const { east: e, north: n } = offsetRef.current
    let minX: number; let maxX: number; let minY: number; let maxY: number
    if (focusBounds && focusBounds.maxX > focusBounds.minX && focusBounds.maxY > focusBounds.minY) {
      minX = focusBounds.minX + e; maxX = focusBounds.maxX + e
      minY = focusBounds.minY + n; maxY = focusBounds.maxY + n
    } else {
      const corners = [
        [0, 0], [imageWidth, 0], [0, H], [imageWidth, H],
      ].map(([x, row]) => {
        const X = t.a * x - t.b * row + t.b * H + t.c + e
        const Y = t.d * x - t.e * row + t.e * H + t.f + n
        return [X, Y]
      })
      const xs = corners.map((p) => p[0])
      const ys = corners.map((p) => p[1])
      minX = Math.min(...xs); maxX = Math.max(...xs)
      minY = Math.min(...ys); maxY = Math.max(...ys)
    }
    const mppNeeded = Math.max((maxX - minX) / (w * 0.82), (maxY - minY) / (h * 0.82))
    const z = clamp(Math.round(Math.log2(EARTH_CIRCUMFERENCE / (TILE_SIZE * mppNeeded))), MIN_ZOOM, MAX_ZOOM)
    viewRef.current = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z }
    setZoom(z)
    scheduleRedraw()
  }, [focusBounds, imageHeight, imageWidth, scheduleRedraw, transform])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => scheduleRedraw())
    observer.observe(canvas)
    fitToCad()
    const raf = requestAnimationFrame(() => {
      if (!didFitRef.current) {
        didFitRef.current = true
        fitToCad()
      }
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [fitToCad, scheduleRedraw])

  useEffect(() => { offsetRef.current = { east, north }; scheduleRedraw() }, [east, north, scheduleRedraw])
  useEffect(() => { opacityRef.current = opacity; scheduleRedraw() }, [opacity, scheduleRedraw])
  useEffect(() => { showCadRef.current = showCad; scheduleRedraw() }, [showCad, scheduleRedraw])
  useEffect(() => { lineOnlyRef.current = lineOnly; scheduleRedraw() }, [lineOnly, scheduleRedraw])
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.width = imageWidth
    canvas.height = imageHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(image, 0, 0, imageWidth, imageHeight)
    try {
      const data = ctx.getImageData(0, 0, imageWidth, imageHeight)
      const pixels = data.data
      for (let i = 0; i < pixels.length; i += 4) {
        const lum = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
        pixels[i + 3] = Math.max(0, Math.min(255, Math.round((lum - 18) * 3)))
      }
      ctx.putImageData(data, 0, 0)
    } catch {
      // 如果图片跨域导致 canvas 被污染，退回普通半透明叠加
    }
    lineCanvasRef.current = canvas
    scheduleRedraw()
  }, [image, imageHeight, imageWidth, scheduleRedraw])
  useEffect(() => { toolRef.current = tool }, [tool])

  const zoomAt = useCallback((delta: number, sx?: number, sy?: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth; const h = canvas.clientHeight
    const px = sx ?? w / 2; const py = sy ?? h / 2
    const { cx, cy, z } = viewRef.current
    const oldMpp = metersPerPixel(z)
    const wx = cx + (px - w / 2) * oldMpp
    const wy = cy - (py - h / 2) * oldMpp
    const nz = clamp(z + delta, MIN_ZOOM, MAX_ZOOM)
    const newMpp = metersPerPixel(nz)
    viewRef.current = { cx: wx - (px - w / 2) * newMpp, cy: wy + (py - h / 2) * newMpp, z: nz }
    setZoom(nz)
    scheduleRedraw()
  }, [scheduleRedraw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX - rect.left, event.clientY - rect.top)
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [zoomAt])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    wrapRef.current?.focus()
    canvas.setPointerCapture(event.pointerId)
    const { cx, cy } = viewRef.current
    dragRef.current = {
      mode: toolRef.current,
      pointerId: event.pointerId,
      x: event.clientX, y: event.clientY,
      cx, cy,
      east: offsetRef.current.east,
      north: offsetRef.current.north,
    }
    if (toolRef.current === 'cad') {
      setAppliedTip('拖动中，松开后点「应用平移」写入导出')
    }
    event.preventDefault()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const { cx, cy, z } = viewRef.current
    const mpp = metersPerPixel(z)
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const X = cx + (sx - canvas.clientWidth / 2) * mpp
    const Y = cy - (sy - canvas.clientHeight / 2) * mpp
    setCursor(`${X.toFixed(1)}, ${Y.toFixed(1)}  (EPSG:3857 m)`)

    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.mode === 'pan') {
      viewRef.current = {
        ...viewRef.current,
        cx: drag.cx - (event.clientX - drag.x) * mpp,
        cy: drag.cy + (event.clientY - drag.y) * mpp,
      }
      scheduleRedraw()
    } else {
      const nextEast = drag.east + (event.clientX - drag.x) * mpp
      const nextNorth = drag.north - (event.clientY - drag.y) * mpp
      offsetRef.current = { east: nextEast, north: nextNorth }
      setEast(round1(nextEast))
      setNorth(round1(nextNorth))
      scheduleRedraw()
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  const nudge = (dx: number, dy: number) => {
    setEast((prev) => round1(prev + dx))
    setNorth((prev) => round1(prev + dy))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-step, 0) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(step, 0) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); nudge(0, step) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(0, -step) }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1) }
    else if (event.key === '-') { event.preventDefault(); zoomAt(-1) }
  }

  const apply = () => {
    onApply({ east: round1(east), north: round1(north) })
    setAppliedTip('已写入当前配准；关闭后点「后端导出配准包」即可生成带平移的 zip。')
  }

  const reset = () => {
    setEast(0); setNorth(0); setAppliedTip('已把平移清零。')
  }

  return (
    <div className="sat-overlay" onKeyDown={onKeyDown} tabIndex={0} ref={wrapRef}>
      <div className="sat-header">
        <div>
          <p className="eyebrow">卫星比对 · 平移校正</p>
          <h2>{imageName ?? 'CAD'} 叠 Esri World Imagery</h2>
        </div>
        <div className="sat-header-actions">
          <span className="sat-delta">ΔE <strong>{east.toFixed(1)}</strong> m / ΔN <strong>{north.toFixed(1)}</strong> m</span>
          <button type="button" onClick={reset}>平移清零</button>
          <button type="button" className="primary" onClick={apply}>应用平移</button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
      <div className="sat-body">
        <div className="sat-map">
          <canvas
            ref={canvasRef}
            className="sat-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
        <aside className="sat-panel">
          <div className="sat-section">
            <h3>平移量（3857 米）</h3>
            <label className="sat-field">
              <span>东 ΔE</span>
              <input type="number" step={0.5} value={east} onChange={(event) => setEast(Number(event.target.value) || 0)} />
            </label>
            <label className="sat-field">
              <span>北 ΔN</span>
              <input type="number" step={0.5} value={north} onChange={(event) => setNorth(Number(event.target.value) || 0)} />
            </label>
            <div className="sat-nudge">
              <button type="button" onClick={() => nudge(-10, 0)}>←10</button>
              <button type="button" onClick={() => nudge(-1, 0)}>←1</button>
              <button type="button" onClick={() => nudge(1, 0)}>1→</button>
              <button type="button" onClick={() => nudge(10, 0)}>10→</button>
            </div>
            <div className="sat-nudge">
              <button type="button" onClick={() => nudge(0, 10)}>↑10</button>
              <button type="button" onClick={() => nudge(0, 1)}>↑1</button>
              <button type="button" onClick={() => nudge(0, -1)}>1↓</button>
              <button type="button" onClick={() => nudge(0, -10)}>10↓</button>
            </div>
            <p className="sat-hint">方向键 ±1 m，Shift+方向键 ±10 m；也可以直接拖 CAD。</p>
          </div>
          <div className="sat-section">
            <h3>操作</h3>
            <div className="sat-tools">
              <button type="button" className={tool === 'cad' ? 'selected' : ''} onClick={() => setTool('cad')}>拖动 CAD</button>
              <button type="button" className={tool === 'pan' ? 'selected' : ''} onClick={() => setTool('pan')}>拖动地图</button>
            </div>
            <label className="sat-field">
              <span>CAD 透明度</span>
              <input type="range" min={0.1} max={0.95} step={0.05} value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
            </label>
            <label className="sat-check">
              <input type="checkbox" checked={showCad} onChange={(event) => setShowCad(event.target.checked)} />
              <span>显示 CAD</span>
            </label>
            <label className="sat-check">
              <input type="checkbox" checked={lineOnly} onChange={(event) => setLineOnly(event.target.checked)} />
              <span>仅线稿（透明底）</span>
            </label>
            <div className="sat-tools">
              <button type="button" onClick={() => zoomAt(1)}>放大</button>
              <button type="button" onClick={() => zoomAt(-1)}>缩小</button>
              <button type="button" onClick={fitToCad}>适配 CAD</button>
            </div>
            <p className="sat-hint">当前 z{zoom}，滚轮缩放；「适配 CAD」回到整图。</p>
          </div>
          <div className="sat-section">
            <h3>说明</h3>
            <p className="sat-hint">底图为 WGS84 / EPSG:3857，与 GeoAlign 的 transform 同一坐标系，不需要 GCJ-02 纠偏。</p>
            <p className="sat-hint">这里只改平移；确认后点「应用平移」，再导出配准包。</p>
            {appliedTip && <p className="sat-status">{appliedTip}</p>}
            <p className="sat-cursor">{cursor || '鼠标移到图上查看 3857 坐标'}</p>
          </div>
        </aside>
      </div>
    </div>
  )
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}
