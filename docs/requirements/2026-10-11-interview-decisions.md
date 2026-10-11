# Interview decisions — 2026-10-11

Outcome of the `/grill-with-docs` interview with the workstation owner (2026-10-10 to 2026-10-11), and of comparing it against PRD/TRD v1.0. Every decision below was confirmed by the owner. Where it conflicts with PRD/TRD v1.0, **this log wins**, and the PRD/TRD are revised to match. Vocabulary follows [CONTEXT.md](../../CONTEXT.md); hard-to-reverse decisions are in [docs/adr](../adr/).

## Scope and users

- **D-01** Internal tool for one company: one brand (GML), about seven people across the Marketing Team and the Creative Team. No multi-tenancy, no workspace or brand memberships, no viewer role ([ADR 0005](../adr/0005-single-company-no-multi-tenancy.md)). Brand is a plain field on each Creative.
- **D-02** Everyone signed in can see everything: briefs, files, comments, performance.
- **D-03** Roles: each person is Marketing or Creative. One or more marketers carry an **Approver** flag; only an Approver can approve. *Proposed default, not interviewed:* an Admin flag for managing members, the Meta connection, WhatsApp settings and Breakdown settings.
- **D-04** Sign-in with company Google accounts; fall back to email magic links if the company does not use Google Workspace.
- **D-05** The workstation is a separate system from the Video Orchestrator, in its own repository, with no import bridge in V1 ([ADR 0003](../adr/0003-workstation-is-separate-from-the-orchestrator.md)). If they are linked later, the link is the Creative Code.

## Platform

- **D-06** Hosted on a new Supabase project: Postgres, Auth, Storage and scheduled jobs ([ADR 0001](../adr/0001-supabase-hosts-the-creative-workstation.md)). Not the unrelated `socialflow` project. The paid plan is expected, since the free plan's per-file limit is too small for video.
- **D-07** Storage holds only what Marketing reviews and approves (review and final files). The Creative Team's working files stay wherever they edit and are linked from the Variant. Follow-up on 2026-10-11: the owner confirmed the team already uses Google Drive. Use the existing Drive location for working-file links; whether it is a Shared Drive or a shared My Drive folder remains to be confirmed. This does not change the review/final-file storage decision.
- **D-08** Claude gets a read-only database role limited to curated reporting views, not raw tables. The `content-ads-monitor` skill moves from its JSON ledger to these views.

## Creative structure and codes

- **D-09** Hierarchy: **Brief** (Marketing) → one or more **Creatives** → one or more **Variants** → numbered **Versions**.
- **D-10** A different Narrative Style or Format is a different Creative. A different Hook, length or aspect ratio is a Variant of the same Creative.
- **D-11** Creative Code = brand prefix + sequence (`GML-0007`), issued when the Creative is created. A Variant is the code plus a letter (`GML-0007-B`). Codes carry no other meaning and are never reused ([ADR 0002](../adr/0002-creative-codes-carry-no-meaning.md)). This replaces the TRD's `CR-000123`.
- **D-12** Older `GML-TESTI-0007`-style codes stay valid as **Legacy Codes**.
- **D-13** Labels are fixed lists. Each team adds items to its own lists, and renaming or merging an item carries its history.
  - Brief (Marketing): Product, Avatar, Angle, Funnel Stage, optional Initiative.
  - Creative: Format (Marketing), Narrative Style (Creative).
  - Variant (Creative): hook type, length, aspect ratio.
- **D-14** A Creative's and its Variants' labels lock when its first Variant goes live, so analysis cannot drift afterwards.
- **D-15** Avatar is a customer persona. On-screen presenters, if tracked, are a separate list.
- **D-16** The Brief locks when it is handed to the Creative Team. Any change after that is a **Rebrief** (new Brief version), and each Creative keeps the Brief version it followed (adopted from the TRD).
- **D-17** Every Brief has a Marketing Owner. Every Creative has a Creative Owner and a due date (adopted from the TRD).
- **D-18** Production Stages: for video, 叙述方式 → rough cut (粗剪) → fine cut (精剪) → ready; for statics, concept → layout → refinement → ready (adopted from the TRD).
- **D-19** Video, static image and carousel are all in V1. The Hook applies only to video.

