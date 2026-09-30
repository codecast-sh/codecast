# Hero fly-through: build spec (ct-55800)

Replaces `<InboxHeroMock />` in the homepage "Hero Image" section (`packages/web/app/(marketing)/page.tsx`) with a 36 second looping 3D fly-through of the product. One world, one camera, one timeline. Every beat demonstrates one real feature, legibly, and the loop tells one piece of work end to end.

## Verdict on the three storyboards

- **Spine: Storyboard 1 ("The Desk").** One continuous drone flight over a world of flat surfaces, face-on legible holds, cards dealt face-up at the start and face-down at the end so every state reset is hidden. It is the most buildable in CSS 3D, the most legible, and the seam is solved by construction.
- **Grafted from Storyboard 2:** the story order (ask, fan out with `cast spawn --subagent`, a worker needs permission, workers talk, a task is filed, weeks later someone finds why), the caption strip as the legibility carrier on small screens, the palette search with a teammate's query, `cast blame` in its real git-blame format, and the "3 weeks later" world label the camera flies past. Real wording everywhere (Approve/Deny, "Permission Required", "spawned by").
- **Grafted from Storyboard 3:** the causality motif. Things lift *out of* one surface and land *as* another: a spawn block peels off into an inbox row, the amber permission chip flies to the phone and becomes its push banner, the `cast send` envelope becomes a "Message from" card, the TaskPill falls onto the board and unfolds into a row. Also its motion vocabulary (analytic springs named DROP/SETTLE/SNAP) and the rule that the poster frame is the familiar app window.
- **Dropped:** the exploded "Anatomy" view (costly refactor into absolute plates, crowded callouts), Docs as its own beat (the Docs section lower on the page covers it), the phone "allow it, then ship the branch" bubble (the real mobile card has no reply there).

Features shown (7 chapters, one per tick): 1 Inbox for every agent. 2 Fan out (agents spawn workers). 3 From your phone (push + permission). 4 Agents talk (`cast send`). 5 Tasks (filed from chat, claimed by an agent). 6 Memory (search every session, `cast blame` to the conversation). 7 Publish (`cast publish` a cast-canvas report with viewer comments).

## Globals

- `DURATION = 36.0`. `POSTER_T = 5.4` (Inbox hold: new row landed and selected, conversation shows the prompt). Prerender, first client paint and reduced-motion default all render `frame(POSTER_T)`; the driver starts playing from `POSTER_T`, so hydration never jumps.
- Stage: logical 1280x760 (desktop) or 640x800 (mobile, below 640px container width). `aspect-ratio` reserves height; one CSS `scale()` fits the logical stage to the container. Stage: `perspective: 1800px; perspective-origin: 50% 45%`, outer wrapper `overflow: hidden` (the only clip, outside the 3D tree).
- World: one div, `transform-style: preserve-3d`, camera transform:
  `translateZ(dist) rotateX(pitch) rotateY(yaw) rotateZ(roll) translate3d(-x, -y, -z)`.
  `dist = 0` renders the focus point at scale 1.0. Holds keep effective scale of the hero surface between 0.95 and 1.1.
