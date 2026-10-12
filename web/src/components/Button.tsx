import type { ButtonHTMLAttributes } from 'react'

// While busy the button stays focusable (aria-disabled rather than disabled), so keyboard users keep their place.
export function Button({ busy, onClick, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      className={className}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) return event.preventDefault()
        onClick?.(event)
      }}
    />
  )
}
