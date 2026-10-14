import { useCallback, useRef, useState } from 'react'

// Form state that, after a successful save, clears only if nothing was typed while the save was in flight.
export function useDraft<T extends object>(empty: T) {
  const [draft, setDraft] = useState<T>(empty)
  const clearIfUnchanged = useCallback(
    (submitted: T) => setDraft((current) => (JSON.stringify(current) === JSON.stringify(submitted) ? empty : current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  return [draft, setDraft, clearIfUnchanged] as const
}

// One idempotency key per form until a save succeeds, so retrying after a network failure cannot create a
// duplicate (TRD T-03 step 4).
export function useFormKey() {
  const key = useRef(crypto.randomUUID())
  return { key: () => key.current, renew: () => { key.current = crypto.randomUUID() } }
}

// After a conflict, starts an edit form again from the latest saved values while keeping each field this person had
// changed from the values the form opened with, so saving again applies only their changes on top.
export function rebase<T extends Record<string, unknown>>(form: T, opened: T, latest: T): T {
  return Object.fromEntries(Object.keys(form).map((key) => [key, form[key] === opened[key] ? latest[key] : form[key]])) as T
}
