# Interview decisions — 2026-10-11

Outcome of the `/grill-with-docs` interview with the workstation owner (2026-10-10 to 2026-10-11), and of comparing it against PRD/TRD v1.0. Every decision below was confirmed by the owner. Where it conflicts with PRD/TRD v1.0, **this log wins**, and the PRD/TRD are revised to match. Vocabulary follows [CONTEXT.md](../../CONTEXT.md); hard-to-reverse decisions are in [docs/adr](../adr/).

## Scope and users

- **D-01** Internal tool for one company: one brand (GML), about seven people across the Marketing Team and the Creative Team. No multi-tenancy, no workspace or brand memberships, no viewer role ([ADR 0005](../adr/0005-single-company-no-multi-tenancy.md)). Brand is a plain field on each Creative.
- **D-02** Everyone signed in can see everything: briefs, files, comments, performance.
- **D-03** Roles: each person is Marketing or Creative. One or more marketers carry an **Approver** flag; only an Approver can approve. *Proposed default, not interviewed:* an Admin flag for managing members, the Meta connection, WhatsApp settings and Breakdown settings.
- **D-04** Sign-in with company Google accounts; fall back to email magic links if the company does not use Google Workspace. *Amended by D-70: the team uses personal Gmail, so Google sign-in is limited to invited members, with magic links as a backup.*
- **D-05** The workstation is a separate system from the Video Orchestrator, in its own repository, with no import bridge in V1 ([ADR 0003](../adr/0003-workstation-is-separate-from-the-orchestrator.md)). If they are linked later, the link is the Creative Code.

## Platform

- **D-06** Hosted on a new Supabase project: Postgres, Auth, Storage and scheduled jobs ([ADR 0001](../adr/0001-supabase-hosts-the-creative-workstation.md)). Not the unrelated `socialflow` project. The paid plan is expected, since the free plan's per-file limit is too small for video. *Amended by D-65: Version files no longer go in Storage, so this reason for the paid plan no longer applies, and the plan is re-evaluated before provisioning.*
- **D-07** Storage holds only what Marketing reviews and approves (review and final files). The Creative Team's working files stay wherever they edit and are linked from the Variant. Follow-up on 2026-10-11: the owner confirmed the team already uses Google Drive. Use the existing Drive location for working-file links; whether it is a Shared Drive or a shared My Drive folder remains to be confirmed. This does not change the review/final-file storage decision. *Superseded for review and final files by D-64 and D-65: every Version file stays in Google Drive.*
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
- **D-52** (PD-05, changed) Brief attachments may be uploaded (with a size limit) or linked. This amends D-07: Storage holds review and final files, Brief attachments and CSV import files; the Creative Team's working files are still only linked. *Amended by D-65: review and final files leave Storage.*
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
  - **Google Drive.** V1 only stores pasted Drive links for working files; there is no Drive file picker and no Drive API connection. Access is governed by Drive's own sharing, so whether the folder is a Shared Drive or a shared My Drive folder does not need answering for V1. This closes the open point in the D-07 follow-up. *D-65 adds read-only Drive access for Version files only; working files stay link-only.*
  - **Deleting never-attached uploads (D-59).** This runs in an Edge Function, because Supabase Storage files are deleted through the Storage API, not by SQL. It is a narrow extension of D-48, like file verification.
  - **Launch thumbnails.** Thumbnails uploaded for a Launch are stored files, extending D-52's list. They may be added while the Variant is live.

## Creative retrospective follow-up

- **D-63** Make video duration, transcript and Content Sections usable for joint Marketing and Creative retrospective analysis (复盘). Bring the exact content together with its performance, record what to keep and improve, and turn findings into an Optimization Plan with follow-up actions and a later Verdict. Extend the existing learning loop (D-42–D-43), rather than introducing a second approval or plan lifecycle. FR-17 captures the requirement; T-18 / PD-24 propose the implementation details.

## Creative media storage

- **D-64** Completed creative files stay in Google Drive. The owner stated this and confirmed it on 2026-10-12. The team already keeps them in a shared folder in one member's My Drive. The workstation does not move them, change their sharing or make them public. This supersedes the review/final-file part of D-07 and D-52, and of [ADR 0001](../adr/0001-supabase-hosts-the-creative-workstation.md).
- **D-65** The owner chose option A on 2026-10-12 ([ADR 0007](../adr/0007-version-files-stay-in-google-drive.md)):
  - Every submitted Version's file, drafts and completed alike, for video, static image and carousel, is a specific file in the team's Drive folder. Supabase Storage holds no Version files; it keeps Brief attachments, Launch thumbnails and CSV import files (D-52, D-59, D-62).
  - The workstation reads each Version file through read-only Drive API access and records its identity: Drive file ID, revision, checksum, size, type, dimensions and duration. Submitting the Version freezes that record. A pasted link alone is not accepted as a Version file.
  - A scheduled check re-reads recorded files and flags any that changed, were trashed or can no longer be read. Approval never carries over to changed content; the existing new-Version or new-Variant path applies (D-25, D-53).
  - D-25 now means the recorded file is frozen: the workstation detects changes in Drive but cannot prevent them.
  - Working files stay paste-only links with no API access (D-62).
  - The access mechanism, naming, check timing and playback details were proposed under PD-25; D-69 confirms all but the check timing.