## Review and approval

- **D-20** Variant states: in production → awaiting review → changes requested (back to in production) → approved → live → retired, plus **cancelled** for a Variant abandoned before going live. Brief and Creative states are derived from their Variants.
- **D-21** Every Review ends in an explicit Approve or Request Changes. Silence never approves. Review rounds are counted.
- **D-22** Comments attach to an exact Version, optionally at a video timestamp, image position or carousel card. Each is marked **blocking** (必改) or **suggestion** (建议), and the Creative Team resolves it.
- **D-23** An unresolved Blocking Comment stays open on the Variant across Versions and prevents approval. There is no separate Marketing acceptance of each resolution: the Approver's approval accepts them (rejects that part of the TRD).
- **D-24** **Approval Withdrawal** with a reason blocks any new Launch of that Version. Existing live Posts and Ads are unaffected and reported honestly.
- **D-25** A Live Variant's file is frozen. Any change becomes a new Variant letter.

## Launch and matching

- **D-26** V1 records posting and advertising decisions; people execute them in Meta. No publishing, ad creation or budget changes.
- **D-27** A **Launch** is one record ([ADR 0004](../adr/0004-lightweight-launch-tracking.md)):
  - It is either a **Post** (page/account, caption, thumbnail, date) or an **Ad** (ad account, campaign, ad set, ad copy, planned budget).
  - Its status runs planned → live → ended or cancelled.
  - This replaces the TRD's package / confirmation / plan / revision / target / registration / binding chain.
- **D-28** The system generates the ad name `[<variant code>] avatar · angle · narrative`, and the sync matches Ads by the code in the name.
  - The first matched Ad records the Variant's Meta video ID.
  - A later Ad with the same code but a different video becomes a **Mismatched Ad**.
  - An Ad with no recognisable code is an **Untracked Ad**.
  - Both lists are shown for a person to resolve.
- **D-29** Organic Posts are linked by pasting the post link into the Launch.
- **D-30** An Ad that promotes an existing Post links to that Post's Launch, and their numbers are never added together.
- **D-31** A **Dynamic Ad** (several Variants in one ad) is reported at ad level only and excluded from single-Variant ranking (adopted from the TRD).

## Meta data

- **D-32** Read-only Meta Marketing API for ads; Page and Instagram insights for organic Facebook and Instagram posts. Access is through a Business Manager **system user** with read-only permissions, set up once by a Business Manager admin.
- **D-33** Sync every 6 hours. Each day, re-pull the last 28 days (or the attribution window, if longer). Keep raw responses (adopted cadence from the TRD).
- **D-34** First import backfills 6 months.
  - Ads with Legacy Codes create **Legacy Creatives**: no Brief, labels filled in later.
  - Ads with no code go to Untracked.
- **D-35** **Breakdowns** (age, gender, placement and others) are configurable in settings. Age × gender and placement are on by default.
- **D-36** Other platforms (TikTok, Xiaohongshu, YouTube) are entered by hand or through validated CSV import with provenance (CSV adopted from the TRD).
- **D-37** Missing metrics stay null, never zero. The TRD's metric rules are adopted:
  - Compute ratios from summed numerators and denominators; never average ratios.
  - Keep organic, paid and combined scopes separate.
  - Never mix currencies, time zones or attribution windows.
  - Reach is never summed.
- **D-38** A data health page shows last sync, coverage, errors, Untracked Ads and Mismatched Ads (adopted from the TRD).

## Reading results

- **D-39** **Result** is whatever the ad set is optimised for (lead, message, purchase), as Meta reports it. **Cost per Result** is the final judge.
  - Funnel metrics (hook rate, hold rate, CTR, conversion rate) explain *why*.
  - The result type is not hard-coded.
  - Offline/CRM sales are not imported in V1, but ad IDs and `utm_content=<variant code>` are kept so they can be joined later.
- **D-40** Two views, reflecting Meta Andromeda's creative-led delivery:
  - **Combination view:** the Live Variants in one ad set over a period. It shows blended Cost per Result, each Variant's spend share, and diversity across Avatar, Angle, Format, Narrative Style and hook type.
  - **Label view:** results pooled by each label across ad sets.
