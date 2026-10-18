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
- My Tasks plus one-to-one WhatsApp notifications; no messages have been sent from this conversation.
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
