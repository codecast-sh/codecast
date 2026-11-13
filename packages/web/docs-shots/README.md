# Docs shots

Every public docs image is the real web app, rendered over the fixture Acme
workspace with no server and no account, captured at 2x, framed, and written
as .webp. No real workspace data can reach an image: the shots server runs on
its own origin, which has never signed in to anything.

## Run it

```bash
packages/web/scripts/docs-shots-dev.sh                      # the shots server on :3290 (tmux docs-shots-web), idempotent
bun packages/web/scripts/docs-shots.ts                      # every shot
bun packages/web/scripts/docs-shots.ts --batch tracking     # one batch
bun packages/web/scripts/docs-shots.ts tasks plan           # by name
bun packages/web/scripts/docs-shots.ts tasks --raw-only     # raw 2x PNGs only, printed, nothing written
```

The script drives your own cast browser tab (it opens one on the shots server
if you have none) and never borrows another session's. Open
`http://127.0.0.1:3290/inbox?shots-theme=dark` to look around by hand.

## Pieces

| What | Where |
| --- | --- |
| The mode (dev only, folds out of production builds) | `lib/docsShots/flag.ts`, `install.ts`, `seed.ts` |
| The world, shared with the phone's store shots | `lib/acmeWorld/world.ts` (core: people, team, sessions, chat, plan, tasks) |
| World parts, one file per surface | `lib/acmeWorld/parts.ts` lists them |
| The offline Convex client | `lib/acmeWorld/convexStub.ts` |
| Shot entries, one file per batch | `docs-shots/batches/*.ts`, listed in `docs-shots/manifest.ts` |
| What each image must show | `docs-shots/shots-desktop.json` |
| Frame page | `docs-shots/frame.html` |

## Adding a shot

One entry in its batch file. `name` is unique (use the doc folder and file,
`decisions/waiting`), `out` is the public path under `packages/web`
(`public/documentation/decisions/waiting.webp`), `route` is an app path, and
`steps` get it into the state (`click`, `rightClick`, `hover` with an optional
`text`, `type`, `key`, `wait`, `js`, `sleep`). `crop` is the window or one
element with padding; `frame` is `window`, `element` or `phone`. Every image
under `public/` that a docs page shows goes through the frame.

## Adding to the world

A screen shows nothing until the world has what it reads. Find out what that
is before writing fixtures:

- `__acmeAsked` in the page console lists every query the screens asked for,
  and whether the world answered it. A query-fed surface needs an answer;
  its own feeder then writes the store, so its loading and ready states
  behave as they do against a server.
- A store-fed surface needs rows written through the store's sync writers
  (`s.syncTable`, `s.syncRecord`, `s.applyTailMessages`), never raw state.
- `__docsShots.place()` says where each session lands in the inbox.

Put a new surface's fixtures in its own part file (`lib/acmeWorld/<surface>.ts`
exporting an `AcmePart`) and add one line to `parts.ts`. A part can add inbox
rows (`sessions`, built with `session()` from world.ts, `owner` for a
teammate's), seed store rows (`seed`), and answer queries (`answers`). Edit
world.ts only for the shared core, and say so to whoever else is working in
it.

Rules the world keeps:

- One story: Acme's engineers making failed webhooks retry. People are Alex
  Rivera (the viewer), Maya Ortiz, Sarah Chen, Jordan Lee and Priya Nair, with
  the faces in `faces.ts`.
- Ids that the app hands to the server must be Convex-shaped: `cid("name")`
  (32 lowercase letters and digits, prefixed `hero`). The app treats any other
  id as an unsent draft, and team-scoped feeds skip any other team id.
- Values must be ones the app accepts (a charter priority is `p0`..`p3`, not
  `high`): read the validator or the component before inventing a field.
- Mobile's Metro reaches `lib/acmeWorld`, so imports there stay relative.
- First-run surfaces (tours, nudges, feature announcements) are dismissed in
  `lib/docsShots/seed.ts` the way a settled account has them. If a new one
  covers a shot, dismiss it there through its real flag.

## When a state does not exist

Some descriptions in `shots-desktop.json` name a state the app cannot show.
Do not build UI for it and do not fake it with injected markup. Capture the
closest honest state and report what differs.