- **D-41** Low spend share means "Meta didn't pick it", not "it lost". Only a Meta A/B test is a **Controlled Test**; every other comparison is observational. Evidence classes are insufficient evidence, observational, and experiment-supported.

## Learning

- **D-42** An **Optimization Plan** holds:
  - Evidence, frozen when written (adopted from the TRD).
  - A hypothesis.
  - Actions: a new Brief, a new Variant of an existing Creative, or an ad-side change.
  - Owner, priority, due date, and a state (proposed, accepted, in progress, completed, cancelled).
  - A check date and minimum spend.
- **D-43** At the check date both teams record a **Verdict** (confirmed, not confirmed, not enough data), and the Approver records it. Below the minimum spend, the Verdict is automatically "not enough data". There is no universal threshold.

## Notifications and history

- **D-44** Notifications are one-to-one WhatsApp messages through the official WhatsApp Cloud API from a dedicated business number, sent only to the person who must act, plus an in-app **My Tasks** list. WhatsApp group messaging was rejected: the official Groups API requires an Official Business Account and caps groups at about 8 participants.
- **D-45** Every action is recorded in an activity log (actor, time, entity, reason). Notifications and round counts derive from it.
- **D-46** Nothing is hard-deleted; records are archived.
- **D-47** The TRD's engineering rules are adopted, with tenant clauses removed:
  - idempotency keys
  - optimistic locking (two conflicting review decisions: one wins, the other gets a conflict)
  - audit and outbox written in the same transaction
  - file verification (proposed limits: 1 GiB video, 50 MiB image)
  - backup/restore and performance targets

## Execution

- **D-48** Domain commands run as Postgres functions called through Supabase RPC, each doing check → idempotency → lock → validate → write → audit + outbox in one transaction. Reads go through the Supabase client under RLS or through curated views. Supabase Edge Functions (TypeScript) handle only external calls (Meta sync, WhatsApp). There is no separate API server ([ADR 0006](../adr/0006-domain-commands-run-in-postgres.md)). This resolves the former O-01.

## Confirmed defaults (second pass)

The PRD 1.1 revision introduced proposed defaults PD-01…PD-18. The owner confirmed them on 2026-10-11, with the changes noted below. They are now decisions.

- **D-49** (PD-01) The owner is the Admin. The Admin flag manages members and flags, the Meta connection, WhatsApp settings and Breakdown settings.
- **D-50** (PD-02) Any Marketing Team member may Request Changes. Only an Approver may Approve, and one Approver's decision is enough.
- **D-51** (PD-03) Marketing creates at least one Creative (Format, Creative Owner, due date) before hand-off.
  - Either team may add Creatives later, but only the Marketing Team sets or confirms a Creative's Format, and it must be confirmed before the first submission.
  - Narrative Style and the Variant labels are required before a Variant's first submission.
  - After a Rebrief, a never-live Creative may move to the new Brief version; a Creative that has been live keeps its version.
- **D-52** (PD-05, changed) Brief attachments may be uploaded (with a size limit) or linked. This amends D-07: Storage holds review and final files, Brief attachments and CSV import files; the Creative Team's working files are still only linked.
- **D-53** (PD-06) Starting a new Version of an approved, never-live Variant supersedes that approval. An Approval Withdrawal before go-live returns the Variant to in production; after go-live the Variant stays live and no new Launch may use that Version.
- **D-54** (PD-07, PD-08, plus additions) Launch and Variant lifecycle:
  - A Post goes live when its link is pasted; the post ID is resolved in the background, and a failure is flagged on data health.
  - An Ad Launch goes live when the sync matches its Ad. A matched Ad with no planned Launch creates a live Launch marked unplanned.
  - An Ad Launch ends when Meta reports the ad archived or deleted, or when Marketing ends it. A paused ad stays live.
  - **Meta's reality wins:** an Ad observed running is recorded live even if its Version was never approved or was withdrawn, and is flagged on data health. Variants created from Legacy Codes start live.
  - A Live Variant becomes Retired automatically when it has no live Ad and no planned Launch; planning a new Launch returns it to live.
