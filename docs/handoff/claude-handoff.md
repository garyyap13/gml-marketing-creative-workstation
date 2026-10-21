# Claude continuation handoff — 2026-10-12

## Read first

1. `CONTEXT.md` — canonical vocabulary.
2. `docs/requirements/2026-10-11-interview-decisions.md` — owner decisions, currently through D-65; normally wins over older requirements, subject to the unresolved storage conflict below.
3. `docs/requirements/creative-workstation-prd.md` — product workflows and acceptance criteria, including FR-16 video metadata and FR-17 retrospective.
4. `docs/requirements/creative-workstation-trd.md` — proposed tables, commands and integrations, including T-17 annotations and T-18 retrospective.
5. `docs/adr/` — architecture decisions.
6. `docs/mockups/creative-workstation-retrospective.html` — latest interactive UI concept source.

The historical exploratory specs dated 2026-10-10 are superseded. Do not use their multi-tenant or CR-code model.

## What exists

GitHub repository: https://github.com/garyyap13/gml-marketing-creative-workstation (public, branch `main`). The earlier private repository, https://github.com/garyyap13/creative-marketing-workstation, stopped at the requirements phase on 2026-10-10 and is no longer updated.

Local project: `/Users/gary/Documents/ChatGPT/creative-marketing-workstation`.

At handoff inspection HEAD was `e370946` (`docs: align requirements with owner interview decisions`). Four tracked files had uncommitted changes: CONTEXT.md, decision log, PRD and TRD. This handoff and copied mockup are additional local files. Inspect Git again before any commit; other sessions have also edited these documents. A fresh clone alone may omit this work.

There is no running workstation, application scaffold, database migration or connected Meta/Drive integration in this repository. No Supabase project was provisioned in this conversation. Do not assume Codex connector credentials transfer to Claude.

## Update 2026-10-20: the real Drive connection (B2)

The app, migrations and tests now exist (see CLAUDE.md). B2 replaced the Drive stand-in with a real read-only connection; TRD T-19 "Configuration" has the details.

- `supabase/functions/drive-worker` reads Version file metadata with Drive's `files.get` as the workstation's service account (scope `drive.metadata.readonly`). It signs a JWT with WebCrypto, with no Google SDK. Registering a file queues a `drive_register` job, and the change check queues `drive_check` jobs. The worker reports through the same worker functions the stand-in calls (`record_drive_metadata`, `record_drive_check`, plus the new `fail_drive_registration`).
- Secrets: `DRIVE_SERVICE_ACCOUNT_KEY` and `DRIVE_VERSION_FOLDER_ID`. Locally they live in the gitignored `supabase/functions/.env` (see `.env.example`); on a hosted project, use `supabase secrets set`. The key is written by `node scripts/save-drive-key.ts <downloaded key>`. Never commit or print it, and keep the folder, project and service account IDs out of this public repo.
- Tests and journeys still play the worker through `tests/support/drive.ts` and never call Google. `pnpm drive:smoke "<Drive file link>"` checks the real connection against one file. It resets the local database first.
- Verified 2026-10-20 against one existing video in the real folder. Under `drive.metadata.readonly` Drive returned the SHA-256 checksum, head revision, size, type, dimensions and duration. The file registered as ready, the change check found it unchanged, and a made-up file ID failed as `not_found` while the folder read fine. The team's files are named like `GML VIDEO 203 VER 1.mp4`, not D-69's `<variant code>_v<number>`. Nothing enforces the name, since identity is the file ID, revision and checksum.
- Not built yet: the hosted schedule that runs the worker (B1: every minute or so, plus every 6 hours with `queue_checks`), a "check now" button for `request_drive_check`, and the D-69/D-75 playback test of Drive's preview against a streaming player.

## Update 2026-10-20: Telegram notifications (D-82)

Notifications now start on Telegram (D-82); TRD T-16 has the details. My Tasks is unchanged and stays the full list.

