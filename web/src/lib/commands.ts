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
    readonly currentRevisionId?: string,
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
  version_not_approved: 'This Version is not approved, so no Launch can be planned for it.',
  approval_withdrawn: 'The approval of this Version was withdrawn. No new Launch can use it.',
  approval_superseded: 'A newer Version replaced this approval. No new Launch can use this Version.',
  labels_locked_after_go_live: 'Labels and Footage are locked now that the Creative has gone live.',
  version_never_live: 'This Version has not been shown yet, so there is nothing to look back at.',
  plan_not_accepted: 'Accept the plan first. That starts the spend window.',
  plan_closed: 'This 复盘 is closed.',
  verdict_recorded: 'A Verdict has already been recorded.',
  before_check_date: 'The Verdict can be recorded from the check date.',
  no_check_date: 'Link a follow-up action first; it sets the check date.',
  below_minimum_spend: 'Spend is below the minimum, so the Verdict is not enough data.',
  verdict_needed: 'Record the Verdict before completing the plan.',
  invalid_transition: 'The plan has moved on. Reload to see where it is.',
  comparator_incompatible: 'Compare with results in the same currency, time zone, attribution and result type.',
  handed_off_use_rebrief: 'This Brief has been handed off. Start a Rebrief to change it.',
  launch_closed: 'This Launch has ended or was cancelled, so its thumbnail can no longer change.',
  already_verified: 'This file has already been checked. Upload it again to replace it.',
  already_matched: 'This ad is already tied to its Variant.',
  launch_not_live: "This Launch isn't live yet. Mark it live first.",
  already_imported: 'This file has already been imported.',
  import_in_progress: 'This file is being imported. Try again in a few minutes.',
  already_withdrawn: 'That entry has already been withdrawn or replaced.',
  dynamic_ad: 'This ad carries several Variants, so it is reported at ad level and not linked to one.',
  board_archived: 'This board is archived, so nothing on it can change.',
  item_archived: 'That was removed from the board.',
}

export function explain(error: unknown): string {
  if (error instanceof CommandError) {
    return (error.reason && reasons[error.reason]) || messages[error.code] || 'Something went wrong. Try again.'
  }
  return 'Something went wrong. Try again.'
}

function toCommandError(message: string, status: number, details: string | null | undefined): CommandError {
  let detail: { fieldErrors?: Record<string, string>; correlationId?: string; currentLockVersion?: number; reason?: string; currentRevisionId?: string } = {}
  try {
    detail = JSON.parse(details ?? '{}')
  } catch {
    detail = {}
  }
  // A signed-out caller is refused before any command runs, without a code (TRD T-04).
  const code = status === 401 ? 'unauthenticated' : message
  return new CommandError(code, status, detail.fieldErrors, detail.correlationId, detail.currentLockVersion, detail.reason, detail.currentRevisionId)
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