## Confirmed defaults (fourth pass)

The owner accepted the recommended answers on 2026-10-12.

- **D-66** The web client is a Vite + React + TypeScript single-page app. It calls the Supabase client directly, writing through RPC commands and reading under RLS with no server (D-48, ADR 0006), and is styled from the mockup's colour and spacing tokens. Hosting is chosen before deployment. Local development and tests use the Supabase CLI's local stack, which needs Docker Desktop; the owner installs it.
- **D-67** A Brief version may record an optional hypothesis: what the team wants to learn. It is never required for hand-off. A retrospective shows it, plus the hypothesis of the Optimization Plan whose action produced the Brief or Variant; with neither, it shows that none was recorded.
- **D-68** PD-23 (video annotations, FR-16 / T-17) and PD-24 (retrospective, FR-17 / T-18) are confirmed as written. In V1, transcripts are typed or imported from SRT or WebVTT subtitle files exported by the editing tool. There is no automatic transcription, retention-data acquisition or AI diagnosis.
- **D-69** Most of PD-25 is confirmed (T-19):
  - Read-only Drive access is through a Google Cloud service account given Viewer access to the folder. If a Google Workspace policy blocks that sharing, it is raised as a new decision.
  - Each Version has its own Drive file, named `<variant code>_v<number>` (e.g. `GML-0007-B_v2.mp4`). Nobody uploads new content over an older Version's file, and a Drive file backs at most one Version.
  - While a file is flagged as changed, trashed or unreadable, its Version cannot be submitted, approved or used for a new Launch.
  - V1 stays read-only, so the workstation does not keep old Drive revisions from Drive's purge; the flag and recorded identity remain.
  - In-app playback is chosen after testing Drive's embedded preview against an authenticated streaming player, during the Drive integration step.
  - The change check's timing and scope remained proposed under PD-25 until D-80 confirmed them.
- **D-70** The team uses personal Gmail accounts, not Google Workspace. People sign in with Google using their personal Gmail, and email magic links remain as a backup. Only email addresses the Admin has invited can sign in, whichever method they use. Members view Version files in Drive with the same Google login.
- **D-71** Raw footage gets its own code. The owner accepted the recommended answers on 2026-10-12:
  - **Footage** is one batch of raw material, a shoot session or one creator's delivery, kept in one Drive folder.
  - Its **Footage Code** is a separate meaningless sequence: `RAW-0001`, `RAW-0002` and so on. It has no brand prefix, so it can never be mistaken for a Creative, Variant or Legacy Code in ad names (ADR 0002). The brand prefix may not be `RAW`.
  - A Variant can use several Footage items, and Footage can be reused across Variants and Creatives. A Variant's Footage locks at go-live, like its labels (D-14).
  - Either team adds Footage, recording a title, the source (own shoot, creator, stock or product shots), the date, the on-screen presenter (D-15) and the Drive folder link. The folder is only a link and is never checked (D-62).
  - Creator footage may carry an optional usable-until date. Planning a Launch past it shows a warning (M2).
  - Results and 复盘 can later be read by Footage, like the other labels.
- **D-72** When a Variant retires. The owner accepted the recommended answers for milestone A3 on 2026-10-13:
  - A Variant that has gone live stays live while any of its Launches, Post or Ad, is live or planned. It retires once every Launch has ended or been cancelled, and planning a new Launch brings it back. A paused ad still counts as live. This replaces D-54's literal "no live Ad and no planned Launch", which would retire a Variant the moment its only Post went live.
  - Pages and ad accounts come from the Meta connection (B3); until then a stand-in reports sample accounts, clearly marked as demo data.
  - Launch thumbnails wait for Storage uploads (A1c), which completes AC-06.
  - A3 shows daily paid results for matched Ads. Organic Post results arrive with the Page connection (B3, A5).
- **D-73** Which Meta ad statuses mean an ad has been shown. The owner kept the proposed rule on 2026-10-14:
  - `ACTIVE`, `PAUSED`, `CAMPAIGN_PAUSED`, `ADSET_PAUSED` and `WITH_ISSUES` count as shown, so the ad's Launch is live and its Variant goes live (D-54).
  - An ad still in review, rejected, or waiting on billing is linked to its planned Launch but does not put the Variant live yet.
  - An archived or deleted ad ends its Launch. If it is first seen that way, it is recorded as an ended Launch, so its results are still reported.
  - B3 checks the rule against real accounts and raises any status that does not fit.