- **Queue.** `work.outbox` is channel-neutral: each row has a channel (`telegram`; `whatsapp` later) and a recipient address, unique per task and channel. `app.notify` queues one Telegram message per personal task whose recipient is an active member with Telegram connected. Untracked Ads stay a team task with no message (D-56). WhatsApp is deferred, not dropped; `core.members` keeps its unused WhatsApp fields.
- **Connecting.** Settings → Telegram → Connect Telegram calls `start_telegram_connection`, which issues a one-time code (15 minutes, only its hash kept) and opens `https://t.me/<bot>?start=<code>`. The worker passes the `/start <code>` to `worker.connect_telegram`, and the bot replies. Members disconnect in Settings (`disconnect_telegram`), with `/stop`, or by blocking the bot; waiting messages are then cancelled. Members see who has connected, never a chat ID.
- **Sending.** `supabase/functions/telegram-worker` (shared code in `_shared/telegram.ts`) checks the bot with `getMe`, polls `getUpdates` locally (a webhook with `secret_token` when hosted), then sends due messages: the task's action and code in plain words with a link to `/tasks/<id>` under `APP_BASE_URL`. 429s wait for `retry_after`, other passing failures back off like jobs, a 403 disconnects the member. A failed message shows on its task in My Tasks and in the Admin's Telegram settings, which also show the bot's username and who has connected.
- **Secrets.** `TELEGRAM_BOT_TOKEN` and `APP_BASE_URL` in the gitignored `supabase/functions/.env` (see `.env.example`), and `TELEGRAM_WEBHOOK_SECRET` on a hosted project. `node scripts/save-telegram-token.ts` writes the token without showing it. The local stack loads function secrets only on `supabase stop && supabase start` from the checkout that holds them, and serves that checkout's functions.
- **Tests.** `tests/support/telegram.ts` plays the worker and a fake Telegram, so tests and journeys never call Telegram. `pnpm telegram:smoke` resets the local database, prints a Connect link for the owner, waits for their Start, then sends one real message from a real task.
- **Still to do: the bot and the live test.** On 2026-10-20 the owner put the Telegram setup on hold and shipped the code ahead of the bot. Nobody has created the bot with @BotFather yet, there is no token, and `pnpm telegram:smoke` has never run against the real Bot API. Until `TELEGRAM_BOT_TOKEN` is set, the worker records `not_configured`, answers `telegram_not_configured` and sends nothing; Settings tells members Telegram isn't set up yet. When the owner is ready: install Telegram, create the bot with `/newbot` (a name such as "GML Studio", a username ending in "bot"), save the token with `node scripts/save-telegram-token.ts` (never in chat), restart the stack from that checkout, then `pnpm telegram:smoke`. Whether Telegram accepts a link to a local `http://127.0.0.1:5173` address in a message is also unchecked until then.
- **Unexplained once:** in one full e2e run the worker's claim found no message just after a Version was submitted, although the message was committed, due and unlocked; repeated loops never reproduced it. The scheduled worker would send it on its next run, and the journey now runs the worker until the message leaves the queue.
- Not built yet: the hosted schedule that runs the worker (B1, every minute or so) and registering the webhook on a hosted project.

## User's workflow

1. Marketing chooses Avatar, Angle and rough material / 初稿 in a Brief.
2. Creative chooses Narrative Style / 叙述方式 and produces rough/fine edits.
3. Marketing reviews and comments on an exact Version.
4. Creative revises; an Approver approves; Marketing plans Posts and Ads.
5. Meta performance is linked to the creative identity for both teams.
6. Both teams conduct 复盘 and plan refinements, then check their outcomes.

One company (GML), approximately seven users. Marketing/Creative teams, an Approver flag and Admin. Database IDs are UUIDs; codes are GML-0007 for Creative and GML-0007-B for Variant. A different narrative style or format creates a Creative; a hook, length or aspect change creates a Variant. Versions are revisions before go-live; changed live media needs a new Variant.

## Architecture baseline

- Supabase Postgres, Auth and scheduled jobs.
- Domain commands through transactional Postgres RPC functions; reads under member RLS / curated reporting views.
- Edge Functions for external operations; no separate API server required by the current architecture.
- Read-only Meta ingestion, code/media matching, separate paid/organic reporting scopes, raw provenance and data health.
- My Tasks plus one-to-one notifications, on Telegram since D-82 (WhatsApp deferred).
- Reporting access for Claude is a future restricted role, not current database access.
- Frontend stack and deployment are not established by the HTML mockup.

