// A field's error, tied to its control for screen readers: spread describedBy(error, id) on the control and render
// <FieldError id={id} error={error} /> beside it. Inside a <label> the error is left out of the field's name, so it is
// read once, as the description; pass `standalone` when it sits outside the label and should also be read in place.
export function FieldError({ id, error, standalone }: { id: string; error?: string | null; standalone?: boolean }) {
  return error ? <span id={id} className="error" aria-hidden={standalone ? undefined : true}>{error}</span> : null
}

export const describedBy = (error: string | null | undefined, id: string) =>
  error ? { 'aria-invalid': true as const, 'aria-describedby': id } : {}

