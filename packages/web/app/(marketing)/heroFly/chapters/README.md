# Hero chapters: the contract

The homepage hero is one film in 13 chapters (`../world.ts` SCENES, 88.8s). Each chapter renders the real product's views with fixture data, inside the sandbox (`../sandbox.tsx`). This file is what a chapter builder needs; `../ARCHITECTURE.md` has the reasoning and `../../heroFlythrough.spec.md` the film beat by beat.

## What you own, what you read

A chapter is four files, and its builder owns all four outright. The split keeps every `.tsx` a component-only module, which React Fast Refresh needs and `lib/__tests__/fastRefreshBoundaries.guard.test.ts` enforces: a `.tsx` under app/ exports components and nothing else (no data objects, helpers, hooks or contexts, and no `export default` dodge).

| file | holds |
|---|---|
| `chapters/<id>.tsx` | the chapter's part and flyer **components**, and only components |
| `chapters/<id>.chapter.ts` | `export const chapter: HeroChapter`: those components placed as **parts** into surface **regions**, plus the flyer renderers; this is what `index.ts` loads |
| `chapters/<id>.motion.ts` | `export const motion: ChapterMotion`: beats, typed text, flyers and arcs, as pure data |
| `fixtures/<id>.ts` | the fixture data its views receive, and `entities` for any id it renders as a pill or card |

Read-only for builders (ask the orchestrator for a change, do not edit): `world.ts` (surfaces, regions, camera, scenes), `fixtures/story.ts` (the cast and the cross-chapter cues), `filmClock.ts`, `film.tsx`, `surfaces.tsx`, `sandbox.tsx`, `timeline.ts`, `motion.ts`, `chapters/index.ts`, `chapters/contract.ts`, `fixtures/index.ts`, `HeroFlythrough.tsx`.

App files you split into container and view (ARCHITECTURE.md section 3) are shared with other live sessions: re-read a file right before each edit, edit surgically, never revert or reformat what you did not write, never use git checkout/restore/stash/reset, and do not commit.

## Chapters, surfaces and regions

Region rectangles are in `world.ts` (px from the surface's top-left; on the phone, from the screen's top-left under the notch). The desk is the app's shell: the nav rail on the left (`desk.sidebar`), the open conversation in the middle (`desk.header`, `desk.transcript`, `desk.composer`), and the session list as the one right rail (`desk.list`). A region stacks its parts by `order`, from the top, or from the bottom for `anchor: "bottom"` (a transcript whose newest entry sits on the composer). Parts from several chapters can share a region; the orders below are reserved so they interleave correctly.

| # | id | name | film (s) | camera holds | parts (region, order) | cues it owns (story.ts) |
|---|---|---|---|---|---|---|
| 1 | `inbox` | Inbox | 0 to 7.4 | 2.5 to 6.9 desk | `desk.topbar` 0, `desk.sidebar` 0, `desk.list` 10 (grouped sections; the lead and its workers in Working) | leadLands, leadSelected |
| 2 | `conversation` | Steer | 7.4 to 13.5 | 8.0 to 13.0 desk, in on the conversation | `desk.header` 0, `desk.transcript` 10, `desk.composer` 0 | prompt, testsPass |
| 3 | `fanout` | Fan out | 13.5 to 20.8 | 14.1 to 16.5 desk; 18.3 to 20.3 pair | `desk.transcript` 20, `desk.list` 20 (worker rows), `pairA.header` 0, `pairB.header` 0, `pairA.transcript` 10, `pairB.transcript` 10 | spawnA, spawnB, workerRowA, workerRowB |
| 4 | `phone` | Approve | 20.8 to 29.7 | 21.4 to 23.0 pairA; 24.3 to 26.5 phone; 28.0 to 29.5 both | `pairA.transcript` 15 (permission stack), `pairB.scrim` 0, `phone.main` 0 | permissionAsk, permissionApproved, permissionCleared |
| 5 | `talk` | Talk | 29.7 to 36.6 | 31.0 to 35.7 pair | `pairA.transcript` 20, `pairB.transcript` 20 | messageSent, replySent, forked |
| 6 | `decide` | Decide | 36.6 to 42.2 | 37.5 to 41.5 desk, on the card over the conversation | `desk.side` 0 | decisionAsked, decisionAnswered |
| 7 | `work` | Track | 42.2 to 48.6 | 43.0 to 47.8 board | `desk.transcript` 40 (files the task), `board.main` 0 | taskFiled, taskLands, taskClaimed |
| 8 | `automation` | Automate | 48.6 to 54.5 | 49.5 to 53.7 auto | `auto.main` 0 | triggerFires |
| 9 | `team` | Team | 54.5 to 61.6 | 55.4 to 60.8 team (channel, then the huddle) | `team.main` 0 | |
| 10 | `integrations` | GitHub | 61.6 to 68.0 | 62.5 to 66.9 pr | `pr.main` 0 | prOpened, checksGreen, merged |
| 11 | `publish` | Publish | 68.0 to 74.8 | 69.1 to 73.9 page | `page.main` 0 | published |
| 12 | `memory` | Memory | 74.8 to 82.3 | 75.8 to 78.0 palette; 79.3 to 81.3 blame | `palette.main` 0, `blame.main` 0 | threeWeeks |
| 13 | `remote` | Anywhere | 82.3 to 88.8 | 83.0 to 86.0 desk | `desk.header` 10, `desk.transcript` 60 (the cloud worker's pane over the lead's) | remoteOpen |

