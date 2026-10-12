# Supabase hosts the Creative Workstation

The workstation serves seven people who need logins, a shared database, in-browser video review and a daily Meta sync, none of which the repo's local single-user SQLite can provide. We chose a new Supabase project (Postgres, Auth, Storage and scheduled jobs in one place) over assembling Postgres, auth and file storage from separate providers, accepting Supabase lock-in in exchange for fewer moving parts. It is deliberately separate from the unrelated `socialflow` Supabase project, and it stores the files Marketing reviews and approves, Brief attachments and CSV imports; the Creative Team's working files stay wherever they are edited and are linked from each Variant.

*Amended by [ADR 0007](0007-version-files-stay-in-google-drive.md): Version files, review drafts and completed files alike, stay in Google Drive. Storage keeps Brief attachments, Launch thumbnails and CSV imports.*
