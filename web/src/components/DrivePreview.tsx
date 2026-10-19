import { useState } from 'react'

// Drive's own embedded preview, the interim player (D-69, D-75). It loads only when asked, plays for people signed
// into a Google account with access to the file, and cannot jump to a time. A portrait preview is a 9:16 frame, as in
// the My Tasks inbox (D-81).
export function DrivePreview({ driveFileId, name, tall = false, shape = 'wide', note }: {
  driveFileId: string; name?: string | null; tall?: boolean; shape?: 'wide' | 'portrait'; note?: string
}) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={['drive-preview', tall && 'tall', shape === 'portrait' && 'portrait'].filter(Boolean).join(' ')}>
        {playing ? (
          <iframe src={`https://drive.google.com/file/d/${driveFileId}/preview`} title={`Drive preview of ${name ?? 'the Version file'}`}
            allow="autoplay; fullscreen" />
        ) : (
          <button className="drive-play" onClick={() => setPlaying(true)}><span aria-hidden="true">▶</span> Play in Drive preview</button>
        )}
      </div>
      <p className="small muted">
        Plays in Drive's player when you're signed into a Google account with access to the file; Safari and iPhone may not play it,
        so <a href={`https://drive.google.com/file/d/${driveFileId}/view`} target="_blank" rel="noreferrer">open it in Drive</a> instead.
        {note && ` ${note}`}
      </p>
    </div>
  )
}
