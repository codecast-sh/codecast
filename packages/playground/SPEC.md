# Playground: multiplayer software you change by talking

Share a link. Anyone who opens it can change the app by chatting, and everyone
sees the change go live in seconds. Every change is a point on a timeline you
can scrub back and forth, and from any point you can fork: a new app with its
own room and its own link.

This document is the source of truth for v1. Product name and visual identity
live in `DESIGN.md` (decided in the design phase). Everything here should
read as "simple, fast, fun, and real software", in that order.

## Principles

1. **Zero friction.** No signup, ever, to look, chat or change. A visitor gets
   an animal character (face + name) on arrival and can adjust it later.
2. **Live is the default.** A change request goes live for everyone the moment
   it is built. There is no review or vote in v1. Undo is the safety net:
   any earlier version can be restored in one click, and restoring is itself a
   new version, so nothing is ever lost.
3. **The app is real software.** The clean app link shows the app full-bleed,
   no chat chrome, fast to load. The room is an overlay you open, not a frame
   the app lives inside of.
4. **Right foundations, small surface.** Immutable versions, a single per-app
   build queue, a runtime boundary that a per-app VM can replace later, and a
   data layer scoped per app. Votes, governance tiers, flags and VMs come later
   and must slot in without rewrites.

## Vocabulary

- **App**: a named thing with a slug, a live version pointer, a room, and data.
- **Version**: an immutable snapshot of the app's files, numbered 1..n per app,
  with the request that produced it, who asked, a one-line summary written by
  the agent, and its parent version. Versions are never edited or deleted.
- **Live version**: the app's pointer. Changes and restores move it forward by
  appending a version; nothing rewinds history.
- **Room**: the app's chat. Visitors talk; the builder agent posts progress and
  results as cards in the same stream.
- **Visitor**: an anonymous identity (id + secret held in the browser), with a
  character (animal avatar key + name). One visitor id across every app.
- **Fork**: a new app whose version 1 copies the files of any version of
  another app, with a copy of the source app's data at fork time, its own room,
  and a `forked_from {app, version}` link shown in both apps.

## What a visitor can do

### Land on the home page
- One big input: "Make something". Submitting creates an app and starts the
  first build; the visitor lands in the room watching it build.
- Below: a gallery of live apps (most active recently), each a live thumbnail
  or a still, its name, how many people changed it, and who is in it now.
- A few starter ideas as one-tap prompts.

