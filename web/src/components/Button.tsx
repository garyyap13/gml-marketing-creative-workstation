import type { ButtonHTMLAttributes } from 'react'

// While busy, or unavailable for a reason it describes, the button stays focusable (aria-disabled rather than
// disabled), so keyboard users keep their place and hear why; clicking it then does nothing.
export function Button({ busy, onClick, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  const unavailable = busy || props['aria-disabled'] === true || props['aria-disabled'] === 'true'
  return (
    <button
      {...props}
      className={className}
      aria-disabled={unavailable || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (unavailable) return event.preventDefault()
        onClick?.(event)
      }}
    />
  )
}
