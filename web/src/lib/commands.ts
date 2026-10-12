import { supabase } from './supabase'

// A refused command, mapped from the database's stable error codes (TRD T-04).
export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly fieldErrors: Record<string, string> = {},
    readonly correlationId?: string,
    readonly currentLockVersion?: number,
    readonly reason?: string,
  ) {
    super(code)
  }
}

const messages: Record<string, string> = {
  unauthenticated: 'Your session has ended. Sign in again.',
  forbidden: "Your role can't do that.",
  not_found: 'This no longer exists. Reload to see the latest.',
  conflict: 'Someone else changed this. Reload to see the latest.',
  invalid: 'Check the highlighted fields.',
  throttled: 'Too many requests. Try again in a moment.',
  account_not_created: "The member was invited, but their sign-in account wasn't created. Invite them again to retry.",
}

const reasons: Record<string, string> = {
  open_blocking_comments: 'Resolve the blocking comments before approving.',
  file_changed_in_drive: 'The Version file changed in Drive after it was registered. Submit a new Version.',
}

export function explain(error: unknown): string {
  if (error instanceof CommandError) {
    return (error.reason && reasons[error.reason]) || messages[error.code] || 'Something went wrong. Try again.'
  }
  return 'Something went wrong. Try again.'
}

function toCommandError(message: string, status: number, details: string | null | undefined): CommandError {
  let detail: { fieldErrors?: Record<string, string>; correlationId?: string; currentLockVersion?: number; reason?: string } = {}
  try {
    detail = JSON.parse(details ?? '{}')
  } catch {
    detail = {}
  }
  // A signed-out caller is refused before any command runs, without a code (TRD T-04).
  const code = status === 401 ? 'unauthenticated' : message
  return new CommandError(code, status, detail.fieldErrors, detail.correlationId, detail.currentLockVersion, detail.reason)
}

export async function run<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error, status } = await supabase.schema('api').rpc(name, args)
  if (error) throw toCommandError(error.message, status, error.details)
  return data as T
}

// Calls an Edge Function that wraps a command, mapping its errors the same way.
export async function runFunction<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (!error) return data as T
  const response = (error as { context?: Response }).context
  const payload = response ? await response.json().catch(() => ({})) : {}
  throw toCommandError(payload.message ?? 'unknown', response?.status ?? 0, payload.details)
}

export const newKey = () => crypto.randomUUID()

export const fieldError = (error: unknown, field: string) =>
  error instanceof CommandError ? error.fieldErrors[field] : undefined