### Open an app link `/<slug>`
- The app fills the viewport. It is the live version, and it updates in place
  when a new version goes live (no full reload jank; keep the app's data).
- A small, beautiful affordance in a corner shows who is here (stacked animal
  faces) and opens the room. It must never cover the app's own controls in an
  annoying way and must be draggable or collapsible.
- `/<slug>?room` (or the affordance) opens the room overlay.
- `/<slug>/v/<n>` shows version n, read-only on the timeline, clearly marked.

### Use the room
- A chat panel overlaid on the app (side panel on desktop, bottom sheet on
  mobile), resizable and dismissible. The app stays interactive beside it.
- Presence: who is here now, with faces. Typing indicators.
- Composer: one input. A message is either conversation or a change request.
  The builder decides (see "Triage"), and the composer gives a clear way to
  force either ("Change it" vs "Just chat"), so nobody gets surprised.
- **Point and talk**: a picker button lets you click any element in the app;
  the message carries a reference to it (selector, tag, text, a small snippet)
  and shows a chip; the agent receives it as context.
- Change requests show as a build card in the stream: queued (position N),
  building (live narration of what the agent is doing, files touched),
  live (version number, one-line summary, a "see it" and "undo" action),
  or failed (why, with a retry).
- Everyone in the room sees build cards update in real time.

### Use the timeline
- A timeline strip (in the room, and reachable from the clean link via the
  affordance) shows every version: number, summary, who asked, when, faces.
- Scrubbing or clicking a version shows that version to **you only** (a pill
  says "You're viewing v12 · Back to live"). Others are unaffected.
- From any version: **Restore** (appends a new live version with those files,
  announced in the room) or **Fork from here**.
- Keyboard: left/right to step through versions while the timeline has focus.

### Fork
- Fork from any version: name it (prefilled), get a new app with that code and
  a copy of the data, land in its fresh room. The source app's room gets a
  small note ("Raccoon forked v12 into <name>"), and the fork shows its
  lineage ("forked from <app> v12") with a link back.

### Share
- Copy link buttons for: the clean app link, the room link, a specific version.
- Each app link has good Open Graph metadata (title, summary, image when we
  have one) so it unfurls well in messages.

### Identity
- On first visit: mint visitor id + secret, store in localStorage, register.
  Default character from `defaultCharacterFor(visitorId)`
  (`packages/shared/contracts/sessionCharacter.ts`).
- A small "you" chip opens a picker: choose any of the 24 animals and edit the
  name (`cleanCharacterName`). Names need not be unique; if two people in a
  room share a name, disambiguate visually with the face.

## Architecture

### Packages and reuse
- `packages/playground`: Vite + React 19 app (the shell) and `convex/` (its own
  Convex deployment, project `codecast-playground`, dev deployment in
  `.env.local`). It is a workspace member and imports:
  - `@codecast/shared/contracts/orgAvatars` and `sessionCharacter` for
    characters,
  - the avatar art (`packages/web/components/org/avatars/*.webp`) and the
    `RoleAvatar` component / `lib/orgAvatars.ts` pattern (import or a thin
    local wrapper over the same files, never copies of the art),
  - `KeyCap` (`packages/web/components/KeyCap.tsx`) for keyboard hints,
  - `@platform/agent` (`runAssistant`, `defineTool`, `Type`) for the builder.
- Never edit `packages/web`, `packages/convex` or `platform/` for this product
  except to export something genuinely shared (and then reuse it from both).

### Convex data model (playground deployment)
- `visitors`: secret hash, avatar, name, created/seen.
- `apps`: slug, name, live_version, created_by, forked_from {app_id, version},
  counts (versions, contributors), last_activity_at, budget usage.
- `versions`: app_id, number, parent_number, files manifest (path → storage id
  or inline text + hash), summary, request message id, author visitor, kind
  (build | restore | fork | seed), created_at. Immutable.
- `messages`: app_id, visitor_id or "builder", body, kind (chat | request |
  build card | system note), element reference, build state for cards.
- `builds`: app_id, request message, status (queued | building | live |
  failed), base version, result version, narration log, cost, error.
- `presence`: app_id, visitor_id, last_seen, typing_until, viewing version.
- `app_data`: per-app documents for the runtime data layer (collection, doc
  id, json value, updated_by, updated_at), size-capped.
- Rate limit / budget rows as needed.

All public functions take the visitor id + secret and verify the hash (the
`callGuests.ts` pattern in packages/convex). Never trust a client-sent
visitor id alone.

### Build queue and the builder agent
- One build at a time per app, FIFO, each based on the live version at the
  moment it starts (so builds never conflict). The queue is visible.
- The builder is a Convex action using `runAssistant` with file tools over a
  draft of the base version's files: `list_files`, `read_file`, `write_file`,
  `edit_file` (exact string replace), `delete_file`, and `finish(summary)`.
  It sees the request, the element reference if any, recent room context, the
  version history summaries, and the runtime SDK docs.
- Before committing, the draft must pass validation (every JS/JSX/TS file
  parses and transpiles, index.html exists, size limits). On failure the
  errors go back to the agent to fix, a bounded number of times.
- Narration streams to the build card (throttled writes, like
  `assistant/turns.ts` streams every 250ms).
- Model: the strongest model that keeps a typical small change under ~30
  seconds; check the `claude-api` skill for current ids. Cost ceiling and
  deadline per build; per-app and global daily budgets.
- Triage: a cheap fast model call classifies a room message as change request
  or chat unless the composer forced it. Prompts live in one file, readable.
- First build of a new app starts from a minimal seed template.

### Runtime (how an app version runs)
- An app version is a set of static files: `index.html` plus ES modules
  (`.js`, `.jsx`, `.ts`, `.tsx`, `.css`), and assets. JSX/TS is transpiled at
  commit time (e.g. sucrase, pure JS, runs in a Convex action) and the served
  files are the transpiled ones. npm packages load from esm.sh through an
  import map that pins one React for app and SDK.
- Served from the playground Convex deployment's HTTP actions under
  `/run/<slug>/v/<n>/...` on the `.convex.site` origin (a different site from
  the shell), immutable-cached per version, with
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals
  allow-popups allow-downloads` and no `allow-same-origin`, so an app is an
  opaque origin with no access to the shell or other apps.
- The shell embeds the app in a full-viewport iframe pointing at that URL.
  When the live version changes the shell swaps to the new version smoothly
  (preload the new iframe, cross-fade), so the clean link feels like one live
  app.
- **Runtime SDK** (`/run/sdk`, imported by apps as `playground`): real-time
  multiplayer data and presence that just work:
  - `useCollection(name)` → live array of docs + `insert/update/remove`,
  - `useShared(key, initial)` → a live shared value (like useState for everyone),
  - `usePresence()` → who is in the app now (character faces, names),
    plus `setMyState(obj)` for cursors/game state,
  - `me` → the current visitor's id, name, avatar URL.
  The SDK talks to the playground Convex deployment directly over WebSocket
  (ConvexClient) using the visitor credentials the shell hands it via
  postMessage on load. Writes are stamped server-side with the visitor id.
  Data is scoped to the app (and forks get a copy).
- The SDK also carries the point-and-talk picker (hover highlight + click →
  element reference posted to the shell), active only when the shell asks.
- This boundary (static files + SDK + data API) is what a per-app VM replaces
  later; nothing in the shell may assume more about the runtime than this.

### Safety and limits (v1)
- Rate limits per visitor and per app for messages, builds and data writes.
- Daily budget per app and a global kill switch for builds.
- The builder's system prompt refuses phishing, credential collection,
  malware and hate; the room can report an app (stores a flag; no admin UI).
- Size caps: files per version, bytes per file, data docs per app, doc size.
- No secrets ever reach app code.

## Quality bar

- First paint of the clean link is fast; the app iframe starts loading
  immediately from the cached version URL.
- A typical small change ("make the background blue") is live in well under a
  minute end to end, and the room shows progress every second it takes.
- Two browsers on the same app see each other's messages, presence and new
  versions within a second.
- Works on a phone.
- Typecheck green (`cast check playground`), unit tests for the backend's
  pure logic (versions, queue, validation, triage parsing, identity), and an
  end-to-end script that drives two visitors through create → change →
  live in the other → timeline view → restore → fork.
- Visual design is distinctive and delightful (see `DESIGN.md`), never generic.

## Out of scope for v1 (but keep the seams)
Votes, governance tiers, editor roles, feature flags, per-app VMs, custom
domains, accounts/sign-in, moderation UI, billing.
