import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { CommandError, explain, newKey, run } from '../lib/commands'
import { useLinkTargets, useMembers, useWhiteboard, type BoardItem } from '../lib/data'
import { useMember } from '../lib/session'

// Unsaved changes to an item, and the version of the item they started from.
type Draft = Partial<Pick<BoardItem, 'x' | 'y' | 'width' | 'height' | 'text'>> & { base: number }
type Field = Exclude<keyof Draft, 'base'>
type Targets = NonNullable<ReturnType<typeof useLinkTargets>['data']>
type BoardData = NonNullable<ReturnType<typeof useWhiteboard>['data']>
type Status = { text: string; tone: 'muted' | 'error'; action?: { label: string; run: () => void; focus?: boolean } }
const NOTE_W = 176
const NOTE_H = 120
const geometry: Field[] = ['x', 'y', 'width', 'height']
const colours: BoardItem['colour'][] = ['yellow', 'green', 'blue', 'purple']
const colourNames: Record<string, string> = { yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple' }
const kinds: Record<NonNullable<BoardItem['link_type']>, string> = { brief: 'Brief', creative: 'Creative', variant: 'Variant', footage: 'Footage', finding: 'Finding' }
const clamp = (low: number, high: number, value: number) => Math.min(high, Math.max(low, Math.round(value)))

// What a link points at, as a label and a route, looked up by id.
function linkLookup(targets: Targets | undefined) {
  const byId = <T extends { id: string }>(rows: T[] = []) => new Map(rows.map((r) => [r.id, r]))
  const briefs = byId(targets?.briefs)
  const creatives = byId(targets?.creatives)
  const variants = byId(targets?.variants)
  const footage = byId(targets?.footage)
  const findings = byId(targets?.findings)
  return (type: BoardItem['link_type'], id: string | null) => {
    if (!type || !id || !targets) return null
    switch (type) {
      case 'brief': { const b = briefs.get(id); return { label: b ? `Brief · ${b.title}` : 'Brief', to: `/briefs/${id}` } }
      case 'creative': { const c = creatives.get(id); return { label: c ? c.code : 'Creative', to: `/creatives/${id}` } }
      case 'variant': { const v = variants.get(id); return { label: v ? v.code : 'Variant', to: `/variants/${id}` } }
      case 'footage': { const f = footage.get(id); return { label: f ? f.code : 'Footage', to: '/footage' } }
      case 'finding': { const f = findings.get(id); return { label: f ? `Finding: ${f.body.slice(0, 40)}` : 'Finding', to: f ? `/plans/${f.plan_id}` : '/plans' } }
    }
  }
}

function options(targets: Targets | undefined, type: string) {
  if (!targets) return []
  switch (type) {
    case 'brief': return targets.briefs.map((b) => ({ id: b.id, label: b.title }))
    case 'creative': return targets.creatives.map((c) => ({ id: c.id, label: `${c.code} ${c.title}` }))
    case 'variant': return targets.variants.map((v) => ({ id: v.id, label: v.code }))
    case 'footage': return targets.footage.map((f) => ({ id: f.id, label: `${f.code} · ${f.title}` }))
    case 'finding': return targets.findings.map((f) => ({ id: f.id, label: f.body.slice(0, 80) }))
    default: return []
  }
}

// A whiteboard of sticky notes and frames that both teams arrange (D-75). Each change saves on its own with a
// version check; the board refreshes every few seconds.
export function WhiteboardPage() {
  const { id = '' } = useParams()
  return <Whiteboard key={id} id={id} />
}

function Whiteboard({ id }: { id: string }) {
  const me = useMember()
  const data = useWhiteboard(id)
  const members = useMembers()
  const targets = useLinkTargets()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  // Drafts sit on top of the refreshed board. They live in a ref so a save reads the latest without waiting for a render.
  const drafts = useRef<Record<string, Draft>>({})
  const [, repaint] = useReducer((n: number) => n + 1, 0)
  const known = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<void>>())
  const keyTimers = useRef(new Map<string, number>())
  const focusNext = useRef<string | null>(null)
  const drag = useRef<{ itemId: string; pointerId: number; mode: 'move' | 'resize'; px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null)
  const [status, setStatus] = useState<Status>({ text: '', tone: 'muted' })
  const [linking, setLinking] = useState<{ itemId: string; type: string; target: string } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const linkOf = useMemo(() => linkLookup(targets.data), [targets.data])

  // A new note's text, or a new frame's name, takes focus once it is on the board.
  useEffect(() => {
    if (!focusNext.current) return
    const field = surfaceRef.current?.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-item="${focusNext.current}"] :is(textarea, input)`)
    if (!field) return
    focusNext.current = null
    field.focus()
    field.select()
  }, [data.data])
  useEffect(() => () => keyTimers.current.forEach((timer) => window.clearTimeout(timer)), [])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['whiteboard', id] })
  const serverItem = (itemId: string) => queryClient.getQueryData<BoardData>(['whiteboard', id])?.items.find((i) => i.id === itemId)
  // The newest version this page knows of: the board's, or the one its own last save reached.
  const versionOf = (itemId: string) => Math.max(serverItem(itemId)?.lock_version ?? 0, known.current.get(itemId) ?? 0)
  const setDraft = (itemId: string, change: (d: Draft | undefined) => Draft | undefined) => {
    const { [itemId]: current, ...rest } = drafts.current
    const next = change(current)
    drafts.current = next ? { ...rest, [itemId]: next } : rest
    repaint()
  }
  // Starts or extends an edit, keeping the version it began from.
  const edit = (itemId: string, fields: Omit<Draft, 'base'>) => setDraft(itemId, (d) => ({ ...d, base: d?.base ?? versionOf(itemId), ...fields }))
  // Drops fields from a draft; given values, only the fields that still hold them.
  const drop = (itemId: string, fields: Field[], ifStill?: Record<string, unknown>) => setDraft(itemId, (d) => {
    if (!d) return d
    const next: Draft = { ...d }
    for (const f of fields) if (!ifStill || next[f] === ifStill[f]) delete next[f]
    return Object.keys(next).some((k) => k !== 'base') ? next : undefined
  })
  const pick = (d: Draft | undefined, fields: Field[]) => Object.fromEntries(fields.filter((f) => d?.[f] !== undefined).map((f) => [f, d![f]]))
  // One command per item at a time, so a quick second change starts from the version the first one made.
  const enqueue = (itemId: string, task: () => Promise<void>) => {
    const next = (queues.current.get(itemId) ?? Promise.resolve()).catch(() => undefined).then(task)
    queues.current.set(itemId, next)
    return next
  }
  const otherFirst = (e: CommandError | undefined) => e?.code === 'conflict' && !e.reason

  // Saves a change from the version the edit began with. If someone else changed the item first, a move or recolour
  // shows their version, and typed words stay in place so they can be saved over theirs or dropped.
  const save = (itemId: string, patch: Record<string, unknown>) => enqueue(itemId, async () => {
    if (!Object.keys(patch).length) return
    const base = drafts.current[itemId]?.base ?? versionOf(itemId)
    const fields = (Object.keys(patch) as Field[]).filter((f) => [...geometry, 'text'].includes(f))
    setStatus({ text: 'Saving…', tone: 'muted' })
    try {
      const result = await run<{ lock_version: number }>('update_board_item', { p_item_id: itemId, p_patch: patch, p_expected_lock_version: base })
      known.current.set(itemId, result.lock_version)
      setDraft(itemId, (d) => (d && d.base === base ? { ...d, base: result.lock_version } : d))
      setStatus({ text: 'Saved', tone: 'muted' })
      await refresh()
      drop(itemId, fields, patch)
    } catch (error) {
      const e = error instanceof CommandError ? error : undefined
      const gone = e?.code === 'not_found' || e?.reason === 'board_archived' || e?.reason === 'item_archived'
      if ('text' in patch && !gone) {
        if (otherFirst(e) && e?.currentLockVersion !== undefined) setDraft(itemId, (d) => (d ? { ...d, base: e.currentLockVersion! } : d))
        setStatus(otherFirst(e)
          ? { text: 'Someone else changed this while you typed. Your words are kept; leave the box again to save them over theirs.', tone: 'error',
              action: { label: 'Show theirs', run: () => { drop(itemId, ['text']); setStatus({ text: '', tone: 'muted' }) } } }
          : { text: `${e?.fieldErrors.text ?? explain(error)} Your words are kept.`, tone: 'error' })
      } else {
        drop(itemId, fields)
        setStatus({ text: otherFirst(e) ? 'Someone else changed that first; their version is showing.' : explain(error), tone: 'error' })
      }
      await refresh()
    }
  })
  const add = async (kind: 'note' | 'frame') => {
    const view = scrollRef.current
    const x = Math.round((view?.scrollLeft ?? 0) + (view?.clientWidth ?? 800) / 2 - (kind === 'note' ? NOTE_W / 2 : 200) + Math.random() * 40)
    const y = Math.round((view?.scrollTop ?? 0) + (view?.clientHeight ?? 500) / 2 - (kind === 'note' ? NOTE_H / 2 : 120) + Math.random() * 40)
    setStatus({ text: 'Saving…', tone: 'muted' })
    try {
      const result = await run<{ id: string }>('add_board_item', {
        p_board_id: id,
        p_item: kind === 'note' ? { kind, text: '', colour: 'yellow', x, y } : { kind, text: 'New frame', x, y, width: 420, height: 260 },
        p_idempotency_key: newKey(),
      })
      focusNext.current = result.id
      setStatus({ text: 'Saved', tone: 'muted' })
    } catch (error) {
      setStatus({ text: explain(error), tone: 'error' })
    }
    await refresh()
  }
  // Removing archives the item; Undo puts it back.
  const archive = (item: BoardItem) => enqueue(item.id, async () => {
    try {
      const result = await run<{ lock_version: number }>('archive_board_item', { p_item_id: item.id, p_expected_lock_version: versionOf(item.id) })
      known.current.set(item.id, result.lock_version)
      setDraft(item.id, () => undefined)
      setStatus({ text: item.kind === 'note' ? 'Note removed.' : 'Frame removed.', tone: 'muted', action: { label: 'Undo', run: () => void restore(item.id), focus: true } })
    } catch (error) {
      const e = error instanceof CommandError ? error : undefined
      setStatus({ text: otherFirst(e) ? 'Someone else changed that first; look again.' : explain(error), tone: 'error' })
    }
    await refresh()
  })
  const restore = (itemId: string) => enqueue(itemId, async () => {
    try {
      const result = await run<{ lock_version: number }>('restore_board_item', { p_item_id: itemId, p_expected_lock_version: known.current.get(itemId) ?? 0 })
      known.current.set(itemId, result.lock_version)
      focusNext.current = itemId
      setStatus({ text: 'Put back.', tone: 'muted' })
    } catch (error) {
      setStatus({ text: explain(error), tone: 'error' })
    }
    await refresh()
  })

  if (data.isPending) return <main className="page"><p className="muted">Loading…</p></main>
  if (data.error) return <main className="page"><p className="error">{explain(data.error)}</p></main>
  const { board } = data.data
  const items = data.data.items.map((i) => ({ ...i, ...drafts.current[i.id] }))
  const server = new Map(data.data.items.map((i) => [i.id, i]))
  const width = Math.max(1600, ...items.map((i) => i.x + (i.width ?? NOTE_W) + 400))
  const height = Math.max(900, ...items.map((i) => i.y + (i.height ?? NOTE_H) + 400))
  const home = board.brief_id ? linkOf('brief', board.brief_id) : board.creative_id ? linkOf('creative', board.creative_id) : null
  const archived = Boolean(board.archived_at)
  const author = (memberId: string) => members.data?.find((m) => m.id === memberId)?.display_name ?? '…'
  const current = (item: BoardItem) => ({ ...item, ...drafts.current[item.id] })

  // Dragging a note by its edge, or a frame by its border or name, moves it; a frame's corner handle resizes it.
  // On touch, the inside of a frame scrolls the board instead.
  const startDrag = (event: ReactPointerEvent<HTMLElement>, item: BoardItem, mode: 'move' | 'resize') => {
    if (archived || event.button !== 0 || drag.current) return
    const target = event.target as Element
    if (mode === 'move' && target.closest('textarea, input, button, a, select')) return
    if (mode === 'move' && item.kind === 'frame' && event.pointerType === 'touch' && !target.closest('.bd-frame-grip')) return
    event.preventDefault()
    const now = current(item)
    drag.current = {
      itemId: item.id, pointerId: event.pointerId, mode, px: event.clientX, py: event.clientY,
      ox: mode === 'move' ? now.x : now.width ?? 0, oy: mode === 'move' ? now.y : now.height ?? 0, moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    const dx = event.clientX - d.px
    const dy = event.clientY - d.py
    if (!d.moved && Math.abs(dx) + Math.abs(dy) <= 3) return
    d.moved = true
    edit(d.itemId, d.mode === 'move'
      ? { x: clamp(0, 100000, d.ox + dx), y: clamp(0, 100000, d.oy + dy) }
      : { width: clamp(120, 4000, d.ox + dx), height: clamp(80, 4000, d.oy + dy) })
  }
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    drag.current = null
    if (d.moved) void save(d.itemId, pick(drafts.current[d.itemId], geometry))
  }
  // The browser took the pointer (a scroll, say): put the item back where it was.
  const cancelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    drag.current = null
    if (d.moved) drop(d.itemId, d.mode === 'move' ? ['x', 'y'] : ['width', 'height'])
  }
  const dragHandlers = { onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag }
  // Arrow keys move the focused item (Shift for bigger steps; Alt resizes a frame); it saves once the keys rest.
  const onKey = (event: KeyboardEvent<HTMLElement>, item: BoardItem) => {
    if (archived || event.target !== event.currentTarget) return
    const step = event.shiftKey ? 50 : 10
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (!delta) return
    event.preventDefault()
    const now = current(item)
    edit(item.id, event.altKey && item.kind === 'frame'
      ? { width: clamp(120, 4000, (now.width ?? 420) + delta[0]), height: clamp(80, 4000, (now.height ?? 260) + delta[1]) }
      : { x: clamp(0, 100000, now.x + delta[0]), y: clamp(0, 100000, now.y + delta[1]) })
    window.clearTimeout(keyTimers.current.get(item.id))
    keyTimers.current.set(item.id, window.setTimeout(() => {
      keyTimers.current.delete(item.id)
      void save(item.id, pick(drafts.current[item.id], geometry))
    }, 500))
  }
  const commitText = (item: BoardItem) => {
    const text = drafts.current[item.id]?.text
    if (text === undefined) return
    if (text === item.text) { drop(item.id, ['text']); return }
    void save(item.id, { text })
  }

  const closeLink = () => {
    const itemId = linking?.itemId
    setLinking(null)
    if (itemId) surfaceRef.current?.querySelector<HTMLElement>(`[data-item="${itemId}"]`)?.focus()
  }
  const submitLink = (event: FormEvent) => {
    event.preventDefault()
    if (!linking) return
    const { itemId, type, target } = linking
    closeLink()
    void save(itemId, type ? { link_type: type, link_id: target } : { link_type: null, link_id: null })
  }
  const archiveBoard = async () => {
    try {
      await run('archive_board', { p_board_id: board.id, p_expected_lock_version: board.lock_version })
      await queryClient.invalidateQueries({ queryKey: ['whiteboards'] })
      navigate('/boards')
    } catch (error) {
      setStatus({ text: explain(error), tone: 'error' })
    }
  }

  return (
    <main className="page" style={{ maxWidth: 'none' }}>
      <div className="row spread">
        <div className="stack" style={{ gap: 4 }}>
          <Link to="/boards" className="eyebrow">Boards</Link>
          <h1>{board.title}</h1>
          {home && <Link to={home.to} className="small">{home.label}</Link>}
        </div>
        <div className="row">
          {!archived && <button onClick={() => void add('note')}>Add note</button>}
          {!archived && <button onClick={() => void add('frame')}>Add frame</button>}
          <span className={status.tone === 'error' ? 'small error' : 'small muted'} aria-live="polite">
            {status.text}
            {status.action && <> <button className="bd-status-action" autoFocus={status.action.focus} onClick={status.action.run}>{status.action.label}</button></>}
          </span>
          {!archived && (me.id === board.created_by || me.is_admin) && (confirmArchive ? (
            <span className="row small"><span>Archive this board? It stays readable.</span><button onClick={() => void archiveBoard()}>Archive board</button><button onClick={() => setConfirmArchive(false)}>Keep it</button></span>
          ) : <button onClick={() => setConfirmArchive(true)}>Archive…</button>)}
        </div>
      </div>
      {archived && <p className="notice small">This board is archived. It can be read but not changed.</p>}
      {linking && (
        <form aria-label="Link the note" className="panel row" style={{ alignItems: 'end' }} onSubmit={submitLink}
          onKeyDown={(e) => { if (e.key === 'Escape') closeLink() }}>
          <label style={{ flex: '0 1 180px' }}>Link to
            <select autoFocus value={linking.type} onChange={(e) => setLinking({ ...linking, type: e.target.value, target: '' })}>
              <option value="">No link</option>
              {Object.entries(kinds).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label style={{ flex: '1 1 280px' }}>Record
            <select value={linking.target} onChange={(e) => setLinking({ ...linking, target: e.target.value })} disabled={!linking.type}>
              <option value="">Choose…</option>
              {options(targets.data, linking.type).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <button type="submit" className="primary" disabled={Boolean(linking.type) && !linking.target}>{linking.type ? 'Link note' : 'Remove link'}</button>
          <button type="button" onClick={closeLink}>Cancel</button>
        </form>
      )}
      <section aria-label="Board" className="bd-scroll" ref={scrollRef}>
        <div className="bd-surface" ref={surfaceRef} style={{ width, height }}>
          {items.filter((i) => i.kind === 'frame').map((frame) => {
            const base = server.get(frame.id)!
            return (
              <div key={frame.id} data-item={frame.id} role="group" aria-label={`Frame: ${base.text}`} className="bd-frame" tabIndex={0}
                style={{ left: frame.x, top: frame.y, width: frame.width ?? 420, height: frame.height ?? 260 }}
                onPointerDown={(e) => startDrag(e, base, 'move')} {...dragHandlers} onKeyDown={(e) => onKey(e, base)}>
                <span className="bd-frame-grip" aria-hidden="true" />
                <input aria-label="Frame name" className="bd-frame-name" value={frame.text} maxLength={120} readOnly={archived}
                  onChange={(e) => edit(base.id, { text: e.target.value })} onBlur={() => commitText(base)} />
                {!archived && <button className="bd-remove" aria-label="Remove frame" title="Remove frame" onClick={() => void archive(base)}>×</button>}
                {!archived && <span className="bd-resize" aria-hidden="true" onPointerDown={(e) => { e.stopPropagation(); startDrag(e, base, 'resize') }} />}
              </div>
            )
          })}
          {items.filter((i) => i.kind === 'note').map((note) => {
            // The accessible name follows the saved text, so it doesn't change with every keystroke.
            const base = server.get(note.id)!
            const link = linkOf(note.link_type, note.link_id)
            return (
              <div key={note.id} data-item={note.id} role="group" aria-label={`Note: ${base.text.trim() || 'empty'}`} className={`bd-note ${note.colour}`} tabIndex={0}
                style={{ left: note.x, top: note.y, width: NOTE_W }}
                onPointerDown={(e) => startDrag(e, base, 'move')} {...dragHandlers} onKeyDown={(e) => onKey(e, base)}>
                <span className="bd-grip" aria-hidden="true" />
                <textarea aria-label="Note text" value={note.text} maxLength={1000} rows={3} readOnly={archived} placeholder="Write an idea…"
                  onChange={(e) => edit(base.id, { text: e.target.value })} onBlur={() => commitText(base)} />
                {link && <Link to={link.to} className="bd-link">{link.label}</Link>}
                <span className="bd-foot">{author(note.updated_by ?? note.created_by)}</span>
                {!archived && (
                  <div className="bd-actions">
                    {colours.map((c) => (
                      <button key={c} className={`bd-swatch ${c}`} aria-label={`${colourNames[c!]} note`} aria-pressed={note.colour === c}
                        onClick={() => { if (note.colour !== c) void save(base.id, { colour: c }) }} />
                    ))}
                    <button onClick={() => setLinking({ itemId: note.id, type: note.link_type ?? '', target: note.link_id ?? '' })}>Link</button>
                    <button className="bd-x" aria-label="Remove note" title="Remove note" onClick={() => void archive(base)}>×</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
      <p className="small muted">Drag a note by its top edge, or a frame by its border or name. Or focus one and use the arrow keys (Shift for bigger steps, Alt to resize a frame). Everyone's changes appear within a few seconds. Removing archives; Undo puts it back.</p>
    </main>
  )
}
