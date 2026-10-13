# Creative Marketing Workstation

Start with `docs/handoff/claude-handoff.md`, then read `CONTEXT.md`, the decision log, PRD and TRD listed there.

## Project state

This repository contains requirements, a UI concept, local Supabase migrations in `supabase/migrations` with database tests in `tests/db` (`pnpm test:db`), and the web app in `web/` with Playwright browser journeys in `tests/e2e` (`pnpm test:e2e`, using the installed Chrome). It does not yet contain any provisioned hosted project or real Google, Drive, Meta or WhatsApp connection; the Drive worker and the Meta connection are test stand-ins, and their accounts and data are demo data. The mockup's sample records and simulated actions are not production functionality.

## Working agreement

- Preserve existing uncommitted changes. Inspect the current tree and diff before editing; do not reset or replace them with GitHub's older copy.
- This is GML's internal workstation for Marketing and Creative, separate from the Video Orchestrator / ContentAI project.
- Use Brief → Creative → Variant → Version. Human codes such as GML-0007-B are distinct from UUID primary keys.
- Preserve the intended six-step loop: brief, production, review/revision, launch, performance, refinement.
- Content Sections (Hook, Body, CTA, etc.) are different from Production Stages (rough cut, fine cut, etc.).
- Tie transcripts, timed sections, review comments and media identity to exact Versions. Preserve annotation revision history and frozen retrospective Evidence.
- Extend Optimization Plans for 复盘; do not invent a parallel approval lifecycle. Ad-level results cannot establish a particular section's effect.
- Storage is settled by D-64/D-65 and ADR 0007: every Version file, drafts and completed, stays in Google Drive, registered through read-only Drive access and checked for changes. Supabase Storage keeps only Brief attachments, Launch thumbnails and CSV imports. The Drive rules are confirmed in D-69 (TRD T-19); only the check timing remains proposed (PD-25).
- The web client is a Vite + React + TypeScript single-page app using the Supabase client directly (D-66). Local development and tests use the Supabase CLI's local stack, which needs Docker Desktop.
- Supabase is the proposed database/auth backend. Do not reuse unrelated Supabase projects. No paid project or transcription provider has been authorized by this handoff.
- V1 records Launches and reads Meta results. People publish and manage ads in Meta; the app does not create ads or change budgets.
- Read relevant current provider documentation before implementing integrations. Keep secrets out of browser code and the repository.
- Keep proposed defaults distinct from owner-confirmed decisions. The previous improvement suggestions and the mockup do not approve every additional feature.

Use the user's current request to determine whether to plan or implement. This file supplies project context; it does not itself authorize deployments, purchases or external messages.