- **D-74** The 复盘 loop's open details. The owner accepted the recommended answers for milestone A4 on 2026-10-14:
  - **Verdicts.** On the check date a daily check counts the spend. Below the minimum, the system records "not enough data", and that Verdict is final. Otherwise the plan owner and the Approvers are asked for the Verdict, and an Approver records confirmed, not confirmed or not enough data. No Verdict is recorded before the check date (refines D-43, D-57).
  - **Spend currency.** Only spend in the minimum's currency counts: spend on Launches linked to the plan's actions, from acceptance to the check date. Spend in another currency is listed as not counted and is never converted (D-37).
  - **Findings.** A Finding is one note of one kind. An Observation cites a frozen result. A Hypothesis may point at a Content Section or a time range. Each is marked keep, change or test. A section can only carry a Hypothesis, because ad-level results do not measure sections. A correction adds a new note that supersedes the old one.
  - **Follow-up Variants.** The plan owner or an Approver turns a Finding into a new Variant of the baseline's Creative. It is derived from the baseline and starts with its labels, which the Creative Team can change before go-live. The action owner gets a task, and the board marks the Variant "From 复盘".
  - **Plan states.** The owner or an Approver accepts a plan, which starts the spend window. The first linked action moves it to in progress. Completing needs a Verdict and a summary; cancelling needs a reason.
  - **Evidence in A4.** The baseline Variant's paid results for chosen dates, plus an optional comparator Variant whose currency, attribution, result type and time zone match. The Version, its file checksums and its annotation revision are frozen automatically. The evidence class is "insufficient evidence" (forced when there is no data) or "observational"; Controlled Tests wait for the Meta connection (B3).

- **D-75** Canvas views and the interim player. The owner asked for all four views on 2026-10-14, accepted the recommended answers and chose Drive's embedded preview for now:
  - **Creative canvas.** One read-only map per Creative, laid out automatically from Brief to Creative, Variants, Versions and Reviews, Launches with their results, and 复盘, with the 复盘 pointing to the follow-up Variants it created. It opens from the Creative and Variant pages, and every box opens its record.
  - **Variant wall.** Every Variant as a tile with its labels, state and results, filtered by labels and Footage and sorted by cost per result. Only results of one currency, result type and attribution are compared; others show "not comparable", never a converted number (D-37). Tiles use placeholders until thumbnails exist (A1c uploads, or Drive thumbnails after B2).
  - **Review canvas.** A large player with the Content Sections and comment pins on one timeline and the comments beside it.
  - **Interim player.** Drive's embedded preview plays a Version's video on the review canvas, the Video content page and the 复盘. It needs the viewer signed into a Google account with access to the file, often fails in Safari and on iPhone, and cannot jump to a time, so pins show the time to scrub to. The B2 playback test decides whether the workstation's own streaming player replaces it (D-69).
  - **Whiteboard.** Any number of boards, each optionally attached to a Brief or Creative, holding text sticky notes in a few colours and labelled frames, with links to Briefs, Creatives, Variants, Footage and Findings. Both teams edit any board. Each note saves on its own with a version check and the board refreshes every few seconds; there are no live cursors yet. Removing a note or board archives it. Images wait for uploads (A1c).
- **D-76** The rest of the results (milestone A5). The owner accepted the recommended answers on 2026-10-14:
  - **Scope.** A5 builds three slices: resolving Untracked and Mismatched Ads with data health (A5a), the Combination and Label views (A5b), and manual entry with CSV import (A5c). Legacy Codes and backfill, Breakdowns and organic Post results wait for the Meta connection (B3), because they depend on what real accounts return.
  - **Commits.** Each slice is committed on the working branch once its tests, review and docs pass; nothing is pushed.
  - **Manual results.** For TikTok, Xiaohongshu and YouTube, the Marketing Team enters spend and its currency (when paid), views or impressions, clicks and Results with their type, plus optional reach, likes, comments, shares and saves. Each entry covers a chosen date range and is stored as that period's total, never split into days.
  - **CSV.** Imports start with the workstation's own template, with the same fields and one row per post or ad per period. Mapping each platform's native export follows once the team shares a sample from each platform.
  - **Where it lives.** A Results page with five sections: Ads to resolve, Combinations, Labels, Enter results and Data health. Untracked Ads raise one Marketing Team task (D-56).
