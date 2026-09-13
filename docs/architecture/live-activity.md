# Lock Screen Live Activity

One iOS Live Activity per phone shows every live session's work state. The server derives it and pushes it; the phone only hands over the credentials ActivityKit mints.

## The pieces

| Piece | Where | Owns |
|---|---|---|
| Wire contract and merge | `packages/shared/contracts/liveActivity.ts` | The content state shape, the ordering (waiting, failed, done, working), the linger clocks, the change keys |
| Swift twin | `packages/mobile/targets/widget/CodecastActivityAttributes.swift` and its copy in the native module | The same struct, decoded by name (`attributes-type`) |
| Refresh and push | `packages/convex/convex/liveActivity.ts` | Session collection, the pure start / update / end / wait decision, the APNs send |
| Refresh scheduling | `packages/convex/convex/lib/liveActivityRefresh.ts` | One job per user; write sites call it |
| APNs core | `packages/convex/convex/apns.ts` | The provider JWT and the HTTP send, shared with VoIP rings |
| Native module | `packages/mobile/modules/codecast-live-activity` | Streams the push-to-start token and each activity's token to JS; starts locally on phones without push-to-start |
| Widget extension | `packages/mobile/targets/widget` | The Lock Screen strip and the Dynamic Island |
| App hook | `packages/mobile/hooks/useLiveActivity.ts` | Registers tokens, starts locally when the server cannot |

## One classifier

A session's strip status comes from `notifications.deriveConversationVerdict`, the same single row verdict the needs_input push uses and the same `classifyWorkState` the inbox buckets by. `working` reads as working, `needs_input` as waiting, `done` as done. A dead process, an error banner or a session error reads as failed. Parked and blank rows have no place on the strip. Subagents, worktree workers, fleet spawns, schedule runs and hidden rows never reach it, mirroring the push etiquette.

## When a push goes out

Every write that can change the picture schedules a refresh: an agent status transition (`managedSessions`), a pinned state (`conversations.setThreadState`), a kill, the settings switch. The refresh recomputes the picture and decides:

- **start** through the push-to-start token when something is live and nothing runs. A start needs an alert; iOS ignores a start without one.
- **update** through the activity token. A status change is urgent and goes at once at priority 10. Anything else waits for the 15 second interval and rides at priority 5.
- **end** when the strip goes quiet, with a dismissal date so "All clear" lingers a minute.
- **wait** while a start is in flight and the device has not yet reported the activity id.

A self rescheduling sweep runs while anything is on the strip. It catches a linger running out and a heartbeat that stopped, which no write announces.

## Dismissal

When the person swipes the activity away, the app reports the end and the row remembers the status key of that picture. No start goes out for the same picture. A new event, a row entering, leaving or changing status, earns a new strip.

## Phones without push-to-start

iOS 17.2 added push-to-start. On older phones the app subscribes to `liveActivity.currentState` and starts the activity itself when the app is open and the server says it may. The activity's token then reaches the server and pushes drive it like any other. A phone that has handed over a push-to-start token skips that subscription entirely.

## Environments

A development build's tokens only work against the APNs sandbox host. The native module reports `sandbox` for a Debug build and `production` otherwise, and the row carries it, so the send picks the host per phone rather than from a global setting.

## Verifying

- `bun test` in `packages/shared` and `packages/convex` covers the merge, the decision and the refresh against a fake database.
- `npx convex run liveActivity:probeLiveActivityConfig '{}'` sends a start to a bogus token. `BadDeviceToken` proves the key and the topic are accepted.
- The simulator renders the strip through the local start path. Push tokens never arrive on a simulator.
