# Hero fly-through: build spec (ct-55800)

The homepage hero (`packages/web/app/(marketing)/page.tsx`, Hero Image section) is an 84 second looping 3D fly-through that renders the **real product UI**: actual app views, fed by sandboxed fixture data, lightly interactive during holds. One world, one camera, one timeline, one story. A visitor who watches it once understands the whole product.

Bar: Apple and Linear launch-page motion. Every hold is face-on and legible, every hand-off between surfaces is a visible cause and effect, and nothing moves without a reason.

Companion documents: `heroFly/ARCHITECTURE.md` (the sandbox, the container/view splits, theme, risks) and `heroFly/chapters/README.md` (the chapter contract builders work to). The numbers below are the ones in `heroFly/world.ts` and `heroFly/fixtures/story.ts`; where this file and the code disagree after tuning, the code wins and this file is updated.

## The story

"Retry failed webhooks" is asked for, fanned out to two workers, steered in chat from a phone, discussed between agents, decided by a person, tracked as a task, automated, talked over with the team, merged, published, and found again three weeks later. The cast (`fixtures/story.ts`):

- People: Ashot (the viewer), Sarah Chen, Maya Ortiz.
- Sessions: the lead **Retry failed webhooks** (claude_code, `jx7c4mq`), **Webhook API half** (codex, `jx7d2wk`), **Dashboard retry UI** (cursor, `jx7f9np`), and the fork **Try fixed backoff** (codex, `jx7gk3t`). Project `~/src/billing`.
- Objects: task `ct-4182` "Retry queue for failed webhooks", plan `pl-312` "Webhook reliability", the decision "Exponential or fixed backoff?", the trigger "Check CI every 4h", PR acme/billing#482 "Retry failed webhooks with exponential backoff", the page codecast.sh/a/webhook-retries "Webhook retry report", `src/billing/retry.ts:42`, channel #eng, hosts linux-host-1 and macbook.
- The prompt: "retry failed webhooks with backoff".

## Globals