- Backdrop: a large `#fdf6e3` plane at z = -420 with a `#eee8d5` 32px dot grid (radial-gradient) and a soft vignette. Each surface has a contact shadow on that plane: a pre-blurred radial gradient div (#002b36 at 10%), opacity and scale tracking the surface's lift. Never `filter: blur`.
- Only `transform` and `opacity` animate. Colour changes are two stacked elements cross-fading. Typing and counters are pure functions of t written through `textContent`.

### Easing kit (`heroFly/timeline.ts`, all pure)

| name | definition | use |
|---|---|---|
| `glide` | cubic-bezier(0.65, 0, 0.35, 1) | camera transits |
| `settle` | cubic-bezier(0.16, 1, 0.3, 1) | camera arrivals, row pushes, UI fades |
| `out` | cubic-bezier(0.4, 0, 1, 1) | exits |
| `DROP` | damped spring w=14, zeta=0.62 (about 7% overshoot, lands in 0.55s) | anything landing |
| `SETTLE` | spring w=10, zeta=0.86 (no visible overshoot, 0.7s) | card flips at the seam, reassembly |
| `SNAP` | spring w=24, zeta=0.72 | dots, badges, button presses, pill pops |

Spring: `x(s) = 1 - e^(-zeta*w*s) * (cos(wd*s) + (zeta*w/wd) * sin(wd*s))`, `wd = w*sqrt(1 - zeta^2)`, `x = 0` for `s < 0`, clamped to exactly 1 after 2.5s so the seam is exact.

Camera path: Catmull-Rom through keyframe positions (no dead stops), angles interpolated with `glide` per segment. Long lateral moves add a crest: `dist` pulls back by the listed amount at mid-move. Roll leads the turn by 150ms and returns on `settle`. Each hold drifts 12px and 0.4deg yaw across its length (below 1% per second) so it never looks frozen, and returns to integer pixel x/y at the hold midpoint.

House entrance "drop in" (in-surface elements): from `perspective(800px) translateZ(220px) rotateX(-18deg) translateY(-24px)`, opacity 0 to 1 over the first 30% of progress, `DROP`. Siblings stagger 60ms in reading order. In-surface elements carry their own `perspective()` in the transform, so they need no `preserve-3d` chain and work inside surfaces that clip with `overflow: hidden`.

## World layout (world px; x right, y down, z toward viewer)

| id | surface | size | position | rotation |
|---|---|---|---|---|
| `desk` | desktop app window (sidebar, session list, conversation) | 1180x680 | (0, 0, 0) | 0 |
| `phone` | iPhone, mobile app | 300x620, radius 44, #002b36 bezel | (840, 40, 180) | rotY -16, rotZ -2 |
| `pairA` | worker session "Webhook API half" | 500x300 | (1480, -230, -100) | rotY -8 |
| `pairB` | worker session "Dashboard retry UI" | 500x300 | (1540, 150, -20) | rotY -8 |
| `board` | task board | 720x320 | (80, 800, -20) | rotX 24 (tilted back like paper) |
| `palette` | command palette search | 720x380 | (-1360, -120, -100) | rotY 12 |
| `blame` | terminal with `cast blame` | 700x300 | (-1320, 360, -40) | rotY 10 |
| `page` | published page | 780x460 | (0, -880, -260) | rotX -10 (pinned poster at the top) |
| `label3w` | world text "3 weeks later" | 44px mono | (-700, 420, 260) | 0 |

The route is a loop around the desk: desk, phone (E), pair (far NE), board (S, biggest swoop), palette and blame (W), page (N), overview. All numbers are starting values; tune against seek captures. Every surface back face (for the deal) is `#eee8d5`, 1px `#e4ddc8` border, small codecast glyph, chapter name in 13px mono `#93a1a1`.

Cross-surface flyers (world-level siblings of surfaces, in the preserve-3d world): `ghostSpawnA`, `ghostSpawnB`, `ghostPermission`, `envelope`, `envelopeBack`, `ghostTask`. Each flies along a quadratic Bezier in x/y/z between two anchor points given in world coords.

## Camera keyframes (desktop)

`(x, y, z | pitch, yaw, roll | dist)`; holds listed as start to end.

| t | pose | note |
|---|---|---|
| 0.0 | (0, 0, 0 \| 36, -6, 0 \| -3200) | OVERVIEW, whole world |
| 2.4 to 5.6 | (0, 0, 0 \| 4, -5, 0 \| -40) | DESK hold, whole window, slight 3/4 |
| 6.3 to 10.2 | (120, 20, 0 \| 2, -7, 0 \| 10) | DESK closer on list + conversation |
| 11.2 to 13.4 | (840, 40, 180 \| 0, 16, 2 \| 120) | PHONE hold; crest -700 in transit |
| 13.4 to 14.6 | (560, 30, 120 \| 0, 8, 1 \| -520) | pull back: phone right, desk right edge left |
| 15.0 hold to 15.2 | same | payoff visible |
| 16.0 to 19.6 | (1510, -40, -60 \| 0, 8, -1.5 \| -380) | PAIR, both cards; crest -600 |
| 20.8 to 24.2 | (80, 640, -20 \| -26, 0, 0 \| -260) | BOARD, desk bottom edge visible at frame top; crest -1100, roll -3 |
| 25.2 to 27.6 | (-1360, -120, -100 \| 0, -12, 0 \| 0) | PALETTE; slider-rig track through `label3w` |
| 28.2 to 30.4 | (-1320, 360, -40 \| -4, -10, 0 \| 20) | BLAME |
| 31.0 to 33.4 | (0, -880, -260 \| 10, 0, 0 \| -60) | PAGE; crane-up, crest -900 |
| 34.2 to 36.0 | OVERVIEW (identical to 0.0) | seam |

## Timeline

Scene table (also `window.__heroFly.scenes` and the chapter ticks). Clicking a tick seeks to its hold start.

| # | name | start | end | hold start | feature | caption (DOM strip) |
|---|---|---|---|---|---|---|
| 1 | Inbox | 0.0 | 6.0 | 2.6 | every agent in one live inbox | Every agent session, live. Claude Code, Codex, Cursor, OpenCode and pi in one inbox. |
| 2 | Fan out | 6.0 | 10.6 | 6.3 | agents spawn worker sessions | One lead spawns workers, and every session lands in the same inbox. |
| 3 | From your phone | 10.6 | 15.6 | 11.2 | push + approve on iOS, synced live | A worker needs permission. Approve it from your phone. |
| 4 | Agents talk | 15.6 | 20.2 | 16.0 | `cast send` between sessions | Sessions message each other to hand off work. |
| 5 | Tasks | 20.2 | 24.8 | 20.8 | task filed from chat, claimed by an agent | Tasks come straight out of the conversation, and agents claim them. |
| 6 | Memory | 24.8 | 30.8 | 25.2 | search every session, blame a line | Weeks later, anyone can find why a line of code exists. |
| 7 | Publish | 30.8 | 36.0 | 31.0 | `cast publish` a report | Publish the result as a page your team can comment on. |

### Scene 1: Inbox (0.0 to 6.0)

- 0.0: every surface lies face-down (rotateX 180 about its bottom edge). Camera at OVERVIEW.
- 0.15: surfaces flip face-up in flight order (desk, phone, pairA, pairB, board, palette, blame, page), 120ms stagger. Each flip rises to translateZ +160 at 45% progress and lands on `DROP`; contact shadow shrinks at the apex and snaps back on landing.
- 0.9 to 2.4: camera glides down to the DESK hold, roll peaks at -2deg at 1.6.
- Desk state at deal: sidebar Inbox (badge **1**), Feed, Tasks, Docs, Workflows; Projects codecast, api, mobile. Session list, 6 rows:
  1. Dashboard rewrite, claude, working, "sarah · merging the dashboard half", 1m (active row)
  2. Fix flaky auth test, codex, working, "Reproduced, writing regression test", 2m
  3. Ship dark mode, cursor, working, "Applying tokens across settings", 9m
  4. Investigate p95 latency, opencode, working, "Profiling the sync endpoint", 14m
  5. Refactor session cache, pi, needs input, "Two eviction strategies, which one?", 31m
  6. Add rate limiting, claude, idle, "Merged. 34 files changed", 2h
  Conversation pane shows "Dashboard rewrite · working · claude", avatar S (#2aa198), one prose line "Table states are done. Wiring retries next.", composer "Send a message..." with the ↵ keycap.
- 2.8: agent chips pulse down the column (scale 1 to 1.12 to 1, `SNAP`, 90ms stagger) so the eye reads "every agent".
- 3.4: new row **"Migrate billing webhooks"** (claude, working, "Reading the webhook handlers", now) drops in at the top: house drop but from translateZ +240, rotateX -22, y -40. The final layout already contains the new row; before 3.4 rows 1 to 6 carry `translateY(-rowH)` and slide to 0 on `settle` 480ms, 25ms stagger, while the new row is at opacity 0.
- 4.8: the new row takes the active highlight (amber 8% tint and 2px amber left border, 200ms `settle`); previous active highlight fades out.
- 4.9 to 5.2: conversation pane cross-fades to the Migrate session: header "Migrate billing webhooks · working · claude", avatar A (#cb4b16). 5.0: user prompt card drops in: "Ashot: switch us to the new Stripe webhook API. @sarah owns the dashboard side" (@sarah violet).
- POSTER_T = 5.4 is this frame.

### Scene 2: Fan out (6.0 to 10.6)

- 6.0 to 6.3: camera eases closer (no crest, neighbouring framing).
- 6.4 to 7.2: agent prose streams word by word: "On it. Splitting this in two: the API half and the dashboard retry UI."
- 7.3 and 7.7: two tool blocks reveal (`settle` 400ms, #eee8d5, green `$`):
  `$ cast spawn --subagent --agent codex "Webhook API half"`
  `$ cast spawn --subagent --agent cursor "Dashboard retry UI"`
- 7.9 and 8.2: from each block a ghost card (the session title) lifts to z +200, rotates Y 35deg, arcs over the pane divider (z peaks +260) and lands at 8.5 and 8.8 as a new row directly under "Migrate billing webhooks", `DROP`. Rows below push down on `settle`. Worker rows mirror the real ConversationList parent link: a dim line "spawned by Migrate billing webhooks" with the rotated arrow glyph, agent icon at the smaller subagent size.
  - "Webhook API half", codex, working, "Reading stripe/webhooks.ts", now
  - "Dashboard retry UI", cursor, working, "Applying retry states to the table", now
- 9.0: claude, codex, cursor chips pulse once (`SNAP`, 120ms stagger).
- 9.4: "Webhook API half" dot crossfades green to amber with a 1 to 1.35 to 1 pulse; note crossfades to "Allow running npm test?"; Inbox badge 1 to **2** (`SNAP`).
- 10.1: a thin amber ring starts expanding on that row. Handoff.

### Scene 3: From your phone (10.6 to 15.6)

- 10.2 to 11.2: crest move right to PHONE (dist -700 at mid, roll +3). At 10.3 `ghostPermission` (an amber chip reading "Permission needed") lifts off the amber row and travels with the camera, docking at the phone's top edge at 11.1.
- 11.2: the chip becomes the iOS push banner, dropping from y -80 (`DROP`): app icon, "codecast", title "Permission needed", subtitle "Webhook API half", body "npm test --workspace packages/api". (Mirrors the daemon's "codecast - Permission needed" push whose body is the command.)
- 11.9: banner expands (`settle` 400ms, banner lifts out on translateZ while the card fades in) into the real mobile PermissionCard: "Permission Required", tool "Bash", args box "npm test --workspace packages/api", buttons **Approve** (green) and **Deny**. Header dot amber, "Needs input".
- 12.8: tap: 28px ring on Approve (scale 0.4 to 1.6, opacity 0.5 to 0, 420ms), button `SNAP` 1 to 0.94 to 1, fills #859900, label "Approved" at 13.0. Header dot to green, "Working".
- 13.2 to 13.6: phone streams one line in green: "212 passed, 0 failed".
- 13.4 to 14.6: camera pulls back left so the desk's right side enters frame. 13.8: desk row "Webhook API half" crossfades amber to green, note "Running npm test. 212 passed"; Inbox badge 2 to **1**. A 1px green arc (SVG path in world space, stroke-dashoffset, 500ms `settle`) runs phone to row, the one non-transform animation allowed.

### Scene 4: Agents talk (15.6 to 20.2)

- 15.0 to 16.0: crest up and right to PAIR.
- pairA header "Webhook API half · working · codex", pairB header "Dashboard retry UI · working · cursor" plus a dim short-id chip `jx7k2mq`.
- 16.2 to 17.4: pairA types (40 chars/s): `$ cast send jx7k2mq "api is on staging, your turn"`
- 17.5: `envelope` (a SessionPill "Webhook API half") lifts off pairA to z +200 and arcs to pairB in 700ms `glide`; camera tilts down 3deg to follow.
- 18.2: it unfolds into the SessionMessageBlock (reuse the mock's cyan card): "MESSAGE FROM [Webhook API half] · now", body "api is on staging, your turn". `DROP`.
- 18.7 to 19.3: pairB reply prose streams: "Retry states are in. Staging green on my end."
- 19.2: `envelopeBack` flies a shorter mirror arc (500ms) to pairA, landing as a compact message block "staging green on my end".
- Meanwhile on the desk (off-camera, visible on arrival in scene 5): at 19.8 the lead conversation gains prose "Both halves are merged. Filed [Retry queue for failed webhooks] for the last two endpoints." with a TaskPill.

### Scene 5: Tasks (20.2 to 24.8)

- 19.6 to 20.8: the biggest move: pitch down to -26, swoop down-left to BOARD, crest dist -1100, roll -3.
- Board: toolbar "All · Filter · Sort by priority · ⌘K" (reuse TasksMock header) and the four TasksMock rows.
- 21.0: `ghostTask` (the TaskPill) lifts from the desk prose at the frame's top edge and falls on a parabola onto the board (600ms), landing at 21.6 and unfolding (`settle`, scaleX from pill width to row width on a container with counter-scaled content, content fades in at 60%) into a new top row: open circle (blue), `ct-731`, "Retry queue for failed webhooks", plan pill "Billing", empty dashed assignee, priority up arrow (#cb4b16), "now". Rows below push down, 25ms stagger.
- 22.6: claim: assignee slot flips (rotateY 180 about its centre, 380ms) from dashed circle to codex BotIcon (#859900); status icon crossfades to CircleDot amber; tag "codex claimed" slides out right of the title (x +8 to 0, fade), fades after 1.2s.
- 23.4: row ct-619 "Fix supply write-back" completes: icon crossfades to the green check, title fades to #93a1a1.

### Scene 6: Memory (24.8 to 30.8)

- 24.2 to 25.2: low slider-rig track left to PALETTE, pitch -26 to 0. The camera passes `label3w` ("3 weeks later", #002b36 at 80%), whose opacity is 1 only during this transit (parallax cue). The caption strip also reads "Weeks later...".
- Palette mirrors CommandPalette: input with placeholder "Search sessions, docs...", then 25.4 to 26.2 the query types (34 chars/s): "why do webhooks retry twice". Avatar S beside the input (sarah is searching).
- 26.4: results drop in from y -16, z +40 (`DROP`, 100ms stagger), grouped:
  - SESSIONS: "Migrate billing webhooks · claude · Ashot · 3w" (selected: amber 8% tint and left border); "Webhook API half · codex · 3w" with snippet "MAX_ATTEMPTS = 2, then park it in the retry queue" (matches highlighted #b58900)
  - TASKS: "ct-731 Retry queue for failed webhooks · done · codex"
- 27.6 to 28.2: short `glide` down to BLAME.
- Blame terminal (#002b36 bg, #93a1a1 text): `$ cast blame src/billing/webhooks.ts -L 41,43`, then three lines in the real default format `<sha> (<who> <date> <lineno>) <content>`, where who is `<short id> <first name> <title>` for session-authored lines:
  `a41c9e2 (jx7p4rt Ashot Webhook API half 2026-09-09 10:14:02 -0700 41) const MAX_ATTEMPTS = 2;`
  `a41c9e2 (jx7p4rt Ashot Webhook API half 2026-09-09 10:14:02 -0700 42) await retryQueue.park(event);`
  `9f03b17 (Sarah Chen                     2026-09-12 16:40:51 -0700 43) // batch 2 merchants on the new endpoint`
  The who column of lines 41 and 42 is overlaid by a blue SessionPill tint. Lines type in at 28.3 (each line fades in, 80ms stagger; do not type long lines).
- 28.6: line 41 highlight bar sweeps left to right (scaleX 0 to 1, 260ms).
- 29.1: a quote card drops below the pill (`DROP`): header SessionPill "Webhook API half · codex · 3w ago", body "Two attempts, then park it in the retry queue so Stripe never double charges." This is the message the pill opens to, phrased as a quote from the session.

### Scene 7: Publish (30.8 to 36.0)

- 30.4 to 31.0: crane-up to PAGE, pitch -4 to +10, crest -900.
- Page starts as a cast-canvas card "Webhook p95 by endpoint" (reuse the InboxHeroMock bar chart data). 31.1: bars grow from the baseline (scaleY 0 to 1, origin bottom, 60ms stagger, `SNAP`); the last three are blue then green.
- 31.6: a terminal chip slides along the top edge: `$ cast publish report.html` then `codecast.sh/a/webhook-latency`.
- 32.0: the card unfolds into the full page (scale 0.62 to 1 on the frame, clip inset on the frame's own box, 520ms `settle`): URL bar "codecast.sh/a/webhook-latency", title "Webhook migration: latency report", two-line summary "p95 down 71% across 16 endpoints. Retries park after two attempts."
- 32.6: comments drop in on the right margin, 180ms apart: S (violet) "ship it", M (#d33682) "numbers look great". 32.9: chip "3 viewers" pops top right.
- 33.4 to 34.2: camera glides back to OVERVIEW; roll +2 resolves to 0. For about 0.8s the world reads as one finished day of work.
- 34.4 to 36.0: surfaces flip face-down in reverse order (page first, desk last), 120ms stagger, `SETTLE` (no overshoot, calm seam), lifting to translateZ +140 at the apex.
- 36.0 = 0.0 exactly. Each surface's content resets only while it is face-down: content beats read `contentT(surface, t) = t < flipDownMid(surface) ? t : 0`, where `flipDownMid` is the moment the surface passes edge-on (90deg). Before that it shows its finished state; after it, its t=0 state, which is what the deal at 0.15 flips up.

## Mobile (container < 640px)

- Stage switches to logical 640x800 (`aspect-ratio: 4/5`). Same world, same timeline, same transits.
- `CAMERA_MOBILE` overrides only the hold poses: rotations halved, framed on the hero element at about 1.35x: new inbox row + prompt card (1), list with worker rows (2), phone full frame (3), pairB message card (4), new task row (5), palette results then blame line 41 and quote card (6), page title and comments (7). Overview uses pitch 50.
- The caption strip sits under the stage and carries the meaning where stage text is small. Ticks become dots with only the active name shown.
- No horizontal overflow: the only clip is the outer wrapper; nothing outside the stage box.

## Reduced motion (`prefers-reduced-motion: reduce`)

- No camera flight, no flips, no drops. Render each chapter's settled frame face-on: `frame(holdEnd - 0.1)` with the camera at that hold pose and all in-surface entrances at progress 1.
- Start on chapter 1 at POSTER_T. Cross-fade between chapter frames every 5s with 400ms opacity, pausable. Ticks remain buttons.

## Controls, captions, accessibility

- Under the stage (DOM, outside 3D, crisp): pause/play button (28px, KeyCap-like mono, `aria-pressed`), then 7 chapter ticks with names. The active tick fills with a `scaleX` bar (reuse TourFilm's `DOTS` colours for tick dots; export `DOTS` from TourFilm rather than copying). Clicking a tick seeks to its hold start and keeps the current play state.
- Caption strip: 13px mono #657b83, chapter name plus caption line, 350ms `settle` crossfade on chapter change. React re-renders only on chapter change.
- Root: `<figure role="group" aria-label="Codecast product tour">` with a visually hidden description: "A looping tour of codecast: a live inbox of Claude Code, Codex, Cursor, OpenCode and pi sessions; a lead session spawning two workers; a permission prompt approved from an iPhone; two agents messaging each other; a task filed from the conversation and claimed by an agent; a teammate finding the session weeks later and tracing a line of code to it with cast blame; and a report published as a page." The stage is `aria-hidden`. Controls are real buttons.

## Scrub hook contract

```ts
window.__heroFly = {
  seek(seconds: number): void,   // renders frame(seconds mod DURATION) synchronously, keeps play state
  pause(): void,
  play(): void,
  duration: 36,
  scenes: [{ name, start, end }...], // the 7 rows of the scene table
  get t(): number,               // current film time (read-only convenience)
};
```

- `?hero-t=<seconds>` renders that time and stays paused (overrides reduced motion and autoplay).
- `frame(t)` is pure: no Date.now, no accumulated spring state, no React state feeding it. Playback time = `anchorT + (performance.now() - anchorWall)/1000`, re-anchored on play, seek and resume.
- The driver pauses on IntersectionObserver exit and `visibilitychange` hidden; resume keeps absolute film time.
- Seek verification points: 0.0, 1.2, 4.2, 5.4, 8.9, 12.4, 14.4, 18.6, 22.8, 26.9, 29.6, 32.8, 35.99.

## Code layout (reuse first)

- `productMocks.tsx`: export `AGENT_COLORS`, `AgentChip`, `StatusDot`, `Avatar`, `WindowChrome`, `SessionPill`, `TaskPill`, and the icons. Split `InboxHeroMock` into exported pieces that both the static mock and the film use: `HeroSidebar`, `SessionRow`, `ConversationHeader`, `UserPromptCard`, `CanvasCard` (bars data exported), `SessionMessageCard`, `PermissionBlock`, `Composer`. `InboxHeroMock` becomes their composition with the same output (except copy fixes: no emdashes in `HERO_SESSIONS` and the prompt, buttons say Approve/Deny like the real PermissionCard). `TasksMock` exports `TaskRow`, `TASK_ROWS` and `TaskToolbar`; `AgentChatMock` reuses `SessionMessageCard`. Move the Pillar 3 phone bezel from `page.tsx` into `PhoneFrame` in productMocks and use it in both places. Keep TasksMock, DocsMock, AgentChatMock and the Pillar 3 phone rendering unchanged and check them after the refactor.
- `HeroFlythrough.tsx`: the component (stage, scale-to-fit, driver, controls, captions, a11y, scrub hook). Renders the world once; the driver writes styles to refs.
- `heroFly/timeline.ts`: easings, springs, `clamp`, `progress(t, cue, dur, ease)`, Catmull-Rom camera sampler, typing helper `typed(text, t, cue, cps)`, and `frame(t, layout) -> { camera, els: Record<id, {transform, opacity}>, texts: Record<id, string> }`.
- `heroFly/world.ts`: declarative config only: `SURFACES` (id, size, pos, rot, back label, render key), `CAMERA` and `CAMERA_MOBILE` keyframes, `SCENES`, and per-surface `BEATS` arrays `{ id, cue, dur, from, preset }` plus flyer paths.
- `heroFly/surfaces.tsx`: one render function per surface (`DeskSurface`, `PhoneSurface`, `PairSurface`, `BoardSurface`, `PaletteSurface`, `BlameSurface`, `PageSurface`), composed from productMocks pieces. Elements that animate carry `data-fly="<id>"`; typed text carries `data-fly-text="<id>"`. Initial inline styles come from `frame(POSTER_T)` computed at module scope (pure), so the prerender is the poster frame with real text.
- `heroFly/timeline.test.ts` (bun test): `frame(0)` equals `frame(36 - 1e-6)` within epsilon for camera and every element; `frame` is deterministic; scenes are contiguous and cover [0, 36); every hold keeps the hero surface's effective scale in [0.95, 1.1] and within 12deg of face-on.
- `page.tsx`: swap `<InboxHeroMock />` for `<HeroFlythrough />` in the Hero Image section; keep the glow wrapper.

## Risks and rules

1. **preserve-3d flattening.** Only the world and surface wrappers are in the 3D tree; they carry no overflow, filter, clip-path or opacity. Opacity animates on leaves (a surface's inner card), never on a 3D parent. In-surface drops use their own `perspective()` and need no 3D chain.
2. **Text crispness.** Holds are face-on at scale near 1; surfaces render at true size and the camera moves. `will-change: transform` goes on the world only during transits (toggled by `frame`), never during holds, so Chrome re-rasterizes text sharp at rest. Check Safari.
3. **Performance.** Cull surfaces more than one scene away (`visibility: hidden`, a pure function of t). Skip style writes whose value did not change. One rAF, paused offscreen and when hidden.
4. **Cause and effect in frame.** The scene 3 payoff (desk row turns green) and the scene 5 pill fall need the desk in frame at 13.8 and 21.0. Tune camera and board position against captures before polishing anything else.
5. **Copy truth.** Real wording: Approve/Deny, "Permission Required", "Permission needed" push, "spawned by" parent link, "Search sessions, docs..." palette placeholder, git-blame default format with session who column. Short ids, ct numbers, dates and comment text are illustrative. No emdashes anywhere.
6. **Prerender.** No window or matchMedia at module scope; media queries read in effects. The prerendered frame is desktop layout at POSTER_T; mobile swaps layout in an effect with no height change (both aspect ratios are set by a CSS media query, not JS).