A chapter's parts stay mounted for the whole film. Surfaces are reused across chapters (the desk carries chapters 1 to 4, 6, 7 and 13), so a part shows its state for the current time: before its cue it renders nothing (or takes no height) and it enters with a beat; after its chapter it stays in its finished state. Other chapters' changes to what you render arrive as cues in `story.ts` (the API worker's row turns amber at `CUES.permissionAsk` and green at `CUES.permissionApproved`, which the fan-out chapter's row reads; the permission stack lifts the API worker's feed by `ASK_H`).

## The part contract

```ts
// chapters/fanout.tsx: components only
export function WorkerRows({ now }: PartProps) { /* real views */ }
export function SpawnGhost() { /* real view */ }

// chapters/fanout.chapter.ts
import { SpawnGhost, WorkerRows } from "./fanout";
export const chapter: HeroChapter = {
  id: "fanout",
  parts: [{ key: "workerRows", region: "desk.list", order: 20, Component: WorkerRows }],
  flyers: { "fanout.spawnA": SpawnGhost },
};
```

- A part is `ComponentType<PartProps>`, `PartProps = { now: number }`. `now` is the wall clock taken once at mount; every fixture timestamp is `now - offset`, so relative labels read the same on every visit.
- **Film time is not a prop.** Read it with `useFilmTime(select)` from `../filmClock`. On a surface, `t` is that surface's content time: film time until the surface turns face-down at the seam, then 0, so state resets unseen. `select` must return a primitive or a stable reference; it runs every frame and your component re-renders only when the result changes. Derive discrete state (`t >= CUES.permissionAsk ? "needs_input" : "working"`, a typed prefix length, a checks count), never a per-frame float.
- **Continuous motion goes to the driver, not React.** Put `{...fly("<surface>/<id>")}` (from `../filmClock`) on an element and give it beats in your motion file; the driver writes its transform and opacity every frame without a render. Text typed character by character: a `TextBeat` plus `<FlyText id="<surface>/<id>" />` (from `../film`) for plain text, or `useFilmTime((t) => typed(text, t, cue, rate).length)` when a real input or view must render the value.
- Parts render **real app views only**, fed through props or the sandbox seams. No hand-built copies of product UI and no copying a component's JSX: split the component into container and view (ARCHITECTURE.md section 3) and render the view.

## Camera and pacing

Each transit takes the time its distance needs (about 0.9s plus 1s per 1600px of travel, 1.1s to 2.2s; the dives in and out of the overview 1.4s to 1.6s), and `timeline.test.ts` holds every chapter to at least 3s of still camera and every transit to its own endpoints.

The opening deals only the desk and the board face-up; every other surface waits face-down in the overview, its back naming its chapter as the scrubber does, and turns over at `TURN_AT` (`world.ts`): as the camera leaves the hold before its first visit, landed at least 0.5s before the camera arrives. So a chapter opens on its own product, and what the surface shows must be in place before it turns: put the chapter's resting state (its entrance drops) at `readyAt(surface)` (`world.ts`), while the surface is still face-down. `timeline.test.ts` fails a surface that has not landed 0.5s before its first hold, or is still empty 0.3s after the camera sets off for it. Keep the story's events for the hold. A `scrim` region and the `Veil` component (`../film`) step a surface back while the camera frames something beside it.

## The motion contract

```ts
// chapters/<id>.motion.ts
export const motion: ChapterMotion = {
  beats: { desk: [{ id: "fanout.row:api", cue: CUES.workerRowA, preset: "drop", z: 120, rx: -12, y: -16 }] },
  texts: { pairA: [{ id: "talk.cmd", kind: "chars", text: 'cast send jx7f9np "..."', cue: 29.0, rate: 40 }] },
  flyers: [{ id: "fanout.spawnA", cue: 16.0, dur: 0.6, from: regionPt("desk.transcript", 320, 440), to: regionPt("desk.list", 170, 120), ... }],
  arcs: [{ id: "phone.approved", ... }],
};
```

- Pure data: import only `../world`, `../fixtures/story` and your own fixtures. No React, no app modules; the timeline, its tests and the prerender load these files.
- Every id starts with your chapter id and a dot. The element for a beat on the desk is `fly("desk/fanout.row:api")`.
- Presets and easings are in `world.ts` (Preset) and `timeline.ts` (glide, settle, DROP, SETTLE, SNAP); the house entrance is `drop`: z 120 to 160 for a surface-wide card, z 60 inside a small window (the pair), where a taller drop spills past its edges.
- Flyers carry a cause on one surface to its effect on another. Anchor them with `regionPt(region, x, y, z)` or `localToWorld(surface, x, y, z)`, and render each in `chapter.flyers[id]` (a small real view, centred with `-translate-x-1/2 -translate-y-1/2`).

## Fixtures

- Internal ids are `hero-*` and never Convex-shaped, so no fixture can resolve to a real row. Short ids are what a visitor reads, so they look like the product's (`jx7c4mq`, `ct-4182`, `sd-1290`); under the sandbox an id resolves only through the fixtures' `entities`, never a query.
- The shared cast (people, the four sessions, the task, plan, PR, page, hosts) and the prompt live in `story.ts`; use them rather than restating titles.
- Any id your views render as an entity pill or card needs an entry in your `entities` (`{ type, entity }` shaped like that type's `webGet` row). Under the sandbox, an unlisted id resolves to "no access" and renders as plain text; nothing queries.
- Avatars: null or same-origin images only.

## Interaction

- Local state only (`useState` in your part). Put `data-hero-live` on the element whose handler should run; every other click, press and key inside the hero is stopped before it reaches the real handler, and links never navigate or run their own handlers, live or not.
- No `window` or `document` listeners, no key listeners, no autofocus. An input listens only while it has focus.
- Portalled UI (Radix tooltips and popovers, hover cards) renders flat at `document.body`, outside the 3D plane. The sandbox keeps everything that opens on hover shut (`HoverCardsOff`); a new kind of hover portal reads that seam too, and the guard test hovers every element to prove it.
- Keep `pointer-events: none` on OrgGraph, WorkflowGraphView and FaceRow seats.

## The sandbox and the mount policy

Inside the hero, Convex is a stub (queries load forever, writes resolve null), entity pills answer from fixtures, personify is off, the theme is light Classic, reveal bands never mount, links and `useLocation` read a memory router of the hero's own at `/inbox`, and a part that throws leaves its region empty. Still, **never mount a container**: anything that runs a feeder, calls a store action, or adds listeners that act. Specifically never: PermissionStack, ForkMapBox, BrowserPane, DecisionAnswerControls with keys on, GenericListView, GlobalSearch, CommandPalette, NotificationBell, DocumentDetailLayout in edit mode, MessageInput, ChatComposer, RoomThread, TriggerRowItem without `actions`. Never write the real inboxStore, IndexedDB, localStorage or the outbox, and never call real Convex. `../sandbox.guard.test.tsx` mounts every chapter across the whole film and fails on any of these.

## Theme and CSS

- The hero is light Classic for every visitor. `.hero-sandbox` re-declares the light tokens; use `--sol-*` tokens and the `sol-*` Tailwind classes.
- The phone's screen carries `.dark`, so its tokens switch locally.
- Import page-scoped CSS (pr.css, repo.css, chat.css, decisions.css, faces.css, CommandPalette.css, editor.css) from your chapter file, so it loads with your chunk.
- `inbox` and `conversation` are in the first paint and the prerender (`chapters/index.ts`); keep their module graphs light. Every other chapter is its own chunk, loaded when the page is idle.

## Suggested split for four builders

Grouped so no two builders split the same app file:

1. **Desk**: `inbox`, `conversation`, `fanout`, `remote`. Splits: SessionCardView and SectionHeader (GlobalSessionPanel), sidebar primitives and InboxNavRow (Sidebar), ConversationHeaderBar and AgentStatusPill (ConversationView), ComposerShell (MessageInput).
2. **Agents**: `phone`, `talk`, `decide`. Splits: PermissionStackView (PermissionCard), the shared phone permission style spec (mobile PermissionCard), DecisionCompactCardView.
3. **Work**: `work`, `automation`, `integrations`. Splits: TaskRow, KanbanCard and ListRowShell, TriggerRowItem `actions`, WorkflowGraphView `chrome`, and the PR page exports.
4. **People and memory**: `team`, `publish`, `memory`. Splits: RoomThread and NotificationBell exports, PageCard, palette styles and rows, SearchField and SearchResultRow (GlobalSearch; builder 1 uses SearchField once it lands).

Every split is a pure move: the app's markup must stay byte-identical (prove it with `renderToStaticMarkup` before and after, or the component's existing tests).

## Checking your chapter

- Seek in the browser: `window.__heroFly.seek(t)`, or load `/?hero-t=<seconds>` to freeze a frame. Background tabs stall requestAnimationFrame, so always verify by seeking, never by watching. `window.__heroFly.scenes` lists each chapter's start, end and hold.
- `bun test app/(marketing)/heroFly/chapters/contract.test.ts` (files, registry, regions, id prefixes, flyer renderers)
- `bun test app/(marketing)/heroFly/sandbox.guard.test.tsx` (isolation, across the whole film, with every `data-hero-live` element fired)
- `bun test app/(marketing)/heroFly/timeline.test.ts` (seam, purity, framing)
- `cast check web`
