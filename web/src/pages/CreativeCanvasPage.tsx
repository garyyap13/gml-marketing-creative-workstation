import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { explain } from '../lib/commands'
import { useCreativeCanvas, variantStates, type CanvasData } from '../lib/data'
import { money, resultName } from '../lib/results'

type Tone = 'plain' | 'live' | 'learning' | 'pending'
type Box = { id: string; x: number; y: number; w: number; h: number; title: string; sub: string; label: string; href: string; tone: Tone }
type Edge = { from: string; to: string; kind: 'flow' | 'loop' | 'derived' }

const W = 156
const H = 50
const GAP = 16
const ROW = H + GAP
const TOP = 52
const COLUMNS = { brief: 16, creative: 196, variant: 376, version: 556, launch: 736, plan: 916 }
const HEADINGS: [keyof typeof COLUMNS, string][] = [
  ['brief', 'Brief'], ['creative', 'Creative'], ['variant', 'Variants'], ['version', 'Versions'], ['launch', 'Launches · results'], ['plan', '复盘'],
]
const planStates: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
const verdicts: Record<string, string> = { confirmed: 'Confirmed', not_confirmed: 'Not confirmed', not_enough_data: 'Not enough data' }

function outcome(data: CanvasData, versionId: string) {
  const review = data.reviews.find((r) => r.version_id === versionId)
  if (!review) return 'Submitted'
  if (!review.decision) return 'Awaiting review'
  if (review.decision === 'request_changes') return 'Changes requested'
  if (review.approval_end_reason === 'withdrawn') return 'Approval withdrawn'
  if (review.approval_end_reason === 'superseded') return 'Approval superseded'
  return 'Approved'
}

// Cost per result for one Launch, only when all its rows share one currency, result type, attribution and time zone.
function launchResult(data: CanvasData, launchId: string) {
  const rows = data.results.filter((r) => r.launch_id === launchId)
  if (!rows.length) return null
  const scopes = new Set(rows.map((r) => [r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope].join('|')))
  if (scopes.size > 1) return 'mixed results'
  if (rows.some((r) => r.spend === null || r.results === null)) return 'some days not reported'
  const spend = rows.reduce((t, r) => t + Number(r.spend), 0)
  const results = rows.reduce((t, r) => t + Number(r.results), 0)
  // Reach is counted per day and never added up, so it gives no cost per result (D-37).
  if (rows[0].result_indicator === 'reach') return `${money(spend, rows[0].currency)} spend`
  if (!results) return `${money(spend, rows[0].currency)} spend, no results`
  return `${money(spend / results, rows[0].currency)} per ${resultName(rows[0].result_indicator).toLowerCase().replace(/s$/, '')}`
}

