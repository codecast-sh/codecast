# call-e2e

Test calls end to end with no camera, no screen picker and no person: a synthetic participant publishes generated video into a real LiveKit room, and the other scripts check what the media server sees, what a receiver gets, and which frame a snapshot or recording holds.

The folder has its own `package.json` and is not a workspace member, so `@livekit/rtc-node` stays out of the app's dependencies. Install once, here:

```bash
cd packages/web/scripts/call-e2e && npm install
```

Credentials are `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, taken from the environment or else read once from the Convex prod env and cached in a 0600 file under the per-user temp dir (`livekit.mjs`). Nothing prints them. Needs Node 22.18 or later (it imports the Convex token signer from its `.ts` source) and, for PNGs, ffmpeg.

| Script | What it does |
| --- | --- |
| `publish.mjs <room>` | Joins as a member (`--member <userId>`), a guest (`--guest[=<id>]`) or any identity, and publishes a camera, a screen share and optionally a tone (`--tone`). `--screen-at` / `--screen-for` start and stop the share mid call; `--duration` leaves. `--preview <dir>` writes the slides as PNGs without connecting. |
| `inspect.mjs [room]` | LiveKit's own view: participants, each track's source, size and codec, and the room's egresses with their files. `--wait-for camera,screen_share [--from <identity>]` exits 0 once those are published, 3 on timeout. No room lists active rooms. |
| `grab.mjs <room>` | Joins hidden and saves frames of a live track as a receiver gets them (`--source camera\|screen_share`, `--count`, `--every`), decoding each frame's timecode. |
| `decode.mjs <png\|video\|url>` | Reads the timecode strip out of an image or a recording (`--at <seconds>` seeks), with `--expect <time>` printing the alignment error. |

The full flags are in each script's header.

## The frames

The screen share is a slide in one color per scene. Scenes cut on the wall clock every 10 seconds (at :00, :10, :20 of every minute, the same instants for every publisher), so scene change sampling over a share has exactly one cut to find per 10 seconds and the expected cut times are known in advance. Each slide shows the local time to the tenth in large type, UTC and the date, the frame counter, time since the share began, and a ten box meter of the second within the scene. The camera shows initials on a tile, a square orbiting every 2 seconds, and the clock.

Every frame of both also carries a timecode strip along the bottom: the epoch millisecond it was painted and its frame counter, checksummed, laid out so it decodes after H.264 or VP8, downscaling and letterboxing (cells need to stay about 3px wide). `frames.mjs` holds the layout and its reader together; `node --test` here runs their tests, including one through ffmpeg.

## Recipes

Smoke test a room (about a minute on a loaded machine; joining alone can take 20 to 60 seconds there):

```bash
node publish.mjs call-e2e-scratch-1 --guest=e2e --name "Pat Guest" --duration 120 &
node inspect.mjs call-e2e-scratch-1 --wait-for camera,screen_share --from guest:e2e --timeout 120
```

Join a real huddle as yourself: the room is the huddle's room key (`session:<conversationId>`, `dm:<userA>,<userB>`, `channel:<channelId>`; `packages/shared/contracts/callRoomKeys.ts`), and `--member <yourUserId> --name "<your name>"` makes the participant indistinguishable from your own browser to everyone else in the room. The token is signed with the server secret, so this skips the app's room authorization and the guest knock: it tests the media path, not the admission path.

Check a snapshot's alignment: publish a share into a recorded huddle, then snap a moment and decode it.

```bash
cast call snap cl-42@1:30 --screen          # prints the PNG path
node decode.mjs <that png> --expect 2026-10-02T21:04:30Z
# screen  frame 900  captured 2026-10-02T21:04:30.012Z ...  delta +12 ms
```

The same against the recording file itself: `node decode.mjs <mp4 or presigned url> --at 90`.