- `DURATION = 84`. `POSTER_T = 5.4`: the inbox hold with the lead's row landed and selected, and the prompt in the conversation. Prerender, first client paint and the reduced-motion start all render `frame(POSTER_T)`; the driver starts playing from it, so hydration never jumps. Chapters 1 and 2 are in the first paint and the prerender; the rest load when the page is idle.
- Stage: logical 1280x760 (desktop) or 640x800 (container under 640px). `aspect-ratio` reserves height and one CSS `scale()` fits the stage. `perspective: 1800px`, origin 50% 50%. The outer wrapper is the only clip, outside the 3D tree.
- World: one div, `transform-style: preserve-3d`, camera transform `translateZ(dist) rotateX(pitch) rotateY(yaw) rotateZ(roll) translate3d(-x, -y, -z)`. `dist = 0` renders the focus point at scale 1.0.
- Backdrop: a `var(--sol-bg)` plane at z = -420 with a `var(--sol-bg-highlight)` 32px dot grid. Each surface has a contact shadow (a pre-blurred radial gradient, never `filter: blur`) whose opacity and scale track the surface's lift.
- Only `transform` and `opacity` animate on the driver path. A colour change is two stacked elements cross-fading. State a real view shows (a status, a count, a composer's value) comes from `useFilmTime`, which re-renders only when the derived value changes.
- Sandbox: everything in the stage renders inside `HeroSandbox` (stub Convex, fixture entities, personify off, light Classic, navigation cancelled, errors caught silently). The theme lock keeps `<html>` light Classic on every marketing page, so portalled popovers match.

### Easing kit (`heroFly/timeline.ts`, all pure)

| name | definition | use |
|---|---|---|
| `glide` | cubic-bezier(0.65, 0, 0.35, 1) | camera transits |
| `settle` | cubic-bezier(0.16, 1, 0.3, 1) | camera arrivals, row pushes, UI fades |
| `out` | cubic-bezier(0.4, 0, 1, 1) | exits |
| `DROP` | damped spring w=14, zeta=0.62 (about 7% overshoot, lands in 0.55s) | anything landing |
| `SETTLE` | spring w=10, zeta=0.86 (no visible overshoot, 0.7s) | pops settling into place |
| `SNAP` | spring w=24, zeta=0.72 | dots, badges, button presses, pill pops |

Spring: `x(s) = 1 - e^(-zeta*w*s) * (cos(wd*s) + (zeta*w/wd) * sin(wd*s))`, `wd = w*sqrt(1 - zeta^2)`, `x = 0` for `s < 0`, bent to land on exactly 1 at 2.5s so nothing drifts past a cut or the seam.

House entrance "drop": from `perspective(800px) translateZ(220px) rotateX(-18deg) translateY(-24px)`, opacity 0 to 1 over the first 30%, on `DROP`. Siblings stagger 60ms in reading order. In-surface elements carry their own `perspective()`, so they need no preserve-3d chain and work inside regions that clip.

### Camera model

Catmull-Rom through the hold poses (no dead stops), every transit eased by `camEase`, close to a sine, so no move peaks above about 1.6 times its average speed. A lateral move may add a crest (`dist` pulls back at mid-move) and a roll that starts with the move and settles 150ms before it lands. Each hold drifts (`DRIFT` in world.ts: a 30px push about the box's centre and 1deg of yaw symmetric about its middle, no sideways slide, so a hold lands, breathes and leaves centred). A hold names only its angles and the windows it is about (`sees`); `world.ts` solves its position and distance from the projection so those windows are centred in the film box with the same margins in every shot (80 by 36 stage px; on a phone, centred vertically and aligned by `align` where wider than the frame). The camera never magnifies: a surface smaller than the frame is shown at the frame's size by its own `zoom` (up to 1.25), so the windows beside a hold keep their size and a pan carries them off the side of the page whole. Each move's pull-back is its hold's `crest`, deepened where needed (timeline.ts `crestsFor`) so no window the move shows reaches above or below the box mid-move; a window that would cross near a move's end has left the box by then and fades on its way out. The phone rises into view and sinks away (`rise`), and the move from the pull-back to Talk hands over in place (`handoff`): the phone goes, then the dashboard worker comes. `will-change: transform` is on the world only in transit. `timeline.test.ts` enforces the centring, the scale and angle of each hold, that every move keeps the frame filled, and (with `filmQa.ts`) that nothing in the film changes faster than an eye can follow between two frames at 60fps.

There is no card flip, no card back and no overview: windows appear and leave as themselves. The code (world.ts, timeline.ts) is the source of truth for poses and positions; the tables below are the original plan and are out of date where they disagree.

## World layout

World px; x right, y down, z toward the viewer; `pos` is the surface centre. The route is one loop: out east to the phone and the pair, back to the desk, down to the board, east along the south to automation and the team, up to the pull request, west along the top to the page, down the west side to memory, and home to the desk.

| id | surface | size | pos | rot (x, y, z) | regions (px from top-left) |
|---|---|---|---|---|---|
| `desk` | the desktop app window | 1180x680 | (0, 0, 0) | 0, 0, 0 | `sidebar` 0,0 200x680; `list` 200,0 340x680; `header` 540,0 640x48; `transcript` 540,48 640x512 (bottom-anchored); `composer` 540,560 640x120; `side` 800,64 360x460 (overlay); `inset` 700,430 460x230 (overlay) |
| `phone` | iPhone, mobile app in its light theme (its default) | 300x620, radius 44, bezel | (860, 30, 180) | 0, -16, -2 | `main` 276x572 (the screen under the notch) |
| `pairA` | worker session, Webhook API half | 540x320 | (1500, -250, -100) | 0, -8, 0 | `header` 540x44; `transcript` 0,44 540x276 (bottom) |
| `pairB` | worker session, Dashboard retry UI | 540x320 | (1560, 140, -20) | 0, -8, 0 | same as pairA |
| `board` | tasks and plan | 1000x520 | (80, 900, -20) | 24, 0, 0 (tilted back like paper) | `main` |
| `auto` | triggers and a workflow run | 900x520 | (1400, 980, -60) | 16, -6, 0 | `main` |
| `team` | channel, huddle, org | 980x600 | (2500, 360, -80) | 0, -10, 0 | `main` |
| `pr` | the pull request page | 900x560 | (2400, -800, -120) | -8, -8, 0 | `main` |
| `page` | the published page | 900x560 | (0, -1000, -260) | -10, 0, 0 (pinned at the top) | `main` |
| `palette` | command palette search | 720x420 | (-1380, -160, -100) | 0, 12, 0 | `main` |
| `blame` | a file with session blame | 900x380 | (-1400, 380, -40) | 0, 10, 0 | `main` |
| `label3w` | world text "3 weeks later" | 44px mono | (-760, -560, 260) | 0 | |

A surface is rendered only during the transits either side of a hold that sees it (`Hold.sees`), and fades in and out with the move; everything else is culled with `visibility`.

## Camera keyframes (desktop)

`(x, y, z | pitch, yaw, roll | dist)`. Mobile overrides (`CAMERA_MOBILE`, index-aligned) frame each hold's hero element tighter at about 1.2x and use pitch 48, dist -8000 for the overview.

| hold | t | pose | sees | arriving transit |
|---|---|---|---|---|
| overview | 0.0 to 0.9 | (570, -20, 0 \| 34, -6, 0 \| -5000) | all | |
| inbox | 2.4 to 8.2 | (0, 0, 0 \| 3, -4, 0 \| -40) | desk | glide down, roll peaks -2 |
| conversation | 9.0 to 14.4 | (250, 0, 0 \| 2, -5, 0 \| 80) | desk | ease in |
| fan out | 15.0 to 17.6 | (60, 0, 0 \| 2, -6, 0 \| 0) | desk | ease out |
| workers boot | 18.6 to 20.6 | (1530, -55, -60 \| 0, 8, -1.5 \| -400) | pairA, pairB, phone | crest -600 |
| permission | 21.4 to 23.2 | (250, 120, 0 \| 2, -4, 0 \| 60) | desk | crest -700 |
| phone | 24.2 to 26.6 | (860, 30, 180 \| 0, 16, 2 \| 70) | phone, desk | crest -500, roll +3 |
| payoff | 27.0 to 27.8 | (560, 20, 110 \| 0, 8, 1 \| -560) | phone, desk | pull back |
| talk | 28.8 to 33.6 | (1530, -55, -60 \| 0, 8, -1.5 \| -400) | pairA, pairB | crest -600 |
| decide | 35.0 to 39.6 | (390, -50, 0 \| 2, -4, 0 \| 60) | desk | crest -900, roll +2 |
| track | 41.0 to 46.4 | (80, 780, -40 \| -22, 0, 0 \| -260) | board, desk | crest -1100, roll -3 (the big swoop) |
| automate | 47.8 to 52.6 | (1400, 940, -60 \| -14, 6, 0 \| -100) | auto, board | crest -500 |
| team | 53.8 to 60.4 | (2500, 360, -80 \| 0, 10, 0 \| -80) | team | crest -800, roll +2 |
| GitHub | 61.8 to 67.4 | (2400, -800, -120 \| 8, 8, 0 \| -80) | pr, team | crest -700 |
| publish | 69.0 to 73.4 | (0, -1000, -260 \| 10, 0, 0 \| -80) | page | crest -1200, roll -2 (long pan west) |
| palette | 74.8 to 77.0 | (-1380, -160, -100 \| 0, -12, 0 \| -20) | palette | crest -500, past `label3w` |
| blame | 77.6 to 79.6 | (-1400, 380, -40 \| -2, -10, 0 \| -120) | blame, palette | short glide down |
| anywhere | 80.4 to 81.4 | (340, 205, 0 \| 2, -4, 0 \| 60) | desk | crest -600 |
| overview | 82.3 to 84.0 | same as 0.0 | all | seam |

## Scenes

Scene table (also `window.__heroFly.scenes` and the 13 chapter ticks; a tick seeks to the chapter's hold).

| # | id | tick | start | end | hold | caption |
|---|---|---|---|---|---|---|
| 1 | inbox | Inbox | 0 | 9 | 2.4 | Every agent session, live. Claude Code, Codex, Cursor, Gemini and pi in one inbox. |
| 2 | conversation | Steer | 9 | 15 | 9.0 | Open any session to watch it work, and steer it mid-run. |
| 3 | fanout | Fan out | 15 | 21 | 15.0 | One lead spawns workers, and every session lands in the same inbox. |
| 4 | phone | Chat | 21 | 28 | 21.4 | A worker has a question. Answer it in chat from your phone, and it carries on. |
| 5 | talk | Agents talk | 28 | 34 | 28.8 | Sessions message each other, and fork to try another way. |
| 6 | decide | Decide | 34 | 40 | 35.0 | Agents queue the calls only you can make, with every option priced out. |
| 7 | work | Track | 40 | 47 | 41.0 | Tasks come straight out of the conversation, and agents claim them. |
| 8 | automation | Automate | 47 | 53 | 47.8 | Triggers and workflows keep the work moving while you are away. |
| 9 | team | Team | 53 | 61 | 53.8 | Your team sees the same sessions, talks in the same channels, and huddles live. |
| 10 | integrations | GitHub | 61 | 68 | 61.8 | Pull requests know the sessions behind them, from checks to merge. |
| 11 | publish | Publish | 68 | 74 | 69.0 | Publish a result as a page your team can comment on. |
| 12 | memory | Memory | 74 | 80 | 74.8 | Weeks later, anyone can find why a line of code exists. |
| 13 | remote | Anywhere | 80 | 84 | 80.4 | Sessions run on your laptop, a cloud host or in a browser, all in one place. |

## Chapters

Times are film seconds; named cues are in `fixtures/story.ts`. "Light interaction" is local state behind `data-hero-live`, only during the chapter's hold. Real components are the ones ARCHITECTURE.md section 0 lists; each renders as a view with fixture props.

### 1 Inbox (0 to 9)

- 0.0: the film opens on the whole desk window, already composed (the poster frame is 6.6).
- The desk: sidebar (Inbox with its count, Feed, Tasks, Docs, Workflows; projects), the inbox list with a section header and six sessions from five agents: one working (green ping), one NEEDS INPUT, one DONE, one idle, one unread, one on a cloud host (worktree chip). Timestamps are offsets from mount.
- 2.8: agent icons pulse down the column (`SNAP`, 90ms stagger) so the eye reads "every agent".
- `leadLands` 3.4: the lead's row **Retry failed webhooks** drops in on top; rows below push down on `settle`, 25ms stagger.
- `leadSelected` 4.8: it takes the selection; the conversation pane cross-fades to it.
- Light interaction: hover shows the row's real toolbar; click selects; pin toggles; the InboxViewMenu popover opens.

### 2 Steer (9 to 15)

- `prompt` 5.0 (seen from the poster on): the user prompt "retry failed webhooks with backoff" drops into the lead's transcript.
- 9.0: the camera eases in on the conversation. The header bar shows the title, the working status pill, the model and the viewers' faces.
- 9.4 to 11.6: the assistant reasons (a thinking block), runs `bun test` (a Bash tool block), edits `retry.ts` (an Edit tool block with its inline diff). `testsPass` 12.0: "212 passed".
- 12.6 to 14.0: the composer types a steer from the timeline, "keep the max at 5 attempts", and sends it; the working status line updates.
- Light interaction: the Edit block expands.

### 3 Fan out (15 to 21)

- `spawnA` 15.6, `spawnB` 16.0: two `cast spawn --subagent` command blocks appear in the lead's transcript, and the session constellation pulses.
- Flyers `fanout.spawnA` and `fanout.spawnB`: a card with each worker's title lifts off its spawn block, arcs over the pane divider (z +260) and lands as a subagent row under the lead, `workerRowA` 16.6 and `workerRowB` 16.9, `DROP`; rows below push down.
- 17.6 to 18.6: crest east to the pair. 18.6 to 20.6: both workers boot on their own surfaces: header, the prompt they were handed, first tool call.
- Light interaction: hovering a worker row lights its node in the constellation.

### 4 Chat (19.8 to 29.7)

The code is chapters/phone.motion.ts (`PHONE_AT`); the phone's screen is the codecast iOS app's session screen (components/PhoneSession.tsx, drawn from the same spec, @codecast/shared/render/mobileSessionStyle, as mobile/app/session/[id].tsx), dark, inside the iOS status bar and keyboard.

The pair sits dashboard worker west, API worker east and a step lower; the phone stands east of the API worker, far enough that a hold on it shows the phone alone. Every move in this chapter is a pan that carries windows off the side of the page.

- `question` 20.0: the API worker ends its turn on a question at the foot of its own pane ("Should a 410 Gone count as failed?"); its status goes idle, as the app shows an agent waiting on a reply, and the dashboard worker beside it steps back under a veil.
- Flyer `phone.question` 21.2 to 22.25: the question leaves the pane as the camera sets off east, and lands in the phone's feed as the camera arrives. The phone slides in from the east edge as the workers are carried off the west one. The feed shows what the worker did before (Alex's task, its plan, two tool calls); the composer shows no status while the worker waits.
- 22.8: a tap focuses the field and the keyboard rises, carrying the feed and composer with it; Alex's answer types itself in and is sent (24.42).
- `answered` 24.7: the status turns to Working; the keyboard goes down and the worker's reply streams in word by word, then its `npm test` run and its result.
- 27.0 to 29.3: the camera pulls back west to the phone beside the API worker's pane (the dashboard worker, west of it, stays out of the shot); arc `phone.answered` (`answerDrawn`) draws from Alex's message on the phone to the worker, whose pane shows the same exchange. The move to Talk pans on west, carrying the phone off the east side as the dashboard worker comes in from the west.
- Light interaction: none beyond the real views' own.

### 5 Agents talk (28 to 34)

- 28.8: the camera holds on the pair.
- 29.0 to 29.6: pairA types `cast send jx7f9np "API is on /v2/hooks/retry, schema in the doc"` as a real cast command block.
- Flyer `talk.envelope` at `messageSent` 29.6: the message lifts off pairA and lands on pairB as a "Message from Webhook API half" block, with the doc reference as a real entity pill.
- Flyer `talk.envelopeBack` at `replySent` 31.2: the reply "Retry states are in, staging green" flies back.
- `forked` 32.4: pairB's user prompt shows a fork child, **Try fixed backoff**.
- Light interaction: hovering the pill shows the real hover card with the fixture entity.

### 6 Decide (34 to 40)

- 34.0 to 35.0: crest back to the desk.
- `decisionAsked` 35.4: the decision card drops into the desk's side region: "Exponential or fixed backoff?", three options with cost tags, the context line and the session.
- `decisionAnswered` 37.8: an option is picked (a tap ring, the option highlights) and the card shows the recorded answer.
- Light interaction: clicking an option records it as the answer.

### 7 Track (40 to 47)

- `taskFiled` 40.2: the lead runs `cast task create` and its transcript shows the task pill.
- Flyer `work.task` 40.2 to 41.5: the pill falls on a parabola from the desk to the board as the camera makes the biggest swoop, and at `taskLands` 41.6 unfolds into a new top row: status open, `ct-4182`, the title, the plan pill, an empty assignee, priority high, "now".
- `taskClaimed` 43.0: the assignee flips to the codex worker, the status crossfades to in progress, and the active-session badge appears.
- 44.4: the plan's progress bar advances and its graph lights the next wave.
- Light interaction: clicking status or priority cycles the fixture value.

### 8 Automate (47 to 53)

- 47.8: the automation surface: the trigger row "Check CI every 4h" with its cadence, next fire and health dot, and a workflow graph implement, verify, review gate.
- `triggerFires` 49.0: the fire badge counts down and fires; the run's nodes light up in order with the film; the review gate waits; the thread state reads "Waiting on review".
- Light interaction: Pause and Resume flip locally.

### 9 Team (53 to 61)

- 53.8: the team surface. #eng: Sarah asks about the retry work, an agent replies in the thread (typing indicator first), reactions land.
- 56.0: the face row shows a huddle, with a live caption line from the transcript.
- 58.0: the org chart, with one role card that outlives its sessions; a teammate's cursor glides across.
- Light interaction: reactions toggle; the feed card's more/less toggles.

### 10 GitHub (61 to 68)

- `prOpened` 62.0: PR #482 with its header, the sessions behind it, commits, and checks pending.
- `checksGreen` 64.5: the checks go green one by one.
- `merged` 66.0: the status chip turns merged, and an external event row records it on the task.
- Flyer `integrations.merged` 67.5: the merged chip flies west to the page, where it becomes the page's version chip.

### 11 Publish (68 to 74)

- 69.0: a cast-canvas report (a retry-rate chart) in an assistant block.
- `published` 69.8: `cast publish` turns it into the page card, which unfolds into the published page "Webhook retry report".
- 71.0: two viewer comments drop into the margin; the viewer count pops.
- Light interaction: the page's real comments panel (inside its sandboxed iframe).

### 12 Memory (74 to 80)

- `threeWeeks` 73.5 to 74.7: the camera passes the "3 weeks later" label on its way west; the caption strip reads the chapter's line.
- 74.8: the command palette. Sarah types "webhook retry" (typed from the film); results group into sessions and tasks, with matches highlighted.
- 77.6: the camera drops to the blame view of `src/billing/retry.ts`; line 42 is tied to the fork session **Try fixed backoff** by its blame strip.
- Light interaction: **typing in the palette** filters the fixtures through cmdk; hovering a blame chip lights its lines.

### 13 Anywhere (80 to 84)

- 80.4 to 81.4: the desk's inset: machine chips for macbook and linux-host-1, a tmux attach pill, a browser tab pill over a static screenshot, a `cast computer` command block.
- The seam: the camera eases home to the opening frame with a small pull-back, and the desk window never leaves: over its content a copy of the window as it stands at t=0 (the same views on a clock held at 0, written frame(0) by the driver; surfaces.tsx `SeamGhost`) dissolves in over 1.3s until it covers it wholly, so the film's last frame shows exactly its first and the loop hands from the copy to the live window with nothing changing on screen (timeline.ts `SEAM_GHOST`).

## Flyers and arcs

World-level siblings of the surfaces, each on a quadratic Bezier between two anchors (`regionPt` or `localToWorld`), owned by the chapter that causes them:

| id | cue | from | to | carries |
|---|---|---|---|---|
| `fanout.spawnA`, `fanout.spawnB` | workerRow - 0.6 | desk transcript spawn blocks | desk list worker rows | the new worker |
| `phone.question` | 21.2 | the foot of the API worker's pane | its place in the phone's feed | the worker's question |
| `phone.answered` (arc) | 27.1 | Alex's message on the phone | the API worker's header | the answer |
| `talk.envelope`, `talk.envelopeBack` | messageSent, replySent | pairA, pairB | pairB, pairA | the message and its reply |
| `work.task` | taskLands - 1.4 | the lead's transcript | the board's top row | the task |
| `integrations.merged` | 67.5 | the PR header | the page's version chip | the merge |

## Poster frame

`POSTER_T = 5.4`: the desk, face-on, the whole window: the inbox with the lead's row just landed and selected, and the conversation showing the lead's header and the prompt. It is what crawlers get from the prerender, what the first client paint shows, and where the film starts playing.

## Mobile (container under 640px)

Logical stage 640x800 (`aspect-ratio: 4/5`), the same world and timeline. `CAMERA_MOBILE` frames each hold's hero element tighter. The caption strip under the stage carries the meaning where stage text is small; ticks show dots with only the active name.

## Reduced motion

No flight, flips or drops: each chapter's settled frame (`STILLS`, the end of its last hold), face-on, cross-fading every 5s while playing. Ticks remain buttons.

## Controls, captions, accessibility

- Under the stage (DOM, outside the 3D tree and the sandbox): a pause/play button, 13 chapter ticks with names and a progress bar on the active one (tick dots reuse TourFilm's `DOTS`), and the caption strip (chapter name plus caption, 350ms `settle` crossfade on change).
- Root: `<figure role="group" aria-label="Codecast product tour">` with a visually hidden description of all 13 chapters; the stage is `aria-hidden`.

## Scrub hook

```ts
window.__heroFly = {
  seek(seconds: number): void,  // renders frame(seconds mod 84) synchronously, keeps play state
  pause(): void,
  play(): void,
  duration: 84,
  scenes: [{ name, start, end }, ...], // the 13 rows of the scene table
  get t(): number,
};
```

`?hero-t=<seconds>` renders that time and stays paused; `?hero-reduced=1` previews reduced motion; `?hero-mobile=1` the phone framing. `frame(t)` is pure. Background tabs stall requestAnimationFrame: verify by seeking.

Seek verification points: 0.0, 1.2, 5.4, 11.0, 16.9, 19.6, 22.3, 25.6, 27.4, 31.0, 37.8, 43.0, 50.0, 57.0, 64.5, 71.0, 75.9, 78.6, 80.9, 83.99.

## Risks and rules

1. **Isolation.** Fixture data reaches views only as props or through the sandbox seams; no container is ever mounted. `heroFly/sandbox.guard.test.tsx` mounts every chapter across the whole film and fails on any store, IndexedDB, outbox, dispatch, listener, Convex, `<html>` or localStorage effect.
2. **preserve-3d flattening.** Only the world and the surface wrappers are in the 3D tree; they carry no overflow, filter, clip-path or opacity. Opacity animates on leaves.
3. **Portals and ReactFlow under 3D.** Popovers render flat at `document.body`: open them only in face-on holds and close them on the way out. OrgGraph and WorkflowGraphView sit in fixed, untransformed inner boxes with `pointer-events: none`.
4. **Performance.** Culling by `Hold.sees`, unchanged style writes skipped, one requestAnimationFrame paused offscreen and when hidden, views re-rendered only when a derived value changes, each chapter its own chunk.
5. **Copy truth.** Real wording from the product everywhere. No emdashes.
6. **Real-UI churn.** The film tracks the product by design; a seek capture per chapter (`?hero-t=`) catches visual regressions in review.
