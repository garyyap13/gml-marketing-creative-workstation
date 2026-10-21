import { useQuery } from '@tanstack/react-query'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { supabase } from '../lib/supabase'

// The workstation's own player for a Version's video (D-83, TRD T-19 "Preview and playback"). It asks the drive-stream
// Edge Function for a playback token, then the <video> element fetches byte ranges of the exact Drive revision the
// Version recorded, so any active member can watch without a Google sign-in, and pins, cues, sections and Findings can
// jump to their time. A portrait video is a 9:16 frame, as in the My Tasks inbox (D-81).

export type VideoPlayerHandle = { seek(ms: number): void }

type Problem = 'revision_gone' | 'file_unavailable' | 'not_configured' | 'not_playable' | 'not_signed_in' | 'unsupported' | 'failed'
const problems: Record<Problem, string> = {
  revision_gone: 'Drive no longer keeps the revision this Version recorded: Drive deletes a replaced revision 30 days after newer content is uploaded. Open in Drive shows what the file holds now.',
  file_unavailable: "Drive can't find this file for the workstation. It may have been deleted, or the Version files folder is no longer shared with the workstation.",
  not_configured: "Playback isn't set up on this workstation yet: the Drive connection or the stream's signing secret is missing.",
  not_playable: "This file isn't a ready video, so it can't be played here.",
  not_signed_in: 'Your sign-in has expired. Sign in again to watch.',
  unsupported: "This browser can't play this video's format. Open it in Drive instead.",
  failed: "The video couldn't be played just now.",
}
const problemFor = (message: unknown): Problem =>
  message === 'revision_gone' || message === 'file_unavailable' || message === 'not_playable' || message === 'not_signed_in' ? message
    : message === 'stream_not_configured' || message === 'drive_not_configured' ? 'not_configured'
      : 'failed'

class PlaybackError extends Error {}

// A token plays for an hour; one fetched in the last 50 minutes is reused when the player opens again.
function usePlaybackSource(fileId: string) {
  return useQuery({
    queryKey: ['playback', fileId],
    staleTime: 50 * 60_000,
    gcTime: 50 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('drive-stream', { body: { file_id: fileId } })
      if (error) {
        const response = (error as { context?: unknown }).context
        const payload = response instanceof Response ? await response.json().catch(() => ({})) : {}
        throw new PlaybackError(problemFor(payload.message))
      }
      return {
        url: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/drive-stream?t=${encodeURIComponent(data.token)}`,
        expiresAt: Date.now() + data.expires_in * 1000,
      }
    },
  })
}

export function VideoPlayer({ ref, fileId, driveFileId, name, width, height, tall = false, shape = 'wide' }: {
  ref?: Ref<VideoPlayerHandle>
  fileId: string
  driveFileId: string
  name?: string | null
  width?: number | null
  height?: number | null
  tall?: boolean
  shape?: 'wide' | 'portrait'
}) {
  const source = usePlaybackSource(fileId)
  const video = useRef<HTMLVideoElement>(null)
  // A jump asked for before the video's length is known, and where to carry on after a new token.
  const pendingSeek = useRef<number | null>(null)
  const resume = useRef<{ at: number; playing: boolean } | null>(null)
  // New tokens fetched since the video last loaded, so a token refused straight away isn't fetched forever.
  const renewals = useRef(0)
  const [problem, setProblem] = useState<Problem | null>(null)
  const url = source.data?.url
  const currentUrl = useRef(url)
  currentUrl.current = url

  const renew = () => {
    const element = video.current
    if (element && element.currentTime > 0) resume.current = { at: element.currentTime, playing: !element.paused }
    renewals.current += 1
    void source.refetch()
  }

  useImperativeHandle(ref, () => ({
    seek(ms: number) {
      const element = video.current
      if (element && element.readyState >= HTMLMediaElement.HAVE_METADATA) element.currentTime = ms / 1000
      else pendingSeek.current = ms
      element?.scrollIntoView({ block: 'nearest' })
    },
  }), [])

  // A token that expires while the video is paused is replaced quietly; during playback, the next refused range does it.
  const expiresAt = source.data?.expiresAt
  useEffect(() => {
    if (!expiresAt) return
    const timer = setTimeout(() => { if (video.current?.paused) renew() }, Math.max(expiresAt - Date.now(), 0))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renew reads only refs and the stable refetch
  }, [expiresAt])

  // The <video> element can't say why a request failed, so ask the stream for the first byte and read its answer.
  const explain = async () => {
    const failed = currentUrl.current
    const code = video.current?.error?.code
    if (!failed) return
    const probe = await fetch(failed, { headers: { Range: 'bytes=0-0' } }).catch(() => null)
    // A newer token has taken over meanwhile.
    if (failed !== currentUrl.current) return
    if (probe?.status === 403 && renewals.current < 2) return renew()
    // The stream answers, so the browser couldn't decode the video, or the network dropped for a moment.
    if (probe?.ok) return setProblem(code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported' : 'failed')
    setProblem(problemFor(probe ? (await probe.json().catch(() => ({}))).message : null))
  }

  const loaded = () => {
    const element = video.current
    if (!element) return
    renewals.current = 0
    setProblem(null)
    if (pendingSeek.current !== null) {
      element.currentTime = pendingSeek.current / 1000
      pendingSeek.current = null
      resume.current = null
    } else if (resume.current) {
      element.currentTime = resume.current.at
      if (resume.current.playing) void element.play().catch(() => {})
      resume.current = null
    }
  }

  const failure = source.error instanceof PlaybackError ? (source.error.message as Problem) : source.error ? 'failed' : problem
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={['player', tall && 'tall', shape === 'portrait' && 'portrait'].filter(Boolean).join(' ')}
        style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}>
        {url && !failure && (
          <video ref={video} src={url} controls playsInline preload="metadata" aria-label={`Video: ${name ?? 'the Version file'}`}
            onLoadedMetadata={loaded} onError={() => void explain()} />
        )}
        {!url && !failure && <p className="small muted">Loading the video…</p>}
        {failure && (
          <div className="stack player-problem" role="alert" style={{ gap: 8 }}>
            <p className="small">{problems[failure]}</p>
            {(failure === 'failed' || failure === 'not_configured') && (
              <button className="small" style={{ justifySelf: 'center' }} onClick={() => { setProblem(null); renewals.current = 0; void source.refetch() }}>Try again</button>
            )}
          </div>
        )}
      </div>
      <p className="small muted">
        <a href={`https://drive.google.com/file/d/${driveFileId}/view`} target="_blank" rel="noreferrer">Open in Drive</a>
      </p>
    </div>
  )
}