## Storage conflict to resolve before implementation

**Resolved 2026-10-12.** The owner chose option A (D-64, D-65, ADR 0007): all Version files, drafts and completed, stay in Drive, with read-only registration and change checks. D-69 / TRD T-19 hold the confirmed details; D-80 confirms the check timing. The original note is kept below for history.

The owner said in this conversation: “all complete stores in google drive.” The current architecture shown to the owner therefore puts completed creative media in Google Drive, with structured metadata in the database. They already use a shared folder in someone's My Drive. No folder link has been supplied.

Older PRD/TRD/ADR text still puts review/final files in Supabase Storage, and decision D-62 describes pasted working-file links only with no Drive API integration. This conflict has not been reconciled in the repository. Do not silently implement final media in Supabase or claim a pasted Drive URL provides immutable version verification or authenticated playback.

Preserve the confirmed requirement that completed files stay in Drive. Review-draft location remains unanswered; clarify it only when needed for implementation. Decide how to retain exact submitted media identity, verify duration/checksum, access previews and detect file changes. Distinguish a link-only V1 from API ingestion. Do not enable public sharing or move existing files without authorization.

A separate Free Supabase organization was discussed; older D-06 expects paid because of video storage limits. No free organization selection or paid provisioning consent was completed. Re-evaluate plan needs after storage is settled.

## Most recent additions

- D-60 / FR-16 / T-17: actual duration, timestamped transcript and Content Sections (Hook, Body, CTA, other) per exact video Version. Distinguish spoken words from on-screen text. Annotation corrections retain prior revisions. Detailed defaults were PD-23, confirmed as D-68 on 2026-10-12.
- D-63 / FR-17 / T-18: joint creative retrospective / 复盘 inside Optimization Plans. Show intent, exact content and results; anchor findings to sections/timestamps; separate observations from hypotheses; link findings to actions and later Verdicts. Preserve frozen baseline metrics and annotation revisions. Detailed defaults were PD-24, confirmed as D-68 on 2026-10-12.
- User asked for improvement ideas. Suggestions included pre-production hypotheses, explicit Variant change tracking, visual annotations, delivery context, a searchable learning library and exact-file protection. These are suggestions, not blanket implementation approval.

## Mockup scope

The copied HTML is a self-contained conversation fragment with three views: Production, Review and 复盘. It uses local sample state only. Section selection changes transcript/visual notes; review resolution enables a simulated approval; an optimization action creates a simulated Variant C on the board. No real video, Drive file, Meta metrics, backend, persistence or notification is connected. Optional host-provided Lucide icons and Tweak controls are not application dependencies. No browser-render or end-to-end validation was performed.

The default view is 复盘 for a fictional GML-0007-B video. Sample spending, leads, dates, owners and dialogue are illustrative. Use its information layout as a design reference; do not treat it as tested production code or as confirmation of unapproved features.

## Suggested next work

1. Read the current working tree and reconcile the storage conflict plus small documentation inconsistencies without losing concurrent changes.
2. Present a milestone implementation plan tied to the PRD acceptance criteria. Keep unresolved external connections separate from work that can be implemented locally.
3. When asked to implement, start with one complete local workflow: Brief → Creative/Variant → Version → Review/approval; then Launch/results; then retrospective findings → actions → Verdict. Include realistic seed data clearly marked as demo data.
4. Implement RLS, command authorization, exact-Version integrity and meaningful acceptance checks alongside those workflows.
5. Configure real Supabase, Drive, Meta and WhatsApp connections only after project/account selection, permissions and any costs are settled. Never use the unrelated OHCRM/socialflow projects as a shortcut.

## Ready-to-paste starting prompt

Read CLAUDE.md and docs/handoff/claude-handoff.md, then the referenced requirements and mockup. Continue this project from the current working tree, preserving uncommitted changes. First reconcile the storage requirements with my instruction that completed creatives stay in Google Drive, identify the remaining decisions that actually block implementation, and propose a milestone plan for building the workstation. Include video duration, transcripts, content sections and the complete 复盘-to-optimization loop. Do not provision paid services or claim integrations are connected.