- **D-77** PD-26, PD-27 and PD-28 are confirmed as written. The owner confirmed them on 2026-10-14:
  - **Uploads (formerly PD-26).**
    - A Rebrief carries the attachments forward.
    - Attachments may be PDFs, pictures, videos, Office documents, zip files or plain text, and thumbnails JPEG, PNG, WebP or GIF pictures. A file's name must end to match its type.
    - Files are checked straight after upload.
    - Attachments don't change the Brief's lock version.
    - The Variant wall shows the most recently set Launch thumbnail.
    - The never-attached purge waits for B1.
  - **Resolved ads (formerly PD-27).** A resolution wins over the ad's name at later syncs. A linked ad stays with its Variant until its video changes, and a kept-out ad stays out until someone links it.
  - **Combination view (formerly PD-28).** A Live Variant with less than 10% of the ad set's spend is captioned "Meta didn't pick it", and kept-out ads get their own slice.
- **D-78** The deferred polish. The owner accepted the recommended answers on 2026-10-14:
  - **Scope.** Starting a Rebrief and moving a Creative up from the Brief page; replies to review comments; editing members, never leaving the workstation without an active Admin; editing and archiving Footage; the team time zone; reading Windows-1252 subtitle files; loading each page's code only when it opens; and tying field errors to their fields for screen readers.
  - **Team time zone.** "Today" for due dates, Verdict check dates and other team-wide dates is Asia/Kuala_Lumpur's today, and the Admin can change the time zone in Settings. Results entered for an account keep that account's own time zone.
  - **Commits.** Each polish item is committed on the working branch once its tests, review and docs pass; nothing is pushed.
- **D-79** Archiving Footage (formerly PD-29). The owner confirmed on 2026-10-14 that Footage is archived by the member who added it or by the Admin, as a Brief or Creative is archived by its owner (D-61). Archived Footage stays on the Variants that already use it, as history, but can't be added to more.
- **D-80** PD-25, PD-30, PD-31 and PD-32 are confirmed as written. The owner confirmed them on 2026-10-18:
  - **Drive change check (the rest of the former PD-25).** The check runs every 6 hours, and on request from a Version or plan page. It covers the files of Versions under review, approved Versions in effect, Versions of Live Variants and files cited as Evidence. With D-69, every Drive Version file rule is now confirmed.
  - **Legacy Codes (formerly PD-30).** A Legacy Code is the brand prefix, 2–12 letters and up to 6 digits (e.g. `GML-TESTI-0007`), found anywhere in an ad's name, bracketed or not. B3 checks the pattern against the real ad names and raises any that don't fit.
  - **Legacy Creatives (formerly PD-31).** A Legacy Creative found by the backfill is owned by the Admin until someone takes it on, is due the day it was found, and takes the ad's name as its title. Its Legacy Code's Variant is not flagged as live without approval, because its ads predate the workstation: an exception to D-54. Variants added to it later are flagged as usual.
  - **Dynamic Ads (formerly PD-32).** Once a Dynamic Ad has been shown, every Variant its Launch lists goes live and locks its labels, each flagged if its approval isn't in effect. Its results stay at ad level (D-31).

## Interface direction

- **D-81** How the workstation looks and is laid out. The owner compared three mockups on 2026-10-18 and accepted the recommended combination, which uses each one for the job it suits. *Numbered D-81 because D-80 is already taken on the `claude/creative-marketing-workstation-bf7783` branch.*
  - **Overview.** Members land on an Overview after sign-in. It shows the six-step loop as stage tiles with counts, a short "Needs you" list, this week's live Variants by Cost per Result, and data health.
  - **My Tasks.** My Tasks becomes an inbox: the task list on the left and the selected task beside it. A member can watch a Version, comment, and Approve or Request Changes without leaving the list, and keyboard shortcuts move between tasks. Approval still needs every Blocking Comment resolved. The review canvas (D-75) stays as the full-size view.
  - **Creatives.** The Creatives page offers three views of the same Variants. Gallery, the Variant wall (D-75) with 9:16 thumbnails, is the default. Board shows lanes by state, and Table groups rows by Brief. The Creative canvas (D-75) stays.
  - **Look.** Today's green light theme stays (D-66), and a dark theme is used in dark mode. A left sidebar holds the navigation and a Product → Brief tree for finding work. Codes are set in a monospace face.
  - The mockups use sample data. They decide the direction only, not every detail of the build.

## Open

- **O-02** Setup facts needed before integration:
  - the dedicated WhatsApp number
  - the Business Manager admin
  - the list of ad accounts, pages and Instagram accounts
  - ~~the Google Drive folder for Version files and the account that owns it~~ (answered 2026-10-20, below)

*Answered 2026-10-12:* the team uses personal Gmail accounts, not Google Workspace. No Workspace policy limits sharing the Drive folder with a service account (D-69). D-70 settles sign-in.

*Answered 2026-10-20:* Version files live in the team's existing "Video" folder. It has one subfolder per month, and another team account owns it. Its general access is Restricted. A service account in the owner's own Google Cloud project has Viewer access to the folder, and the project has the Google Drive API enabled (D-69). The service account has no key yet; the key is created when the Drive connection is built and is kept only in function secrets. The folder, project and service account IDs are kept out of this public repository.