- **D-55** (PD-04) The Marketing Team resolves Untracked and Mismatched Ads and runs CSV imports. A Variant may be cancelled by its Creative Owner or by the Brief's Marketing Owner. An Optimization Plan's state is changed by its owner or an Approver.
- **D-56** (PD-12) Notification routing as tabled in PRD §11; Untracked Ads become one task addressed to the Marketing Team as a whole, with no WhatsApp message.
- **D-57** (PD-13) The minimum spend for a Verdict counts spend on Launches linked to the plan's actions between acceptance and the check date.
- **D-58** (PD-09–PD-11, PD-14–PD-18) Technical defaults:
  - **Statics and carousels:** Meta image hashes stand in for the video ID. A carousel creative carrying one Variant code is not a Dynamic Ad.
  - **Dynamic Ads:** a Launch may be marked Dynamic and list its Variants. An ad whose creative holds several videos, or several images that are not a single-code carousel, is treated as Dynamic.
  - **Legacy Creatives:** each gets a new Creative Code, keeps its Legacy Code as a matching alias, and starts with Variant `-A`.
  - **Formulas:** hook rate = 3-second plays ÷ impressions; hold rate = ThruPlays ÷ 3-second plays; conversion rate = Results ÷ link clicks.
  - **New Breakdowns:** collected from the next sync and the 28-day window; older history needs an explicit backfill.
  - **Variant letters** continue AA, AB… after Z. Carousels follow the static Production Stages.
  - **Sizing and operations numbers** stay proposed.
  - **File verification** runs in an Edge Function, a narrow extension of D-48.
- **D-59** Two exceptions:
  - Files uploaded but never attached to any record are hard-deleted after 30 days; this is the only exception to D-46.
  - CSV import files live in a separate private import area, not with review files.

## Video content metadata follow-up

- **D-60** Store each video's actual content length, transcript and content sections, including Hook, Body, CTA and other sections as needed. Here “stage” means a section inside the video, not the Production Stage (rough cut / fine cut). These records belong to the exact video Version so different edits retain their own content and timing. FR-16 and T-17 describe the design; the detailed annotation defaults remain proposed under PD-23.

## Confirmed defaults (third pass)

- **D-61** The owner confirmed PD-19–PD-22 from PRD §11.3 on 2026-10-11:
  - **PD-19, matching details.** An Ad whose media changes after it was matched becomes a Mismatched Ad. An ad name carrying a Creative Code but no Variant letter is Untracked, with that Creative suggested. A Dynamic Launch's generated name lists every Variant code. Each empty label on a Legacy Creative can be filled once, then locks.
  - **PD-20, Ads that go live without approval.** A sync-created Launch records the Variant's latest submitted Version, or none. The Variant moves to live from any never-live state, including cancelled. An open Review can still be decided, and approving the recorded Version clears the flag.
  - **PD-21, archiving.** A Brief is archived by its Marketing Owner; a Creative by its Creative Owner or the Brief's Marketing Owner; an Optimization Plan by its owner or an Approver; a label item by its owning team; and anything by the Admin. Archiving hides a record but keeps its history, Launches and results, and changes no state.
  - **PD-22, manual results.** The Marketing Team enters results for TikTok, Xiaohongshu and YouTube by hand.

- **D-62** Clarifications confirmed by the owner on 2026-10-11:
  - **Google Drive.** V1 only stores pasted Drive links for working files; there is no Drive file picker and no Drive API connection. Access is governed by Drive's own sharing, so whether the folder is a Shared Drive or a shared My Drive folder does not need answering for V1. This closes the open point in the D-07 follow-up.
  - **Deleting never-attached uploads (D-59).** This runs in an Edge Function, because Supabase Storage files are deleted through the Storage API, not by SQL. It is a narrow extension of D-48, like file verification.
  - **Launch thumbnails.** Thumbnails uploaded for a Launch are stored files, extending D-52's list. They may be added while the Variant is live.

## Open

- **O-02** Setup facts needed before integration:
  - the dedicated WhatsApp number
  - the Business Manager admin
  - the list of ad accounts, pages and Instagram accounts
