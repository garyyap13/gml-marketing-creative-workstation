import { CommandError, explain } from '../lib/commands'

// A field's error, tied to its control for screen readers: spread describedBy(error, id) on the control and render
// <FieldError id={id} error={error} /> beside it. Inside a <label> the error is left out of the field's name, so it is
// read once, as the description; pass `standalone` when it sits outside the label and should also be read in place.
export function FieldError({ id, error, standalone }: { id: string; error?: string | null; standalone?: boolean }) {
  return error ? <span id={id} className="error" aria-hidden={standalone ? undefined : true}>{error}</span> : null
}

export const describedBy = (error: string | null | undefined, id: string) =>
  error ? { 'aria-invalid': true as const, 'aria-describedby': id } : {}

// The alert for a form whose field errors show at their fields: any other field errors, then a pointer to the
// highlighted ones; or the general error.
export function formProblem(error: unknown, shownAtFields: readonly string[]): string | null {
  if (!error) return null
  if (!(error instanceof CommandError) || !Object.keys(error.fieldErrors).length) return explain(error)
  const fields = Object.keys(error.fieldErrors)
  const others = fields.filter((field) => !shownAtFields.includes(field)).map((field) => error.fieldErrors[field])
  return [...others, others.length < fields.length ? 'Check the highlighted fields' : null].filter(Boolean).join('. ') + '.'
}