// One band per Variant: its Versions top to bottom, each with its Launches and 复盘 beside it.
function layout(data: CanvasData) {
  const boxes: Box[] = []
  const edges: Edge[] = []
  const followUps = new Set(data.actions.map((a) => a.variant_id).filter(Boolean))
  let y = TOP
  for (const variant of data.variants) {
    const versions = data.versions.filter((v) => v.variant_id === variant.id).sort((a, b) => a.version_number - b.version_number)
    const unversioned = data.launches.filter((l) => l.variant_id === variant.id && !l.version_id)
    const rows = versions.map((v) => {
      const launches = data.launches.filter((l) => l.version_id === v.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
      const plans = data.plans.filter((p) => p.baseline_version_id === v.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
      return { version: v, launches, plans, height: Math.max(1, launches.length, plans.length) }
    })
    const height = Math.max(1, rows.reduce((t, r) => t + r.height, 0) + unversioned.length)
    const fromRetro = followUps.has(variant.id)
    boxes.push({
      id: variant.id, x: COLUMNS.variant, y: y + ((height - 1) * ROW) / 2, w: W, h: H,
      title: variant.code, sub: fromRetro ? `From 复盘 · ${variantStates[variant.state]}` : variantStates[variant.state],
      label: fromRetro ? `${variant.code} · From 复盘 · ${variantStates[variant.state]}` : `${variant.code} · ${variantStates[variant.state]}`,
      href: `/variants/${variant.id}`, tone: fromRetro ? 'learning' : variant.live_at ? 'live' : variant.state === 'cancelled' ? 'pending' : 'plain',
    })
    edges.push({ from: 'creative', to: variant.id, kind: 'flow' })
    if (variant.derived_from_variant_id && !fromRetro) edges.push({ from: variant.derived_from_variant_id, to: variant.id, kind: 'derived' })

    let rowY = y
    for (const row of rows) {
      const versionY = rowY + ((row.height - 1) * ROW) / 2
      const result = outcome(data, row.version.id)
      boxes.push({
        id: row.version.id, x: COLUMNS.version, y: versionY, w: W, h: H, title: `Version ${row.version.version_number}`, sub: result,
        label: `${variant.code} Version ${row.version.version_number} · ${result}`,
        href: (() => { const review = data.reviews.find((r) => r.version_id === row.version.id); return review ? `/reviews/${review.id}` : `/variants/${variant.id}` })(),
        // Green means shown to people: an approved Version counts once one of its Launches has gone live.
        tone: data.launches.some((l) => l.version_id === row.version.id && (l.status === 'live' || l.status === 'ended')) ? 'live'
          : result.startsWith('Approval') ? 'pending' : 'plain',
      })
      edges.push({ from: variant.id, to: row.version.id, kind: 'flow' })
      row.launches.forEach((launch, i) => {
        const status = launch.status.charAt(0).toUpperCase() + launch.status.slice(1)
        const result = launchResult(data, launch.id)
        const title = `${launch.kind === 'post' ? 'Post' : 'Ad'} · ${status}`
        const sub = result ?? (launch.origin === 'unplanned' ? 'Unplanned' : 'No results yet')
        boxes.push({
          id: launch.id, x: COLUMNS.launch, y: rowY + i * ROW, w: W, h: H, title, sub,
          label: `${variant.code} ${title} · ${sub}`, href: `/variants/${variant.id}`, tone: launch.status === 'live' ? 'live' : 'plain',
        })
        edges.push({ from: row.version.id, to: launch.id, kind: 'flow' })
      })
      row.plans.forEach((plan, i) => {
        const state = planStates[plan.state]
        boxes.push({
          id: plan.id, x: COLUMNS.plan, y: rowY + i * ROW, w: W, h: H, title: `复盘 · ${state}`,
          sub: plan.verdict ? verdicts[plan.verdict] : plan.check_date ? `check ${new Date(`${plan.check_date}T00:00:00`).toLocaleDateString()}` : 'No check date yet',
          label: `${variant.code} 复盘 · ${state}${plan.verdict ? ` · ${verdicts[plan.verdict]}` : ''}`, href: `/plans/${plan.id}`, tone: 'learning',
        })
        edges.push({ from: row.version.id, to: plan.id, kind: 'flow' })
        for (const action of data.actions.filter((a) => a.plan_id === plan.id && a.variant_id)) edges.push({ from: plan.id, to: action.variant_id as string, kind: 'loop' })
      })
      rowY += row.height * ROW
    }
    unversioned.forEach((launch, i) => {
      const status = launch.status.charAt(0).toUpperCase() + launch.status.slice(1)
      const result = launchResult(data, launch.id)
      const title = `${launch.kind === 'post' ? 'Post' : 'Ad'} · ${status}`
      const sub = result ?? 'Unplanned, no Version'
      boxes.push({
        id: launch.id, x: COLUMNS.launch, y: rowY + i * ROW, w: W, h: H, title, sub,
        label: `${variant.code} ${title} · ${sub}`, href: `/variants/${variant.id}`, tone: launch.status === 'live' ? 'live' : 'plain',
      })
      edges.push({ from: variant.id, to: launch.id, kind: 'flow' })
    })
    y += height * ROW + GAP
  }
  const bottom = Math.max(y, TOP + ROW)
  const middle = TOP + (bottom - TOP - 2 * GAP - H) / 2
  // The Brief and the Creative come first, so keyboard and screen-reader users meet the map in reading order.
  boxes.unshift({
    id: 'creative', x: COLUMNS.creative, y: middle, w: W, h: H, title: data.creative.code, sub: data.creative.title,
    label: `${data.creative.code} · ${data.creative.title}`, href: `/creatives/${data.creative.id}`, tone: 'plain',
  })
  if (data.brief) {
    boxes.unshift({
      id: 'brief', x: COLUMNS.brief, y: middle, w: W, h: H, title: 'Brief', sub: data.brief.title,
      label: `Brief · ${data.brief.title}`, href: `/briefs/${data.brief.id}`, tone: 'plain',
    })
    edges.push({ from: 'brief', to: 'creative', kind: 'flow' })
  }
  return { boxes, edges, width: COLUMNS.plan + W + 24, height: bottom + GAP }
}

function path(from: Box, to: Box, kind: Edge['kind']) {
  if (kind === 'loop') {
    // From the 复盘 back to the follow-up Variant it created.
    const sx = from.x + from.w / 2
    const sy = from.y + from.h
    const tx = to.x + to.w
    const ty = to.y + to.h / 2
    return `M${sx} ${sy} C${sx} ${ty + 30}, ${tx + 120} ${ty}, ${tx} ${ty}`
  }
  if (kind === 'derived') {
    const sx = from.x
    const sy = from.y + from.h / 2
    const ty = to.y + to.h / 2
    return `M${sx} ${sy} C${sx - 28} ${sy}, ${sx - 28} ${ty}, ${sx} ${ty}`
  }
  const sx = from.x + from.w
  const sy = from.y + from.h / 2
  const tx = to.x
  const ty = to.y + to.h / 2
  return `M${sx} ${sy} C${sx + 18} ${sy}, ${tx - 18} ${ty}, ${tx} ${ty}`
}

// Shortens text to fit a box; wide characters such as Chinese count twice.
function clip(text: string, max: number) {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(text[i]) ? 2 : 1
    if (width > max) return `${text.slice(0, i)}…`
  }
  return text
}

// A read-only map of one Creative's whole loop (D-75). Every box opens its record.
export function CreativeCanvasPage() {
  const { id = '' } = useParams()
  const data = useCreativeCanvas(id)
  const navigate = useNavigate()
  const svgRef = useRef<SVGSVGElement>(null)
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 })
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const map = useMemo(() => (data.data ? layout(data.data) : null), [data.data])
  const { zoom } = camera
  const view = map ? { w: map.width / zoom, h: map.height / zoom } : { w: 1, h: 1 }

  // Zooms about a point of the map (by default the middle of the view), keeping that point where it is on screen.
  const zoomAbout = (factor: number, at?: { x: number; y: number }) => {
    if (!map) return
    setCamera((c) => {
      const next = Math.min(4, Math.max(0.5, Math.round(c.zoom * factor * 100) / 100))
      const w = map.width / c.zoom
      const h = map.height / c.zoom
      const px = at?.x ?? c.x + w / 2
      const py = at?.y ?? c.y + h / 2
      const k = c.zoom / next
      return { zoom: next, x: px - (px - c.x) * k, y: py - (py - c.y) * k }
    })
  }
  const fit = () => setCamera({ zoom: 1, x: 0, y: 0 })
  // Map units per screen pixel; with preserveAspectRatio "meet" the tighter side decides.
  const unitsPerPixel = () => {
    const svg = svgRef.current
    if (!svg || !map) return 1
    const c = cameraRef.current
    return Math.max(map.width / c.zoom / svg.clientWidth, map.height / c.zoom / svg.clientHeight)
  }

  // Ctrl or Cmd with the wheel (or a trackpad pinch) zooms about the cursor; the plain wheel keeps scrolling the page.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !map) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = svg.getBoundingClientRect()
      const c = cameraRef.current
      const scale = unitsPerPixel()
      zoomAbout(Math.exp(-event.deltaY * 0.002), { x: c.x + (event.clientX - box.left) * scale, y: c.y + (event.clientY - box.top) * scale })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [map])

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('a')) return
    drag.current = { x: event.clientX, y: event.clientY, ox: camera.x, oy: camera.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return
    const scale = unitsPerPixel()
    const start = drag.current
    setCamera((c) => ({ ...c, x: start.ox - (event.clientX - start.x) * scale, y: start.oy - (event.clientY - start.y) * scale }))
  }
  // Keyboard focus on a box outside the view brings it into view.
  const reveal = (box: Box) => {
    const c = cameraRef.current
    if (box.x >= c.x && box.x + box.w <= c.x + view.w && box.y >= c.y && box.y + box.h <= c.y + view.h) return
    setCamera({ ...c, x: box.x + box.w / 2 - view.w / 2, y: box.y + box.h / 2 - view.h / 2 })
  }

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error || !map || !data.data) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const byId = new Map(map.boxes.map((b) => [b.id, b]))
  const { creative } = data.data

  return (
    <main className="page" style={{ maxWidth: 'none' }}>
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <Link to={`/creatives/${creative.id}`} className="eyebrow">Creatives › {creative.code}</Link>
          <h1>{creative.title} · canvas</h1>
        </div>
        <div className="row" role="group" aria-label="Zoom">
          <button aria-label="Zoom out" onClick={() => zoomAbout(1 / 1.25)}>−</button>
          <span className="small" aria-live="polite" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button aria-label="Zoom in" onClick={() => zoomAbout(1.25)}>+</button>
          <button onClick={fit}>Fit</button>
        </div>
      </div>
      <section aria-label="Creative canvas" className="panel canvas-panel">
        <svg ref={svgRef} className="canvas" viewBox={`${camera.x} ${camera.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMin meet"
          style={{ aspectRatio: `${map.width} / ${map.height}`, maxHeight: 680, minHeight: 240 }} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          <defs>
            <marker id="cv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" className="cv-arrowhead" /></marker>
            <marker id="cv-arrow-loop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" className="cv-arrowhead loop" /></marker>
          </defs>
          {HEADINGS.map(([column, text]) => <text key={column} className="cv-heading" x={COLUMNS[column] + W / 2} y={28} textAnchor="middle">{text}</text>)}
          {map.edges.map((edge, i) => {
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (!from || !to) return null
            return <path key={i} className={`cv-edge ${edge.kind}`} d={path(from, to, edge.kind)} markerEnd={`url(#${edge.kind === 'loop' ? 'cv-arrow-loop' : 'cv-arrow'})`} />
          })}
          {map.boxes.map((box) => (
            <a key={box.id} href={box.href} aria-label={box.label} className={`cv-node ${box.tone}`} onFocus={() => reveal(box)}
              onClick={(event) => {
                // Modifier and middle clicks keep the browser's own behaviour, such as opening a new tab.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                event.preventDefault()
                navigate(box.href)
              }}>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={6} />
              <text className="cv-title" x={box.x + 10} y={box.y + 20}>{clip(box.title, 22)}</text>
              <text className="cv-sub" x={box.x + 10} y={box.y + 37}>{clip(box.sub, 26)}</text>
            </a>
          ))}
        </svg>
      </section>
      <div className="row small muted">
        <span className="row" style={{ gap: 6 }}><span className="cv-key live" />shown to people</span>
        <span className="row" style={{ gap: 6 }}><span className="cv-key learning" />复盘 and what it led to</span>
        <span>Drag to pan · Ctrl or ⌘ with the wheel to zoom · Tab through the boxes and press Enter to open one</span>
      </div>
    </main>
  )
}
