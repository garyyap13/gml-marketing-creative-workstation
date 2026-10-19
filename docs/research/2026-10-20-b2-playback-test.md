# B2 playback test: Drive's preview vs the workstation's own player — 2026-10-20

D-69 and D-75 left the in-app player to a test during the Drive integration (B2). This compares the interim player, Drive's embedded preview, with a prototype that streams the Version file through an Edge Function into the workstation's own `<video>` player. The prototype is on branch `claude/playback-test-b2` and is not approved for use.

## What was tested

- **File:** one real Version file from the team's Video folder: an MP4 of 4.9 MB, 67.7 s, 1080×1080, registered through the real Drive connection. Its IDs stay out of this public repo.
- **Prototype:** `supabase/functions/drive-stream`. A signed-in member asks for a one-hour playback token for a ready video, and row-level security decides whether they may see the file. The `<video>` element then fetches byte ranges with that token. The function reads the exact recorded Drive revision (`revisions.get` with `alt=media` and the browser's `Range` header) as the service account, with the read-only content scope `drive.readonly`.
- **Harness:** `scripts/playback-test.ts` serves one local page with both players side by side. The stream player times its first frame and three seeks (to 0:30, 1:00 and 0:05) itself.
- **Browsers:**
  - the desktop app's browser pane (Chromium), signed into a Google account with access to the folder;
  - Google Chrome, fresh profile, not signed in;
  - Playwright WebKit as an iPhone 15, not signed in;
  - the owner's own Safari on the Mac.

## Results

| | Drive's embedded preview | Workstation stream |
|---|---|---|
| Chrome, signed in (app's browser pane) | Poster shows; after pressing play it spins, then "An unexpected error occurred". The pane isn't a normal Chrome, so treat this as a hint | Plays. First frame 2.1 s |
| Chrome, not signed in | "Sign in to your Google Account. You must sign in to access this content" | Plays. First frame 2.7 s |
| Safari on the Mac (owner's) | "Allow Google Drive access to your necessary cookies": Safari blocks the third-party cookies Drive needs | Plays. First frame 2.8 s |
| iPhone (WebKit, iPhone 15 size) | Same cookie wall | Plays inline. First frame 5.4 s, about 1.2 s of it starting the browser engine |
| Jump to a time (pins, cues, sections, Findings) | Not possible: the player is cross-origin, and a `?t=30` link only produced the error above | Every seek landed exactly: 0:30, 1:00, 0:05 in each browser. 50 ms when buffered, up to 2.3 s for an unbuffered jump |
| Which content plays | Whatever is in Drive now | The exact recorded revision: the streamed bytes matched the registered SHA-256. After the file changes, the old revision plays until Drive purges it 30 days later |
| Who can watch | Anyone signed into Google with access to the file in Drive | Any active workstation member, through a one-hour token; Drive sharing isn't checked per viewer |

Desktop Safari's seek timings weren't recorded, because Safari pauses video in a window that isn't on screen. The WebKit runs cover Safari's engine.

## Cost and limits of the stream

- **Per watch (first frame plus three seeks):** 1.07–1.47× the file's size went out through the function (5.3–7.3 MB), in 3–13 requests.
- **Function time:** Drive answered each range request in about 0.8 s, and the longest request took 1.4 s. No request came near the CPU or wall-clock limits.
- **Supabase limits:** Edge Functions run up to 150 s on Free and 400 s on paid plans, with 2 s of CPU per request. Egress is included up to 5 GB on Free and 250 GB on Pro, then $0.09 per GB. Invocations are included up to 500,000 on Free and 2 million on Pro.
  - At 300 watches a month of a 10 MB video, the stream uses about 4 GB and 3,000 invocations. That fits Free, and is about 2% of Pro's egress.
- **Not measured:** a large file near the 1 GiB limit. Checking every chunk in JavaScript could approach the 2 s CPU limit, so a real build pipes Drive's response straight through, and is checked on the hosted project with the team's largest real file.
- **Drive quotas:** Google's download guide documents no download quota. Drive does refuse files downloaded very heavily; at this team's scale that is unlikely, but unverified.

## What changes if the stream is adopted

- **Scope:** the stream needs `drive.readonly` (content) in addition to the worker's `drive.metadata.readonly`. It is still read-only, and still limited to what the folder shares with the service account.
- **Who may watch:** T-19's "members view files under Drive's own sharing" becomes "members watch Version videos in the workstation". The Video folder is already shared with the team, so in practice the audience is the same.
- **Build work:**
  - a dedicated token-signing secret, replacing the prototype's key derived from the project's secret key;
  - the player wired into the review canvas, the Video content page, the 复盘 and the My Tasks inbox, with seeking from pins, cues, sections and Findings;
  - journeys served by a local stand-in video, never by Google;
  - D-75's interim player and T-19 "Preview and playback" updated.
  - "Open in Drive" stays as a link.

## Recommendation

Adopt the workstation's own streaming player for Version videos. Drive's preview didn't play in any browser tested here. It needs a Google sign-in plus third-party cookies, which Safari and iPhone block. A normal Chrome signed into Google probably plays it, as D-75 assumed, but even then it can't seek. The stream played and seeked exactly everywhere, plays the exact reviewed revision, and costs little at this team's scale. The price is the wider read scope (content, still read-only), which the owner decides.
