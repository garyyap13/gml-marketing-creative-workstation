import { useState } from 'react'

// Drive's own embedded preview, the interim player (D-69, D-75). It loads only when asked, plays for people signed
// into a Google account with access to the file, and cannot jump to a time.
export function DrivePreview({ driveFileId, name, tall = false, note }: { driveFileId: string; name?: string | null; tall?: boolean; note?: string }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className={tall ? 'drive-preview tall' : 'drive-preview'}>
        {playing ? (
          <iframe src={`https://drive.google.com/file/d/${driveFileId}/preview`} title={`Drive preview of ${name ?? 'the Version file'}`}
            allow="autoplay; fullscreen" allowFullScreen />
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
