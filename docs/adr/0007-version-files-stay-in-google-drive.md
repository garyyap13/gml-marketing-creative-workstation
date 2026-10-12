# Version files stay in Google Drive; the workstation records their identity

The team keeps completed creatives in a shared Google Drive folder, but approval, Launch lineage and frozen 复盘 Evidence all depend on knowing exactly which file a Version is. We keep every Version file in Drive, review drafts and completed files alike, for every Format, and give the workstation read-only Drive API access. It records each file's Drive ID, revision, checksum, size and duration when the file is registered, freezes that record when the Version is submitted, and flags later changes through a scheduled check (D-64, D-65). This supersedes ADR 0001's statement that Supabase Storage holds the files Marketing reviews and approves; Storage keeps Brief attachments, Launch thumbnails and CSV imports.

## Considered options

- **Review drafts in Supabase Storage, approved files copied to Drive.** Rejected: two copies to reconcile, a manual copy step, and video storage that forces a paid Supabase plan.
- **Pasted Drive links only.** Rejected: no checksum, duration or change detection, so exact-Version approval and frozen media identity could not be enforced.

## Consequences

- The workstation can detect edits in Drive but cannot prevent them, and without write access it cannot keep a replaced revision from Drive's 30-day purge.
- Version file durability depends on the Drive account holding the folder, outside the workstation's backups.
- In-app seeking depends on a playback method chosen by test (D-69).
- Video size no longer justifies a paid Supabase plan; the plan is re-evaluated before provisioning.
