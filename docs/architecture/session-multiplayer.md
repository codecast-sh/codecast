# Multiplayer inside a session (ct-57531)

Two or more people in one session see each other's words before they land, send together, steer one queue, see where the others are reading, and take suggestions from people who may not send. Everything rides two existing rails: the composer presence row and the pending message row. A session with one person in it writes nothing new.

## Presence: `doc_presence`, doc id `compose:<conversationId>`

One row per person, written by `docSync.updatePresence` only while someone else is present (`hooks/useDocPresence.ts`; a link collaborator always announces). Besides `draft_text` the row now carries:

| field | written by | read by |
|---|---|---|
| `user_image` | server, from the user | faces everywhere (`PresenceAvatar`) |
| `can_send` | server, `canSendProductMessage` (the same gate a send checks) | ghost drafts: `false` makes the draft a suggestion |
| `anchor` `{message_id, offset}` | the client, at most twice a second, only when `hasCoPresent` | `ReadingMarks` in the scroll gutter |
| `claims` `[{user_id, text, at, how}]` | `docSync.claimDrafts` by whoever sent or took someone else's draft | that author's composer clears the claimed words and says who took them (`useJointComposer`) |

Surfaces reading presence: `CollabPresenceBar` (one-line strip, "Send together" button), `GhostDrafts` (each other person's full draft at the transcript tail, with accept buttons on suggestions), `ReadingMarks`. Only `useComposerPresence` broadcasts; the others use the read-only `usePresenceRows`.

## Joint turns: `shared/contracts/jointMessage.ts`

A turn written by several people is consecutive `<user-message from="Name">` parts, the same wrapper a single direct send uses, so the agent reads one instruction that names every author. `classify.ts` turns it into one `direct_user` bubble naming all authors and `JointParts` draws each part under its name.

- **Send together** (`lib/jointSend.ts`): the presence strip publishes others' drafts as candidates; the button or ⌘⌥↵ arms the composer, and `MessageInput`'s own submit folds them in (`takeJointSend`), so images, quotes and the pending row behave as for any send. The sender then writes claims (`how: "joint"`).
- A link collaborator's joint send goes through `sendSessionMessage` with `direct`; the server sends it as written only when each part naming someone else matches that person's live draft (`jointTurnVouched`), else wraps the whole body in the sender's name.

## The shared queue: `pending_messages`

`getConversationPendingMessage.inflight` lists every waiting row, from every sender, in queue order (`queue_at ?? created_at`, `convex/lib/sessionQueue.ts`), with the author's name and face, for anyone who can read the session. The web reads it from `pendingMessageStatus[conv].inflight` (registered with `deepFields: ["inflight"]`: the engine skips nested arrays otherwise and a new queued row behind the same head never landed).

- **Queue for later** (⌘↵, both composers) creates a row with `status: "held", queued: true`. Ordinary sends do not release it; `managedSessions.applyAgentStatus` releases queued rows when a turn ends (`releaseQueuedRows`), and "Send now" releases at once. Enter keeps its mid-turn delivery (Claude takes it at the next tool step), by decision sd-462.
- **Reorder** sets `queue_at` between the new neighbours; the daemon's head-of-queue pick (`headOfEachQueue`) uses the same order. **Merge** folds the later row into the earlier as a joint turn and cancels it with `merged_into`.
- Held rows never count as late: the primary row skips them and `inFlightPending` ignores them, so no "unresponsive" banner or auto-resume. They show only in `SharedQueue`, not as transcript bubbles, until released.

## Testing with two people

`cast app as-user` only re-signs the desktop app. Two people in one Chrome: run a second origin (`127.0.0.1` beside `localhost`, separate storage), mint a session with `packages/convex/run.sh verification:mintSession '{"email":…}'`, set the two `__convexAuth*` localStorage keys, and join by share link. Background tabs stall timers and animation frames, so presence heartbeats and reading anchors lag there; a Web Worker clock calling `updatePresence` stands in during a test. Unit tests: `shared/contracts/jointMessage.test.ts`, `web/lib/jointSend.test.ts`, `web/lib/sharedQueue.test.ts`, `web/store/__tests__/sharedQueueSync.test.ts`, `convex/pendingMessages.sharedQueue.test.ts`.
