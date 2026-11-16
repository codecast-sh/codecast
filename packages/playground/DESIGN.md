# Clayground: design

This is the visual and verbal identity of the playground, and the build spec
for every surface. `SPEC.md` says what the product does; this file says how it
looks, moves and talks. When the two disagree on behavior, SPEC wins; on
looks, this file wins. The reference mockup is `design/v2-warm.html`; where
this document and the mockup differ, this document is right.

## 1. The idea

**A warm, quiet workbench where the app is the only loud thing.** The chrome
is paper, hairlines and soft depth, set in a plain, highly legible sans. It
recedes so whatever people built is the brightest, most colorful thing on
screen. A room is a working surface people stay in for an hour, so it is
dense, calm and easy to scan.

Playfulness comes in three small doses and nowhere else: the animal faces,
warmth in the copy, and one good moment when a change goes live.

Four rules decide every tradeoff:

1. **The app is the hero.** On the clean link, Clayground owns one small
   capsule and nothing else. The app is full-bleed and never tinted, framed
   or dimmed, except to mark "you are looking at the past".
2. **Faces carry the life.** The chrome is neutral; the 24 animal faces are
   almost the only color in it. They appear on every message, every build
   card, in the capsule, on the timeline and in the gallery.
3. **State reads at a glance.** Every color has one job (4.1). A glance at
   the room says what is live, what is building, what is waiting and what
   failed, in words and in one consistent mark: **the build line**, a 2px
   line on top of a build card that grows while Clay works, completes and
   turns green when it goes live, or stops where it stopped when it fails.
4. **One celebration.** Going live is the only moment that moves for joy.
   Everything else moves only to show work in progress or to follow a
   person's hand.

## 2. Name

**Clayground.** Software as clay that people shape together in public. The
name survives the calmer look because Clay is the builder: the product's
character is the thing doing the shaping, and the room is where everyone
watches it. Domain: `clayground.fun` is available ($2.57 first year, renews
$31.41, checked 2026-10-06 with the Porkbun checker). `clayground.app` is
taken.

- Wordmark: the blob (22px) followed by "Clayground" in Commissioner
  (4.2) at 20px/700, ink. Never write it "ClayGround" or "clayground" in
  prose.
- **The builder is Clay.** The agent appears in the room as Clay, with the
  blob as its face: a persimmon squircle (radius 38%) with two dark-brown
  `#2b1a12` eyes (each 13% wide, 22% tall, radius 3px, top 38%, inset 30%
  from each side). "Clay is building v15", "Clay couldn't finish this one".
  Clay is a character like the animals, never "the AI" or "the assistant".

## 3. Voice and copy rules

Talk like a friend holding the controller out to you: short, warm, a little
cheeky, always concrete. The warmth lives in the words, so the chrome does
not have to shout.

- **Verbs over nouns.** "Change it", "Make it", "Fork from here", "Back to
  live", "Be Pocket". Never "Submit", "Request", "Confirm", "Proceed".
- **Name people by their character.** "Juniper asked", "Pocket restored v12".
  Never "a user", "someone", "you have", except for the person reading:
  "You're viewing v12, nobody else is".
- **Versions are `v14`.** Lowercase v, no space. Standing alone (card titles,
  peek, collapsed rows) it is set bold, at heading weight.
- **Sentence case everywhere.** No ALL CAPS strings, no letterspaced
  uppercase labels.
- **No emdashes, no exclamation marks**, no trailing ellipses in labels.
- **Errors say what happened and what to do**, in one line each:
  "Clay ran out of time on a big change. Smaller steps usually land." +
  "Try again". Never show a stack trace by default.
- **Numbers are human.** "7 here", "38 people changed it", "2nd in line",
  "0:11" for a running build, "6 min ago" for history.

Canonical strings (use these exactly):

| Where | String |
|---|---|
| Home input placeholder | `Make something`, then after 1.2s idle an example every 3.2s, each fading in whole and short ("a guestbook of tiny planets", "a frog choir, one note per person", ...); an example that would not fit the field whole at its width is skipped, until the person taps or types in the field |
| Home submit | `Make it` |
| Home lede | `Describe an app and Clay builds it in seconds. Anyone with the link can change it by chatting, and everyone sees it change.` |
| Starter row label | `Or start with` |
| Home feed heading | `Right now` |
| Gallery heading | `Busy right now` when anyone is in an app, else `Made recently` |
| Capsule button | `Change it` |
| First-visit hint | 2+ here: `{N} people are in here. Open the room to watch them or change the app.` · alone: `Anyone with this link can change this app. Say what you'd change.` |
| Composer modes | `Auto` · `Change it` · `Just chat` |
| Composer placeholder | Auto: `Say anything, or ask for a change` · Change it: `What should change?` · Just chat: `Say something` (beside the folded mode chip on narrow screens, Auto is `Say anything`) |
| Composer hint | Auto: `Clay decides whether it's a change or just chat` · Change it: `Goes live for everyone` · Just chat: `Clay stays out of it` |
| Queued row | `Starting` (nothing ahead of it) or `2nd in line` (ordinal, counting the build running ahead) |
| Sheet peek | `Building v15` · `0:06` · {current step} · `v15 going live` · then `v15 is live` · {summary} · `Undo` |
| Capsule callout | {what was said}, then `Starting` / `2nd in line` / `Building v15` / `v15 going live` with the asker's face and name, then `v15 is live` · {summary} · `Try it {what to do}` · `Undo` · `Open` |
| Opening narration line | `Thinking about {the request, verb first, six words}` ("Thinking about making the bass frog wobble whenever…") |
| A version's summary (Clay writes it) | one present-tense sentence starting with a verb, under 70 characters, naming the most visible change: `Makes the count rounder and adds a warm glow`; detail goes in the step lines. A first build says what the app is |
| What a version did (feed rows, gallery card meta) | `{name} {what it did}`: a first build `made it`, any other build its summary from its first word in lower case (`Tango turns the scoreboard gold`), a restore `undid v14: {summary}` or `brought back v12`, a fork `forked it from {app}`, a starter `started it`. Never a bare version number |
| Feed row | `{name} {what it did}` over `{app} · 2 min ago`, or `{app} · live now` for the live version within 5 min |
| Building card | `Building v15`; once live on the server and on its way to the screen, `v15 going live` |
| Live card | `v15 is live` |
| Live card meta | `Built in 0:24 · 2 files changed` |
| Failed card | `Didn't make it`; folded once a newer version lands: `! Didn't make it · {request} · 7:18` with Dusk's face |
| Clay declines a request | the request as a chat row, then Clay's row with its reason and `Edit` (never a failed card); capsule title `Clay left it as is` |
| Triage pending (Auto) | `Clay is reading this` under the message, with the 16px blob |
| Triage could not decide | Clay replies `I couldn't tell if that was a change. Send it with Change it if it was.` |
| A heard change can't be queued | Clay replies with the refusal plus ` Chat still works.`; past the build rate: `That's a lot of changes in a few minutes. Ask again in {N} min and I'll build it. Chat still works.` |
| App failed to load | `v26 didn't load` + the app's own error, or `It may be the connection. Try again in a moment.`; `Try again` · `Show v25` · `Fix it` (Fix it only with an error) |
| Boot can't reach the backend | after 5s: `Can't reach Clayground. Trying again` + dots, `Try again` |
| Offline | room header `Reconnecting` + dots; capsule `Offline` with a muted ring, tooltip `Reconnecting. Messages send once it's back.`; a busy button past 8s offline `Waiting for connection` |
| Composer near the cap | `1899/2000` from 1800 characters, send disabled past 2000 |
| Live card actions | `See it` · `Undo`; on the maker's own first version, `Copy link` (then `Copied`) · `See it`, under the line `Anyone with the link can change it. Send it to a friend.` |
| Room header while Clay makes the first version | `Making` (spinner); a first build that failed leaves `Not made yet` |
| First build column | `{name} asked for` · {the request} · Clay's steps · `Clay is making it · 0:24`, then `Going live` |
| Viewing pill / past bar | `v12` + its summary; under it `Only you see this. Make it live or fork it to use it.`, with company the first sentence is `Peak is here too` (`Peak and Juniper are here too`, `3 others are here too`); the buttons say the rest: `Make v12 live` · `Fork from here` · `Back to live` |
| Sheet past row (phone) | `You're viewing v12, nobody else is` · `You and Peak are viewing v12` · `You, Peak and Juniper are viewing v12` · `You and 3 others are viewing v12` |
| What making a version live does (peek line, Make live tooltip) | `Everyone sees v3. Takes out v4 to v6: {v6's summary}` (`Takes out v6: …` for one) |
| Peek actions | `View` · `Make v12 live` · `Fork from here` |
| A version's summary (folded rows, peek, timeline labels) | a build its summary; a restore with its verb: `Undid v7: {summary}` or `Brought back v3: {summary}` |
| Forks of a version (peek, fork modal) | `Iris forked this into {fork}` (`You` for the reader, `, and 2 more`); in the modal followed by `. Join it, or make your own.` |
| Fork modal | title `Fork v12`, lede `A new app with v12's code and a copy of today's data. Its own room, its own link.`, button `Fork it` |
| Room header while viewing | `Viewing v12` · `v14 is live` |
| Fork note in source room | `{name} forked v12 into {fork name}` |
| Lineage line | `forked from {app} v12` |
| Picker title | `Who are you today?` |
| Picker buttons | `Surprise me` · `Be {name}` |
| New version toast (clean link) | `v15 is live · {name}: {summary}`; a restore: `v8 is live · {name} undid v7: {v7's summary}` or `{name} brought back v3: {v3's summary}` |
| Restore card | `v8 is live` · `Peak undid Ziggy's v7` (`your v7`, or `v7` when it was their own; `You` for the reader) + v7's summary · `See it` · `Bring back v7` (after a bring-back: `Undo`) |
| Origin row | `{name} made {app}` + their first request, or `{name} forked {app} from {source} v3` + `Same code, a copy of the data. Change anything.` |

## 4. Tokens

All tokens live in `src/styles/tokens.css` as CSS custom properties on
`:root`. Components never use a raw hex value.

### 4.1 Color

```css
:root {
  /* neutrals: warm paper, never pure white or neutral gray */
  --paper: #f7f3ec;        /* page, room panel, timeline dock, composer */
  --surface: #fffdf9;      /* cards, inputs, popovers, capsule, toast */
  --sunk: #efe9df;         /* chips, tracks, segmented control, hover fill */
  --line: #e5ddd0;         /* hairlines */
  --line-2: #d4c9b8;       /* input borders, dividers that must read, ticks */
  --ink: #2b2520;          /* text, ink buttons, the viewing frame */
  --ink-2: #665c53;        /* secondary text */
  --ink-3: #776b60;        /* meta, timestamps, hints, placeholder */

  /* persimmon: Clay, and the actions that start Clay's work */
  --accent: #c4491f;
  --accent-hover: #ad3f1a;
  --accent-soft: #f7e2d6;

  /* live: used small, as a dot, a label, a tick or a 2px line; never a fill */
  --live: #277548;
  --live-soft: #e3f0e6;
  --live-line: #bfdcc8;    /* the live card's hairline */
  --live-fold: #a8cdb4;    /* the bar on a collapsed live row */

  /* overlays */
  --scrim: rgba(43, 37, 32, .32);
  --glass: rgba(255, 253, 249, .94);   /* capsule, toast, badges over the app */
  --shadow-tint: 70, 45, 20;           /* rgb of every shadow */
}
```

Color laws:

- **One job per color.** Persimmon is Clay: Clay's face, the build line and
  spinner while building, and the buttons that start work (`Make it`,
  `Make v12 live` on the past bar, `Try again`, and send in Change it mode). Green is only live.
  Ink marks "the past" (viewing frame and pill) and is the neutral primary
  (`Change it` in the capsule, send in Auto mode). Everything else is paper,
  surface, sunk, line and ink grades. If a new element seems to need a color,
  it gets a neutral.
- **Failure has no color of its own.** A failed card says so in words, keeps
  its persimmon build line frozen where the build stopped, and shows an ink
  `!` glyph. Red would compete with persimmon and shout.
- **Never a colored fill** behind text larger than a chip, except the
  persimmon and ink buttons. No colored card headers, no colored panels.
- **Contrast:** every text color passes AA (4.5:1) on paper, surface and sunk:
  ink-3 is 4.7:1 on paper and 4.3:1 on sunk, so quiet chrome stays legible
  for an hour, and green text (`--live`) is 5.1:1 on paper. White on
  persimmon passes AA at 13px/600+. The home input's rotating example is the
  one lighter text: ink-3 mixed 80% into surface, 3.4:1 at 21px.

### 4.2 Type

Both faces are served by the shell itself (`public/fonts`, declared in
`src/styles/fonts.css`), cut to Latin, with the body face preloaded in
`index.html` and `font-display: swap`: no third-party connection sits in front
of first paint.

```css
:root {
  --ui: "Commissioner", system-ui, sans-serif;     /* variable, 400 to 700 */
  --mono: "Recursive Mono", ui-monospace, monospace; /* Recursive at MONO 1, CASL 0, weight 500 */
}
```

- **Commissioner** carries every word: chat, buttons, meta, inputs, and the
  headings too (the wordmark, app names, version labels, card titles), set
  bolder and larger rather than in a second display face. The page should
  read as a calm tool around a playful app, not as a toy itself.
  Body `font-feature-settings: "tnum" 0`; tabular figures (`"tnum" 1`) on
  timers, counts in the capsule and the timeline labels.
- **Recursive Mono** is only for things that are literally code or
  addresses: file chips, element chips, URLs, the running timer, keycaps.

| Token | Face | Size / line-height | Weight | Use |
|---|---|---|---|---|
| `--t-hero` | ui | 46 / 1.05, tracking -.02em | 700 | home headline (34 on mobile), the one display line on the page |
| `--t-h1` | ui | 24 / 1.1 | 700 | home section heads, 404 title (32 there) |
| `--t-h2` | ui | 20 / 1.1 | 700 | peek version number, fork modal title, picker title (24 there) |
| `--t-h3` | ui | 18 / 1.2 | 700 | room header app name, wordmark (20) |
| `--t-card` | ui | 14.5 / 1.2 | 650 | build card titles, collapsed version label (13), ordinals (12) |
| `--t-input-lg` | ui | 21 / 1.3 | 500 | home input |
| `--t-lede` | ui | 18 / 1.5 | 400 | home lede |
| `--t-body` | ui | 14 / 1.45 | 400 | chat text, summaries (500 on the live card), narration (13.5) |
| `--t-name` | ui | 13.5 / 1.3 | 650 | names in chat, gallery card names (15) |
| `--t-label` | ui | 13 / 1.2 | 600 | buttons, chips, mode switch (12.5), capsule |
| `--t-meta` | ui | 12 / 1.35 | 400 | timestamps, counts, hints, `--ink-3` |
| `--t-mono` | mono | 11.5 / 1.4 | 500 | element and file chips, URLs, timer, keycaps (10.5) |

Body text color is `--ink`, `-webkit-font-smoothing: antialiased`,
`text-rendering: optimizeLegibility`.

### 4.3 Space, radius, line, elevation

```css
:root {
  /* 4px base; 2px steps allowed inside dense rows */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px;
  --s6: 24px; --s8: 32px; --s12: 48px; --s16: 64px;

  --r-xs: 5px;    /* keycaps, ordinals */
  --r-sm: 6px;    /* element and file chips, segmented options */
  --r-md: 10px;   /* buttons (8 at 30px tall), queued and collapsed rows, faces 28-32 */
  --r-lg: 14px;   /* build cards, gallery tiles, peek, callout */
  --r-xl: 18px;   /* home maker bar, modals */
  --r-pill: 999px;

  --hair: 1px solid var(--line);
  --hair-2: 1px solid var(--line-2);

  --shadow-sm: 0 1px 2px rgba(var(--shadow-tint), .06), 0 0 0 1px rgba(var(--shadow-tint), .02);
  --shadow-md: 0 8px 24px -10px rgba(var(--shadow-tint), .22), 0 2px 5px rgba(var(--shadow-tint), .06);
  --shadow-lg: 0 24px 60px -18px rgba(var(--shadow-tint), .35), 0 4px 10px rgba(var(--shadow-tint), .08);
}
```

- **Edges are hairlines,** drawn as `box-shadow: inset 0 0 0 1px` (or an
  outer `0 0 0 1px` on floating things) so they never change layout. No
  borders thicker than 1px anywhere in the chrome, except the 1.5px tick
  outlines and the viewing frame (2px ink with a 2px light line inside).
- **Elevation has three steps and means height above the app:**
  `--shadow-sm` for things resting in a panel (build cards, tiles, chips that
  are buttons), `--shadow-md` for things floating over the app (capsule,
  toast, callout, viewing pill, maker bar), `--shadow-lg` for popovers and
  modals. Shadows are always soft and warm-tinted; never hard or offset.
- **Faces** are squircles, radius 30% of their size (16→5px, 20→6px,
  24→7px, 28→8px, 32→9px, 58→17px), with a `0 0 0 1px rgba(43,37,32,.06)`
  edge. Stacked faces overlap by 7px with a 2px ring in the color behind
  them (`--ring`), and `+N` follows in 12px/600 ink-2.
- **Focus ring** (all interactive elements, `:focus-visible` only):
  `box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--ink-2)`. Inputs use
  their own focus state (6.3 composer). Where an ink ring already means
  "selected" (a timeline mark, the picker's animals), focus is instead a 2px
  persimmon outline outside the selection ring (offset 3px on a mark, 6px on
  an animal), so the one Enter will choose never looks like the one chosen.
- **Icons:** 16px stroke icons, `stroke-width: 1.7`, round caps and joins,
  `currentColor`; 13px with 2px stroke inside dense rows.

### 4.4 Motion

```css
:root {
  --ease-out: cubic-bezier(.2, .8, .2, 1);   /* moving, settling, leaving */
  --ease-pop: cubic-bezier(.3, 1.35, .6, 1); /* the celebration and toasts only */
  --t-press: 120ms;
  --t-quick: 150ms;
  --t-move: 250ms;
  --t-arrive: 320ms;
}
```

Principles:

1. **Quiet by default.** Hover is a fill change (`--sunk`) over `--t-quick`.
   Press is `translateY(1px)` instant down, `--t-press` back. Things that
   appear fade and rise 6px over `--t-arrive` `--ease-out`; things that
   leave fade over `--t-quick`. No overshoot outside the celebration.
2. **Work is visible.** While building: the build line grows (its width
   follows elapsed time against a 30s expectation, easing toward 90% and
   never reaching 100% until live; width transitions 600ms `--ease-out`),
   the spinner turns (13px ring, 2px, accent on accent-soft, 900ms linear),
   the current narration line's 7px persimmon dot breathes (scale .6 and
   opacity .5 at the midpoint, 1.4s ease-in-out), and a 1.5px ink caret
   blinks after its text (1s `steps(1)`). New narration lines fade up 6px
   over `--t-quick`.
3. **One celebration.** When a version goes live, in this order:
   - the build line finishes to 100% over 250ms `--ease-out` and crossfades
     from persimmon to green over 200ms; it stays on the live card;
   - the card lands: from `translateY(8px) scale(.97)` and opacity 0 to rest
     over 550ms `--ease-pop` (when the building card turns into the live
     card in place, it only scales from .985);
   - a green ring breathes out from the card: `box-shadow 0 0 0 0
     rgba(45,134,83,.35)` to `0 0 0 14px rgba(45,134,83,0)` over 1.4s
     ease-out, starting at 200ms;
   - where the change landed lights up: Clay names the element its change
     is about when it finishes, and the app draws a soft `--live` ring
     around it (the picker's ring, 2px with a light inner line and a 7px
     halo at 26%, up to 6 matches on screen), scaling in from 1.06 and gone
     after 1.2s. Only when there is no such element on screen does the app
     column's edge glow green instead (`inset 0 0 0 2px --live` plus a 48px
     inner glow at 22%, held 200ms, fading over 1.4s);
   - the live dot in the room header pings once (ring 3px to 10px, fading,
     600ms);
   - the faces in the room header stack and the capsule hop: `translateY(-4px)`
     at 40% of a 500ms `--ease-pop` keyframe, staggered 50ms;
   - on the clean link, the capsule's callout turns into the live callout
     (6.2) where the asker is watching; only a landing it could not show
     gets the toast, after 400ms.
   Nothing else in the product celebrates.
4. **The app never jumps.** A new live version cross-fades: preload the new
   iframe hidden; when its SDK says it has painted (rendered, every live
   query it reads answered, two frames drawn; or after 4s) fade it in over
   280ms `--ease-out` on top of the old one, and remove the old one only
   once the fade is done.
5. **Following the hand.** Drags (capsule, room resize, sheet) track the
   pointer 1:1 with no easing; releases settle over `--t-move` `--ease-out`.
6. **Idle life is rare.** The only ambient motion is the home input's
   examples fading in, one every 3.2s, until the person reaches for the
   field. Nothing else idles.
7. **Reduced motion** (`prefers-reduced-motion: reduce`): remove every
   infinite animation (spinner becomes a static three-quarter ring, the
   breathing dot and caret are static), replace transforms with 150ms opacity
   fades, the celebration becomes the green line plus a 150ms fade, and the
   iframe cross-fade runs at 150ms. Every keyframe that moves (`arrive`,
   `hop`, the dock, the room's slide and sheet, popover and toast drops, a
   card's landing) has an opacity-only twin under `reduce`, in base.css or
   its module, and `keyframes.test.ts` fails a moving keyframe without one.
   Scrolling the stream (the new pill, a toast's reveal) jumps instead of
   gliding.

### 4.5 Layers

`z-index`: app frame 0 · viewing frame 10 · picker overlay 15 · timeline
dock 20 · room panel 30 · capsule and callout 40 · popovers (peek, menus) 50
· modals 60 · toasts 70. Popovers render in a portal at the body so a scroll
container never clips them.

### 4.6 Keyboard and screen readers

- **Layers own focus.** Opening the room puts the cursor in the composer (on
  a phone, focus goes to the sheet, so no keyboard pops up); closing it
  returns focus to the capsule's Change it. A popover takes focus on open
  (a timeline peek, which opens on its mark's focus, waits for Tab), cycles
  Tab inside, moves through a menu with ↑/↓, and gives focus back to its
  trigger on Esc or close; triggers say `aria-haspopup` and `aria-expanded`.
  A modal does the same and makes the page behind it `inert`.
- **Names stay clean.** Tooltips describe their control (`aria-describedby`),
  never name it, and KeyCaps inside a control are hidden from it; the
  control declares its shortcut with `aria-keyshortcuts` (`/`, `T`,
  `Meta+1`, the track's arrows).
- **The room's log is news only.** `role="log"` wraps the rows and nothing
  else: the typing row and the loading dots sit outside it, it is busy while
  an older page loads, and a message reads "Pearl, 11 min ago: …" once, with
  the visual name and time hidden. A card changing state in place is said
  once by the stream's status line.
- **Everything a pointer can do, a key can:** a clamped request is a toggle
  button, the room's resize handle is a focusable separator (←/→ by 20px,
  Home or Enter back to 420), name suggestions are pressed toggles, and the
  app's frame is titled "{App}, v12, live" or "…, looking only".

## 5. Shared pieces

Build these once in `src/ui/` and use them everywhere.

- **`<Face avatar size typing? title>`**: an `<img>` of `AVATAR_URLS[key]`
  (imported from `packages/web/lib/orgAvatars.tsx`, never copied) in a
  squircle per 4.3. Sizes 16, 20, 24, 28, 32, 58. `typing` adds a 14px
  surface bubble with three 3px ink-3 dots at its top right. `title` is
  `"{name} the {AVATAR_LABELS[key]}"`. If the image fails: `--sunk` fill and
  the first letter of the name, 600 weight, ink-2; never a broken image.
- **`<FaceStack people max=4 ring>`**: overlapping faces per 4.3, then `+N`.
- **`<Button variant size>`**: height 30 (sm, 13px/600, padding 0 12,
  radius 8) or 36 (md, 14px/600, padding 0 16, radius 10); `lg` is 48 tall,
  16px/600, padding 0 22, radius 12 (home only). Variants:
  `quiet` (surface, `inset 0 0 0 1px --line-2`, hover sunk), `text` (no
  fill, ink-2, hover sunk and ink), `ink` (ink fill, surface text), `accent`
  (persimmon fill, white text, hover accent-hover). Icons sit 6px from the
  label. A `busy` button spins; still busy 8s into a dropped connection
  (one that has not held for 1.5s since it dropped), its label reads
  `Waiting for connection`.
- **`<IconButton>`**: 30px square, radius 8, ink-2, hover sunk and ink.
- **`<Segmented options>`**: sunk track, 2px padding, radius 8; options 24px
  tall, padding 0 10, 12.5px/600 ink-2; the selected option is surface with
  `--shadow-sm` and a 1px line ring, ink text.
- **`<ElementChip ref>`**: 22px tall, radius `--r-sm`, sunk fill, ink-2,
  `--t-mono`; a 9px dashed square glyph (1.3px dashed ink-3, radius 2), then
  `tag · text` with text truncated to 28 characters with an ellipsis
  character. Hovering it outlines the element in the app when the app is on
  the same version.
- **`<FileChip path written?>`**: 22px tall, radius `--r-sm`, `--t-mono`.
  Read files: sunk, ink-2. Written files: surface with a `--line-2` ring, ink
  text, and a 5px persimmon dot before the name.
- **`<LiveDot>`**: 7px green circle with a 3px `--live-soft` ring. Static;
  it pings only during the celebration.
- **`<BuildLine progress state>`**: the 2px line along the top edge of a
  build card, radius `0 2px 2px 0`; persimmon while building, green and full
  when live, persimmon at 45% opacity and frozen when failed.
- **`<Spinner>`**: 13px ring per 4.4.2.
- **`<Blob size>`**: Clay's face per section 2. Sizes 16, 22, 28, 44.
- **Keys**: import `KeyCap` from `packages/web/components/KeyCap.tsx` and
  always render it inside `<span class="keys">`. `.keys kbd` restyles it:
  18px tall, min-width 18, padding 0 4, radius `--r-xs`, surface fill,
  `inset 0 0 0 1px --line-2, inset 0 -1.5px 0 --line-2`, ink-2,
  `font: 500 10.5px/1 var(--mono) !important` with the mono variation
  settings (KeyCap inlines its font, so `!important` is required here and
  nowhere else). On ink or persimmon fills, `.on-dark kbd` uses
  `rgba(255,255,255,.14)` with a `.22` white ring and white text at 85%.
  Every keyboard hint in the product is a KeyCap.

## 6. Surfaces

### 6.1 Home `/`

Someone who lands here should be typing within seconds, so the maker bar is
the first thing they can act on, and the gallery right under it shows what
people really made.

Paper page with two soft warm glows (`radial-gradient(900px 420px at 78%
-8%, rgba(214,120,70,.14), transparent 70%)` and `radial-gradient(700px
380px at -5% 30%, rgba(222,190,120,.16), transparent 70%)`), no pattern.
Content column 1200px max, 64px side padding (24 on mobile).

1. **Top bar** (height 76): wordmark left. Right: the **you chip** (surface,
   `--shadow-sm` plus line ring, radius 12, padding 4/12/4/4, 28px face, name
   13/600, "that's you" 13/500 ink-3), opens the picker.
2. **Hero** (padding 32 top, 16 bottom; grid `1fr 380px`, gap 48, aligned to
   the top). The left column holds, in order:
   - the headline "Make a thing. Pass it around." in `--t-hero`, ink, on one
     line at desktop widths;
   - the lede in `--t-lede` ink-2, 560px max, 12px under it, 24px above the
     bar;
   - the **maker bar**: surface, `--r-xl`, `--shadow-md` plus line ring,
     padding 10/10/10/22; inside, the input (`--t-input-lg`, a 2px persimmon
     caret) and the `lg` `accent` button "Make it" with a KeyCap ↵. On a
     device with a mouse it has focus on arrival; on touch it waits for a tap,
     so no keyboard covers the page. The placeholder is an ink-3 line over
     the field: "Make something", then the examples (section 3), each fading
     in whole over 400ms. Enter submits; with the field empty, `Make it` or
     Enter makes the example on show. Submit navigates to the new room
     immediately (6.10 for the first build);
   - **starters** (14px under the bar): "Or start with" 13/400 ink-3, then up
     to four 30px pills (surface, line ring, 13/500 ink-2; hover ink with a
     `--line-2` ring) that wrap with the label. One tap fills the input and
     submits. An idea whose kind of app the gallery already shows (a pixel
     wall when there is one) is left out, so newcomers join that app rather
     than make a copy.

   The right column is the **Right now** feed: a surface card (`--shadow-sm`,
   line ring, `--r-lg`), heading "Right now" 12/600 ink-3 with a `LiveDot`,
   then the 5 latest versions across Clayground, one per person per app (their
   latest), as rows separated by hairlines: a 24px face, then two lines, what
   they did (13/400 ink-2, name 600 ink, one line with an ellipsis; section 3)
   and the app and when (12 ink-3, app 600 ink-2; "live now" in green 600 for
   the live version within 5 min). Hover sunk. New rows slide in at the top
   over `--t-arrive`. Each row links to the app. Below 1024px the hero is one
   column and the feed follows the starters.
3. **Gallery**, 48px under the hero. Heading in the UI face, 20/650, "Busy
   right now" when anyone is in an app, else "Made recently", with a
   right-aligned meta line (`LiveDot` + "41 people building in 12 apps",
   13/400 ink-2) while anyone is. Apps with people in them come first, the
   most people first, then the most recently active. Grid: 3 equal columns,
   rows 236px, 18px gap; only when the first app has people in it, the
   columns go 1.4fr 1fr 1fr and that app's tile spans two rows. Each tile:
   surface, `--r-lg`, `--shadow-sm` plus line ring, overflow hidden; hover
   lifts 3px and takes `--shadow-md` with a `--line-2` ring over 250ms
   `--ease-out`.
   - **Picture** (fills the tile above its foot). Every app is shown as an
     800x800 page scaled to cover the picture from its top left corner, so a
     wide tile shows the page's top and the tall big tile the whole page,
     always at a legible size. It is the version's **still** (below) at once,
     with no layout shift; the faint 28px blob on sunk shows only while the
     image downloads, or when no still exists yet. The **live app** takes
     over, fading in over the still once it has painted, while the tile is
     hovered or focused, while people are in it, or while it has no still,
     in at most six tiles at once (two on a phone, with data saver, or on a
     4-core device), hovered first, then page order. The live app is a watch
     preview: it shows its real data and cannot write. Each app keeps its own
     look; the chrome never tints it.
   - **Stills.** A version's still is that 800x800 page as an image, drawn by
     the app itself (the runtime renders its own document, fonts inlined)
     and kept in storage, set once. The asker's screen takes it out of sight
     as soon as their version lands; a gallery preview of a version without
     one takes it otherwise. It is also the link preview's image (7).
   - Over the picture's bottom left, when people are in it: a 28px glass pill,
     `--shadow-sm`, `LiveDot`, their 20px faces (max 3) and "7 here" 12/600.
   - Foot (top hairline, padding 11/14/12): name in `--t-name` at 15px, then
     one line saying what made the live version (section 3): the author's
     16px face, "Tango turns the scoreboard gold" (12.5/400 ink-2, name 600
     ink, ellipsis) and the time right-aligned (12.5 ink-3, "6 min ago").
   - Left out: an app whose first version Clay has not made yet, and a fork
     nobody has changed past its v1 unless someone is in it.
   - The whole tile links to the clean link `/<slug>`.
4. Footer: none. The gallery is the end of the page.

### 6.2 Clean app link `/<slug>`

The app iframe fills the viewport, edge to edge, no shell background
visible. The shell adds exactly two things.

**The capsule** (presence affordance), default bottom-right, 20px from both
edges:

- Glass (`--glass`, `backdrop-filter: blur(10px)`), radius 16,
  `--shadow-md` plus a `rgba(var(--shadow-tint), .08)` ring, padding 5, gap 4.
- Left to right: a **grip** (2x3 dots, 3px, `--line-2`, 12x24,
  `cursor: grab`); the **people** button (radius 11, padding 3/9/3/4, hover
  sunk): a `FaceStack` (24px faces, max 4, the most recent speaker first, a
  typing bubble on anyone typing) and "7 here" 13/600 tabular; on desktop a
  1x20 hairline and a **timeline** icon button (opens the timeline dock
  alone, 6.6; tooltip "Timeline" with a KeyCap `T`, and `T` anywhere outside
  an input toggles it); and **Change it** (`ink` button, 32px tall, radius 11, padding 0 8 0 11, a
  speech icon, a KeyCap "/" on dark).
- `/` anywhere (when focus is not in an input) opens the room with the
  composer focused.
- While the timeline dock is open alone, a capsule in a bottom corner sits
  20px above the dock, never on it.
- **Drag:** the grip moves it 1:1; on release it settles to the nearest of the
  four corners over `--t-move` `--ease-out`. Dragging past a side edge by
  40px **tucks** it: a 36px-wide glass tab flush against that edge showing one
  face and the count, at the same vertical position. Click the tab to untuck.
  Position and tucked state persist per device in `localStorage`
  (`clayground.capsule`).
- The capsule never moves itself. If the app needs that corner, people drag
  it; the first-visit hint tells them they can.

**The change callout**, in the callout slot 12px above the capsule, follows
one message through its whole life, as one element that changes in place
rather than a new callout per state: what a friend said, then (once it is a
request) its build, then the landing. Surface, `--r-lg`, `--shadow-md` plus
ring, 268px, padding 11/12, the `BuildLine` along its top. Head row: the
state glyph and title in Commissioner 13.5/650 (spinner + `Starting`,
blob + `2nd in line`, spinner + `Building v16`, green check + `v16 going
live`), and on the right the asker's 16px face, their name (`You` for the
reader) and while building the timer, 12 ink-3. Second line: the line Clay
is on (the opening line, a thinking summary, the plan, a step) in 12.5 ink-2
on one line. When the version is on screen it finishes in place: the line
completes green, the head reads `v16 is live` ("is live" in green), line two
is the summary in 13.5/550 ink (two lines), then `Try it {what to do}` when
Clay gave one (12.5 ink-2, "Try it" 600 ink), then `Undo` (quiet sm) and
`Open` (text sm). It stays 5s of time on screen (hover holds it) and is the
clean link's celebration. A failed build shows `!` + `Didn't make it` and
the reason, for the same 5s.

**The new-version toast** is for a landing the callout could not show: the
capsule tucked, the first-visit hint up, or the slot showing something
else. Top center, 16px from the top: glass, radius 12, `--shadow-md` plus
ring, padding 6/14/6/6, 13.5/500 ink, one line: the asker's 24px face, "v15
is live" in green 650, " · Juniper:" in ink 600, the summary in ink-2, then
`Undo` (or `Bring back v7` after an undo) as a text button. Drops in from
-10px over 500ms `--ease-pop`, stays 4s (pauses on hover), fades over
`--t-quick`. Click opens the room scrolled to that live card. Shown only for
versions that go live while you are here.

**What friends say** while the room is closed: the people button carries a
small ink count badge (16px, pill, 10.5/600 surface text, a 2px glass ring,
top-right) of messages from others since the capsule appeared, until the
room opens. The latest one shows for 5s in the callout slot 12px above the
capsule (taking the slot from a change in flight meanwhile, never from a
landing): one line,
glass, `--r-md`, padding 7/14/7/7, the speaker's 20px face, their name
13/600, the text 13/400 ink-2 with an ellipsis, 360px max. Hover holds it,
and its time counts only while the page is visible, so a friend in another
tab still reads it. Clicking opens the room scrolled to that message. Your
own messages, change requests and a message Clay is still sorting never
count (a friend's request shows here and then becomes its change callout).
No stacking, no sound.

**First-visit hint** (only the first time a device opens any app, whoever
is there, so a newcomer alone learns anyone can change it): a surface callout 12px above the capsule, `--r-lg`,
`--shadow-md` plus ring, 260px max, padding 11/12: the hint string in 13/500
and a second line "Drag it anywhere. `/` opens the room." in 12.5 ink-2 (on
a touch or narrow screen, "Drag it out of the way."). It
goes away on any click, on drag, or after 10s, and never returns.

`/<slug>?room` opens with the room open. `/<slug>/v/<n>` opens the clean
link on version n in viewing mode (6.7).

### 6.3 Room overlay (desktop, viewport 1024px and wider)

Layout when open: the room panel docks on the right; **the app column
shrinks** to the remaining width (the app stays fully interactive and is
never covered). The timeline dock sits at the bottom of the app column
(6.6). The capsule hides while the room is open (the room header does its
job).

**Panel:** paper, left edge `--hair-2`. Width default 420px, min 340px, max
min(640px, 50vw), persisted. A **resize handle** straddles the left edge:
5x44, radius 3, `--line-2`, `cursor: col-resize`, widening to 7px on hover;
double-click resets to 420. Open: slides in 16px with a fade over
`--t-arrive` `--ease-out`; close: fade over `--t-quick`. `Esc` closes when
focus is in the room and no popover is open.

**Header** (paper, bottom `--hair`, padding 14/14/12/18):

- Top row: the app name in `--t-h3`, truncated with an ellipsis; then the
  `FaceStack` (24px, ring paper, hover sunk; click opens a popover listing
  everyone here: face, name, "typing" or "viewing v12" when relevant, you
  first); a **copy link** icon button opening a menu with three rows (App
  link, Room link, This version: each with its URL in mono and a "Copied"
  swap for 1.5s); the you chip as a 28px face button (opens the picker); and
  close.
- Sub row, 6px under, 12.5/400 ink-2 with 3px ink-3 dot separators:
  `LiveDot` + "Live v14" (green 600); while you view the past, "Viewing v12"
  (ink 600), a dot, then `LiveDot` + "v14 is live"; or while Clay makes the first version
  a spinner + "Making" (600 ink-2), "7 here", and when forked, "forked from
  Night Sky v3" as an underlined link (underline `--line-2`, offset 3px).
  Right-aligned at its end, a quiet way home for whoever arrived on a shared
  link: the 16px blob and "Make your own", linking to home with the maker
  focused. The app's maker, and anyone who has changed it, never see it.
- The link menu ends, under a hairline, with "Report this app" ("Flags it
  for a person to check"), which turns to "Reported" once sent.
- After the `FaceStack`, inside the same button, the others' names in
  12.5/400 ink-2 ("Peak", "Peak, Juniper"), or "3 others" at three or more.
  A 1x20 hairline sits before the you button, so you never read as one of
  the others. In the people popover, someone viewing the past reads
  "viewing v3 · **Look with Peak**", a button that shows you that version.
- **Below 1024px** the header is one row: the app name (17px), `LiveDot` and
  "v14" in green 600, the others' `FaceStack` (max 2), copy link, you, close.
  "Make your own" moves into the link menu, above Report.

**Stream** (flex 1, scrolls, padding 6 top 10 bottom; rows run full width
with 18px side padding, cards inset 14px):

- Sticks to the bottom while you are within 80px of it. If you scroll up and
  new items arrive, an ink pill "3 new" (12.5/600 surface text, 28px tall,
  `--shadow-md`) appears centered 10px above the composer; click scrolls down
  over `--t-move` `--ease-out`.
- Contains, in time order, each version where it landed (a live build card
  at its build's finish, so version numbers always read upward after a
  restore or a rebased build; chat, queued, building and failed cards where
  they were said): chat messages (6.4), build cards (6.5), system
  notes, and the typing row at the end.
- **Origin row**, first in the scroll once the room's beginning is loaded,
  and the first item of the bottom-anchored stack (a short room's whole
  history sits together against the composer, never with a gap above): the
  maker's 28px face (or the blob), "{name} made {app}" 13.5/400 ink-2 with
  names 600 ink and the time 12 ink-3, then their first request quoted (or
  v1's summary) in 13/400 ink-2, two lines max. A fork says "{name} forked
  {app} from {source v3}" (the source a link) and "Same code, a copy of the
  data. Change anything."
- **System notes:** centered, padding 8/18, 12.5/400 ink-3 with names 600
  ink-2, a 13px icon before the text: green restore arrow for restores, a fork
  glyph in ink-2 for forks, a 16px blob for Clay notes. No join or leave notes
  ever.
- **Empty room** (no messages yet): centered, a 44px blob, "It's quiet in
  here." (`--t-card` at 16px), "Say what you'd change. Clay builds it and
  everyone sees it." (13/400 ink-2), and three starter pills (as on home) with
  change ideas the builder wrote for this app at v1 ("make it dark", "add a
  sound", ...); a tap puts the idea in the composer in Change it mode, not
  sent.

**Typing row** (last item, padding 6/18/2, 12.5/400 ink-3): 16px faces +
"Pebble is typing", "Pebble and Juniper are typing", or "3 people are
typing", then three 4px ink-3 dots hopping 3px (1.2s, 150ms stagger).

**Composer** (paper, top `--hair`, padding 10/14/12):

- **Mode switch** (`Segmented`, 8px above the field): `Auto` (default),
  `Change it`, `Just chat`. Shortcuts `Ctrl/Cmd+1`, `2`, `3` while the
  composer has focus, shown as KeyCaps in each option's tooltip. Mode persists
  per app per device.
- **Field:** surface, radius 12, `inset 0 0 0 1px --line-2`, padding 6, a
  row of: the **pick button** (30px icon button, a dashed square with a
  cursor), the text (14/400, padding 4/4/5, grows to 6 lines then scrolls; an
  `ElementChip` with an x sits above the text when an element is attached),
  and **send** (32px, radius 9, an up arrow at stroke 2.1; ink in Auto,
  persimmon in Change it, quiet in Just chat; disabled at 40% opacity when
  empty). Focus: ring becomes ink-3 plus `0 0 0 3px rgba(196,73,31,.1)`.
  The field's height is measured on the text alone after layout (a wrapping
  placeholder never makes an empty field two lines), and while it is one
  line its items center on it. From 1800 characters a counter
  (`--t-meta` ink-3, tabular; ink 600 past the cap) sits at the bottom right
  of the text, and past 2000 send is disabled; the server refuses rather
  than clips.
- **Hint row** (7px under, 12/400 ink-3): the mode's hint on the left; on the
  right the next mode's shortcut as a KeyCap pair and its name (in Auto:
  `⌘ 2 Change it`).
- **Below 1024px** the mode folds into the field: a 30px sunk pill after the
  pick button with the mode's name and a chevron (persimmon on accent-soft in
  Change it), opening a menu of the three modes, each with its hint. There is
  no segmented control and no hint row.
- **Ideas for newcomers:** while the field is empty and this visitor has not
  sent anything in this app, a row sits 8px above the field: "Try" 12 ink-3
  and up to three of the app's ideas as chips, one line, scrolling sideways
  with a fade at the right. A tap fills the field in Change it mode, unsent.
  Gone after the first send.
- Enter sends, Shift+Enter is a newline. Sent text appears immediately
  (optimistic) at 60% opacity until the server echoes it.
- **Limits:** rate limited: a sunk strip above the field, 12.5/500 ink-2,
  "Slow down a little. Try again in 20s" with a live countdown, send
  disabled. Daily build budget spent: the Change it option is disabled with a
  tooltip "This app has used today's building budget. Chat still works, and
  changes are back tomorrow." Auto still sends, as chat, and its hint reads
  "Changes are off for now, so this goes as chat".

**Point and talk (picking):** the pick button toggles picking. While on:

- The pick button shows pressed (sunk fill, ink icon), and the app column
  gets a 36px glass banner across its top edge (bottom hairline, 13/500 ink):
  "Click anything in the app" + KeyCap `Esc` "to cancel" in ink-3.
- The SDK draws the hover highlight inside the app: a `2px solid #c4491f`
  outline at 3px offset with a `0 0 0 6px rgba(196,73,31,.12)` halo, and a
  tag above it (ink fill, white `--t-mono`, radius 5, padding 2/6) reading
  `tag · text`. (The SDK receives these values from the shell so the look
  matches.)
- Click attaches the reference to the composer and ends picking. `Esc` or the
  pick button again cancels.

### 6.4 Chat messages

Messages are rows, not bubbles. A room scrolled for an hour reads like a log.

- **Every message:** grid `28px 1fr`, column gap 10, padding 6/18. The 28px
  face spans both lines (2px top offset). Line one: name `--t-name` + time
  12/400 ink-3 ("now", "2m", "4:12"). Line two: text `--t-body`. Hover tints
  the row `rgba(239,233,223,.55)`. Long words break (`overflow-wrap:
  anywhere`); URLs become links (ink, underline `--line-2`).
- **You:** the same row, with "you" in 12/500 ink-3 after your name. Your
  messages are never right-aligned or filled.
- **Grouping:** consecutive messages from the same person within 2 minutes
  drop the face and name line and sit 1px apart.
- **Long messages** clamp to 8 lines with a "Show more" / "Show less" toggle
  (12.5/600 ink-3) under them.
- **Auto, while Clay decides:** a line under the text, the 16px blob and
  "Clay is reading this" in `--t-meta` ink-3, fading in after 300ms so a
  fast answer never flashes it. When triage can't decide, or a change it
  heard can't be queued, the message stays chat and Clay replies under it
  saying why (section 3).
- **Same-name disambiguation:** when two people here share a name, the name
  is followed by their animal in ink-3 ("Pocket the otter"), and grouped
  runs keep the face.
- **Element reference:** an `ElementChip` 5px under the text.
- **Change requests do not render as a message.** A message the builder
  takes as a change (forced or triaged) renders as its build card, which
  carries the asker's face, name and words. In Auto mode, your message first
  appears as a normal row and, when triage returns "change", turns into the
  queued row in place (`--t-move`, `--ease-out`): one item, never two.
- **Clay's messages** (when the builder speaks outside a card, such as a
  follow-up after a failed build) use the 28px blob and the name "Clay".

### 6.5 Build cards

All build cards share one shell: surface, `--r-lg`, `--shadow-sm` plus an
`inset 0 0 0 1px --line` ring, margin 6/14, overflow hidden, the
`BuildLine` along the top. Head row: padding 10/12/0/14, the title in
`--t-card` with its state glyph, and on the right the asker's 20px face +
name + one fact (12/400 ink-3). Body: padding 8/14/12. Everyone sees the
same card update live.

**Queued.** Not a card: one row, margin 4/14, padding 8/10, radius `--r-md`,
`1px dashed --line-2`, 13.5/400: an ordinal (`--t-card` 12px, ink-2 on sunk,
padding 5/7, radius `--r-xs`: "2nd", counting the build running ahead;
with nothing ahead it is a spinner and "Starting", never "1st"), the asker's 20px face, the request on
one line with an ellipsis (full text in the title tooltip), and right-aligned
meta 12 ink-3 (the asker's name, or "You, in line"). It updates its ordinal
live and becomes the building card in place when its turn comes.

**Building.** Title: spinner + "Building v15" (green check + "v15 going
live" while the live version is on its way to the screen); right: asker + the timer
(`--t-mono`, ink-2, "0:11"). Body:

- The request, 13.5/400 ink-2, with a 2px `--line` left rule and 10px left
  padding, clamped to 3 lines (click to expand), 10px gap below.
- **Clay's plan**, the first thing Clay says ("I'll make the bass frog
  wobble whenever anyone croaks"), as the card's lede under the request: 16px
  blob, then 13.5/400 ink, two lines. It stays while the steps scroll.
- **Narration:** a list, 13.5/400 ink-2, 5px gap. Steps are short and verb
  first ("Wobble on note pick"); a file's path is its chip, never part of
  the line, and further changes to the same file fold into its step, which
  takes the newer words. What Clay is doing this moment (the opening line,
  a thinking summary, "Reading App.jsx") stands as the current line until
  the next one arrives. Done lines carry a 13px
  ink-3 check and one line each (full text in the tooltip); the current line
  is ink at 400, up to 3 lines, marked by the breathing persimmon dot and
  the blinking caret rather than by weight. Show the last 4 lines; earlier ones fold into a
  "{N} earlier steps" toggle (12.5 ink-3) above them.
- **Files touched:** `FileChip`s, 5px gap, max 2 rows, then "+4 more".
- The `BuildLine` carries progress; there is no other meter.

**Live.** Ring `inset 0 0 0 1px --live-line`, the `BuildLine` full and
green. Title: "v15" in ink then "is live" in green. Body: the summary in
14/500 ink, two lines at most (its title holds the whole), and nothing
else in words. The request was the building card's lede seconds earlier and
the asker's face and name sit in the head, so repeating it would only say
the same thing twice (with no summary yet, the request stands in). Then
actions 10px below, with the meta "Built in 0:24 · 2 files changed" (12 ink-3;
on a card narrower than 380px only "Built in 0:24", so the time never
truncates) at the right of the row beside the link button: `See it` (quiet sm: returns you to live if you are viewing
the past, and flashes a 3px green inset outline around the app column for
600ms), `Undo` (quiet sm with a restore icon: restores the version before
this one as a new version, which the room shows as a restore card; it shows a spinner and
"Undoing" until that version is live), a spacer, and a copy-version-link icon
button. Arrives with the celebration (4.4.3).

**The maker's first version** is the moment to pass it around: on the live
card of the first version Clay made for the person reading (they asked for
it), a line "Anyone with the link can change it. Send it to a friend." (13.5
ink-2) sits above the actions, and the actions lead with `Copy link` (ink sm,
a link icon), which copies the app link and reads "Copied" with a check for
1.5s, then `See it`. The copy-version icon is left out; there is no Undo on a
first version.

**Superseded live cards collapse.** When a newer version goes live, every
older live card collapses (`--t-move`, `--ease-out`) to one row, margin 2/14,
padding 7/10/7/12, radius `--r-md`, 13/400 ink-2, hover and focus sunk. The
whole row is a button that opens that version in viewing mode: a 3x16
`--live-fold` bar, "v14" in `--t-card` 13px ink, the summary truncated (it
gets the width), the asker's 20px face, and trailing meta 12 ink-3 "7:23"
(the time only: the face says who, the name lives in the tooltip and the
label), which turns to "See it" (600) on hover or focus in the same cell, so
the row never reflows. The rows read as a log. Its tooltip is the summary, then "{name} asked: {request}". Undo is offered only on the current live version's card; older
versions are restored from the timeline.

**Failed.** The `BuildLine` stays where it stopped, persimmon at 45%. Title:
a 14px ink-2 circle with an `!`, then "Didn't make it" in ink; right: asker +
time. Body: the request (as on building), one plain line of why, written for
people ("Clay ran out of time on a big change. Smaller steps usually land.",
"The code it wrote didn't run, twice."), then the actions the failure
allows, and right-aligned a "Details" text toggle that reveals the raw
error in `--t-mono` on sunk, radius `--r-sm`, padding 8/10, max 8 lines.
Every failure has a kind (`builds.failure`). Where the same words can get
through (the code didn't run, out of time, stopped early, the model
unreachable, the app moved twice) the actions are `Try again` (accent sm,
re-queues the same request; disabled with the paused reason as its tooltip
while builds are paused) and `Edit` (quiet sm, puts the request in the
composer). Where the request itself has to change (nothing changed, the
spending limit for one change, building refused) the only action is `Edit`
(ink sm), and the server refuses a retry. Once a newer version has landed,
a failed card folds like a superseded live card into one row: the `!`
glyph, "Didn't make it" (13/600 ink-2), the request truncated, the asker's
face, and "Dusk · 7:18" that turns to "Show" on hover; the row opens the
card again.

**Declined.** A request Clay chose not to build is Clay's answer, not a
failure: the request renders as the asker's chat row, and Clay's reply
follows as a Clay row (blob, "Clay", time) with the reason and an `Edit`
text button to put it another way. No build line, no Try again.

**Restores are versions too.** While a restore is live it is a compact
live card: the same shell and green line, "v8 is live" with the time on the
right, then the restorer's 20px face and "Peak undid Ziggy's v7" in 14/550,
the undone version's summary under it in 13.5/400 ink-2, and actions `See
it` and `Bring back v7` (after a bring-back, `Undo`), so a friend reverses
it in one click. A restore undoes the live version when it brings back
exactly what that version was built on; any other restore brought back an
older one. Once superseded it folds like any version, with a 13px ink-3
restore glyph after its number and its summary said with its verb: "Undid
v7: {summary}" or "Brought back v3: {summary}", never as a fresh change by
whoever restored it. The folded row of the version you are viewing takes the
timeline's viewing treatment (sunk fill, ink bar, "Viewing" in ink 600) and
turns "See it" into "Back to live". **Forks** stay a system note: "Raccoon forked v12
into Moon Party" (the fork name links to it).

### 6.6 Timeline

**Where it lives.** A dock at the bottom of the app column, full width of
that column, 68px tall, paper with a top `--hair-2`. It is open whenever the
room is open, and the capsule's timeline button opens it alone over the clean
link (the app shrinks by 68px; close with its x or `Esc`). On mobile it lives
inside the sheet (6.11).

**Layout**, padding 0/16/0/20, gap 20: a 112px label ("15 versions" 13/650,
"since 5:49" today, "since Sunday" or "since Oct 2" before, 12 ink-3), the track (flex 1), and the keys (KeyCaps ← → "to
step", and `esc` "back to live", which holds its place hidden while you are
on live so viewing never moves the rail, 12 ink-3; then the x when
opened alone).

**Track.** A 1px `--line-2` line across the middle, one mark per version,
evenly spaced. When marks would sit closer than 18px, the strip scrolls
horizontally with 24px fade masks at both ends and keeps the live mark in view
on open.

- **Faces when they fit.** When each version has 30px or more, every mark is
  the asker's 20px face (radius 6) at 70% opacity and 30% desaturated, with
  its number under it (11.5 ink-3, tabular). Below 30px, marks are 9px
  surface circles with a 1.5px ink-3 ring and the face appears only on hover
  or focus. A restore shows its restorer's face with a 12px surface badge holding a
  restore glyph at its bottom right (the ring-in-ring mark in dot mode).
- **Live:** a 13px green dot with a 4px `--live-soft` ring (in face mode, the
  face at full color with a 2px green ring); the label "v15 live" in green
  600.
- **Building:** after the live mark, a 15px dashed persimmon circle (1.5px),
  empty, only while a build runs.
- **Restore:** a ring-in-ring mark (surface, ink-3 at 1.5px, gap, ink-3 again).
- **Fork:** a version someone forked from carries two 1x6 ink-3 strokes above
  its mark.
- **Viewing** (the one you are viewing): ink, 13px, with a 4px paper gap and a
  1.5px ink ring; its label ink 600. In face mode the face gets the same ring.
- **Friends in the past:** everyone else viewing a past version shows as a
  16px `FaceStack` (max 3, ring paper) just above that mark, gone when they
  return to live; the line sits 30px down a 60px rail to make room.
- **Hover or focus:** the face shows at full color and the peek opens; hover
  also scales the mark 1.3 over `--t-quick`, and focus draws the persimmon
  outline (4.3). Labels sit 48px down the 64px rail, clear of both rings.
- **Fork lineage:** a fork's track starts with a link back on the line, the
  fork glyph and "from {source} v3" (12 ink-3, ink on hover), on paper.

**Moving through time.** A click on a mark, ←/→, Home/End, or a press dragged
along the rail shows that version at once (the mark under the pointer as it
moves). The shell keeps the versions either side of the one on screen, and
the one the peek points at, loaded out of sight, so each step is a cross-fade
rather than a load. Going to a version closes the peek; the past bar (6.7)
is the caption for what you see, and the peek reopens only on the next
hover. Entering the past adds one history entry; steps inside it replace it,
so Back leaves the past in one press.

**Peek.** Hover (after 120ms) or tabbing onto a mark opens the peek
above it (portal, flips below if clipped): 320px, surface, `--r-lg`,
`--shadow-lg` plus line ring, padding 14, a 12px rotated-square pointer.
Content: "v12" in `--t-h2` + 20px face + "Bandit · 6 min ago" (12.5 ink-3);
the summary 14/600; the request in 13/400 ink-2, quoted, 2 lines max; when
forked, "Inky forked this into Moon Party" 12.5 ink-2 with the fork glyph,
the fork a link (and on a fork's v1, "Forked from Night Sky v3", linked);
on a past version, what making it live does, 12.5 ink-2: "Everyone sees v3.
Takes out v4 to v6: {v6's summary}"; actions on one line, never wrapping:
`View` (ink sm, the primary), `Make v12 live` (quiet sm), `Fork from here`
(quiet sm with the fork icon). On the live version, View and Make live are
replaced by "This is live" in green 600.

**Keyboard** (when the track has focus): ←/→ show the version before or
after; `Esc` returns to live; Home/End jump to v1 and live. Tab from a
peeked mark goes into the peek; Esc there returns to the mark with the peek
closed, so the next Tab leaves the track.

### 6.7 Viewing a past version

Viewing is private to you. When you view v12:

- The app column swaps to v12 with the same cross-fade as a new version.
- An inset frame outlines the app column: 2px ink with a 2px light line
  (`--past-frame`) inside it, so it reads on dark apps and light ones.
- **The past is looking only.** The frame of any version that is not live
  holds a watch token: the app shows the data everyone shares and writes
  none of it. A write it tries is refused quietly: the SDK's promise never
  settles, so the app has no error to print and no success to claim, and
  the past bar's second line lights up once (a 16% light fill, fading
  over 600ms) to say why nothing happened.
- **The past bar**, while the timeline dock is open: a 48px ink strip of its
  own on top of the dock, full width of the app column, which shrinks for
  it, so the past never covers the app's own controls. Padding 0/12/0/20.
  Left, two lines: "v12" (14/650) and the version's summary
  (13.5/500, one line, ellipsis), then "Only you see this. Make it live or
  fork it to use it." (12, surface at 68%; with company "Peak is here too"
  leads instead, and a phone keeps only that first sentence), with
  the 16px faces of others viewing it first. Right: `Make v12 live` (accent
  sm; its tooltip says what it takes out), `Fork from here` (a ghost on ink:
  transparent, a 28% white ring) and a surface `Back to live`. `Esc` also
  goes back.
- **The viewing pill**, when the dock is closed: the same content floating
  centered 76px up, above the capsule, radius `--r-lg`, `--shadow-md`.
- The room keeps showing the live conversation; your presence shows "viewing
  v12" in the header popover.
- `/<slug>/v/<n>` lands here directly with the timeline dock open (whoever
  was sent a version link is there for its history), same treatment, with
  the capsule present above the bar (its Change it opens the room on live).
- The room header says "Viewing v12 · v14 is live".
- **Below 1024px** the pill keeps only `Back to live`: with the room
  closed it docks at the bottom center, 76px up (above the capsule); with the
  room open the sheet says it instead (its peek row, or a sunk row under the
  header at half and full), with a `Back to live` text button.

### 6.8 Fork flow

1. `Fork from here` opens the fork modal over the scrim: 440px, surface,
   `--r-xl`, `--shadow-lg`, padding 24. Title "Fork v12" (`--t-h2`). A line in
   14/400 ink-2: "A new app with v12's code and a copy of today's data. Its
   own room, its own link." When v12 was forked already, a sunk row (radius
   10, padding 8/10, 13 ink-2) names the latest fork as a link: "Iris forked
   this into Tally, take two. Join it, or make your own." A name field (surface, `--line-2` ring, radius 10,
   44px tall, 16/500), prefilled "{App name}, {your name}'s take" (cut to 40
   characters) and fully selected. Buttons right-aligned: `Cancel` (quiet md)
   and `Fork it` (ink md). Enter submits.
2. On submit, the button shows a spinner and the modal stays until the new app
   exists (usually under a second), then navigates to `/<newslug>?room`. The
   modal fades over `--t-quick`.
3. The new room opens with its **origin row** (6.3) saying where it came
   from, the source a link back. The header sub row carries the same lineage
   link.
4. The source room gets the system note.

### 6.9 Character picker

Opened from any you chip or your own face button. Modal on desktop over the
scrim: 880px, surface, `--r-xl`, `--shadow-lg`, two columns.

**Left (320px, paper, right `--hair`, padding 28, centered):**

- "Who are you today?" in `--t-h2` at 24px.
- The current face at 140px (radius 30%), `--shadow-md`.
- **Name field:** surface, `--line-2` ring, radius 10, 44px tall, 18px Commissioner
  700, with a counter "6 / 24" in `--t-mono` ink-3 at its right (24 is
  `CHARACTER_NAME_MAX`); next to it a 44px quiet **dice** icon button that
  picks a random name from this animal's six (`CHARACTER_NAMES[avatar]`).
  Names are cleaned with `cleanCharacterName` on save.
- **Name suggestions:** this animal's six names as 28px pills (surface, line
  ring, 12.5/500 ink-2); the current one ink-filled with surface text.
- Footnote 12.5/400 ink-3: "Everyone sees this face next to what you say and
  what you change."

**Right (padding 28):**

- "24 animals" 15/650, and right-aligned 12.5 ink-3 a legend: a green 7px dot
  "someone here has it".
- **Grid:** 6 columns, 64px faces, 12px gap; hover lifts 2px over
  `--t-quick`; the selected face gets a 2px surface gap and a 2px ink ring.
  Faces worn in this room carry a 7px green dot with a 2px surface ring at the
  top right, and the tooltip reads "{animal} · 2 here". The animal's label is
  the tooltip and `aria-label`.
- **Keyboard:** arrows move across the grid, Enter selects, `Esc` closes;
  shown as KeyCaps under the grid in 12 ink-3.
- Footer row (top `--hair`, padding top 16): "Names can repeat. Faces tell
  you apart." (12.5 ink-3), `Surprise me` (quiet md: random animal and one of
  its names), and the primary `Be {name}` (ink md, updates live as you type).
- Selecting a new animal crossfades the big face over `--t-move`, and, if the
  name is still one of the previous animal's six defaults, swaps the name to a
  default of the new animal.

**First arrival:** no picker. A visitor gets `defaultCharacterFor` silently,
and the first time, a 4s toast (6.2 style) says "You're Pocket the raccoon."
with a `Change` text button that opens the picker.

### 6.10 Empty, loading and error states

- **While Clay builds** (the first build of a new app included): the live
  version stays in the app column, visible and usable; nothing covers it. The
  room carries the building card. With the room closed, a surface callout
  sits 12px above the capsule (where the first-visit hint goes): 268px,
  `--r-lg`, `--shadow-md` plus ring, padding 11/12; a spinner, "Building v16"
  in `--t-card` 13.5px, the timer right-aligned in mono ink-3, then the
  current narration line in 12.5 ink-2, and the `BuildLine` along its top.
  Clicking it opens the room on the card. A tucked capsule shows a spinner
  under its count. The new version cross-fades in with the celebration.
- **The very first build** (an app made from the home page): the request
  arrives with a starter under it, v0, scaffolding nobody sees, so the
  first thing Clay builds is v1, the timeline reads "No versions yet", and
  the room header says "Making". Until v1 lands, the app column is paper
  with the `BuildLine` across its top and, in a 560px column centered on
  it: the asker's 20px face and "{name} asked for" (13.5 ink-2, name 600
  ink), their request in 500 26px ink (21 on a phone, up to 5 lines), Clay's
  plan and steps exactly as on the build card, and "Clay is making it · 0:24"
  (12.5 ink-3, the 16px blob), which reads "Going live" as v1 lands. The
  card in the stream keeps to its title, timer and the request, since the
  column already narrates. When v1 is on screen the column fades out over
  320ms on top of it. A first build that fails leaves the starter showing.
- **App loading** (clean link, iframe not loaded yet): nothing for the first
  400ms (cached versions usually beat it), then plain paper with a 28px blob
  at 50% opacity, no text.
- **App runtime error** (the SDK reports `error`/`unhandledrejection` from
  inside the app): a 7px persimmon dot appears on the capsule's timeline
  button and the room gets a Clay note "The app hit an error: {message}" with
  a `Fix it` text button that fills the composer with "Fix this error:
  {message}" in Change it mode. At most one note per version.
- **Unknown app** (404): the home page's paper and glows, a 64px blob with
  its eyes shifted down 3px, "No app lives here" (`--t-h1` at 32px), "Want to
  make one?" 15 ink-2, and the maker bar.
- **Reconnecting** (the socket down for 500ms; a reconnect counts once it
  holds 1.5s, so a flapping connection reads as one outage): said in the
  chrome the person is already looking at, never floated over the app. With
  the room open, the header's status line swaps "Live v14 · 7 here" for
  "Reconnecting" (600 ink-2) and the three dots, since presence is unknown;
  with the room closed, the capsule's count gives way to a 7px muted ring
  and "Offline" in ink-3, with a tooltip. Pending messages stay at 60%
  opacity with a 12px clock glyph on every row, grouped ones in the face
  gutter. A busy button past 8s says `Waiting for connection` (5). Gone on
  reconnect without fanfare.
- **Booting stuck:** the shell renders from the last `me` and app it saw,
  so a returning visitor's app frame starts on first paint. A new visitor
  waits on registration, which retries with a growing wait (1s to 15s);
  after 5s on the faint blob, one line under it, "Can't reach Clayground.
  Trying again" with the dots (13 ink-2), and a quiet sm `Try again`.
- **App failed to load:** a version whose page loaded without its SDK
  saying ready (1.5s grace), or never loaded (20s), never comes on top. The
  app column shows paper with the 28px blob, "{v26} didn't load"
  (`--t-card`), the app's own error in `--t-mono` ink-3 (3 lines), or "It may
  be the connection. Try again in a moment." (13 ink-2), then `Try again`
  (reloads the frame), `Show v25` (views the version before), and `Fix it`
  (text, only with an error) which fills the composer. Every served
  index.html starts with a classic inline boot catcher that posts load and
  evaluation errors to the shell until the SDK takes over, so import-time
  failures reach the room's one-per-version error note; a page that never
  arrived is this screen's network and tells the room nothing.
- **Empty gallery:** a single tile with a dashed `--line-2` edge, "Nothing's
  busy yet. Make the first thing." 14 ink-2, centered.

### 6.11 Mobile (viewport below 768px; 768 to 1023 uses mobile room with desktop home)

- **Tap targets** are at least 44px. Hover states become press states (sunk
  fill on press).
- **Home:** headline 34px on 2 lines, the Right now feed moves under the
  starters and shows 3 rows, the maker bar stacks the field over a full-width "Make
  it", starters scroll horizontally, the gallery is one column with 4:3
  thumbnails.
- **Clean link:** the capsule sits bottom-right 12px in, faces max 3, "Change
  it" without the KeyCap; dragging snaps to the four corners and tucking works
  on left and right edges. The toast spans the width minus 24px and truncates
  the summary.
- **Room = bottom sheet** over the app (the app stays visible and usable above
  it): paper, top radius 20, `--shadow-lg`, a 36x4 `--line-2` grab handle.
  Three detents: **peek** 132px (the latest card or message and the composer),
  **half** 55vh, **full** 92vh. Drag 1:1 between detents with velocity (a
  flick moves one detent), settling over 320ms `--ease-out`; a swipe down
  from the peek closes. A tap on the handle or the peek row goes to half.
  The keyboard pushes the sheet and never covers the composer
  (`visualViewport`).
- **One rule for the detents: when the point is the app, the sheet gets out
  of its way.** See it, View, Back to live, Undo and Restore drop the sheet
  to peek and put the keyboard away; so does sending your own change, so it
  lands in view. Opening from the capsule, and focusing the composer from the
  peek, go to half, which keeps the app in view above the keyboard. Only a
  drag up, or scrolling back through the stream by hand, goes to full.
- **The peek row** (between the handle and the composer, 13.5/400, one line,
  ellipsis), in this order: viewing the past ("You're viewing v12, nobody
  else is" + `Back to live`); a change on its way (spinner, "Building v15" in
  `--t-card`, the timer in mono ink-3, the current step in ink-2; or the
  blob and "2nd in line" with the request) with the `BuildLine` along the
  sheet's top edge; the latest build if it is the live version (a green
  check, "v15" + "is live" in green, the summary, an `Undo` text button, the
  green line); a failed build ("!" + "Didn't make it" + why); else the latest
  message (face, name 650, text) or system note.
- **Timeline** on mobile is a horizontal strip inside the sheet, between the
  stream and the composer, at the full detent only (the capsule has no
  timeline button on a phone), always in face mode
  (scrolling); tapping a face opens the peek as a small card above the strip.
- **Picking:** starting a pick collapses the sheet to peek; the banner sits at
  the top of the app; a tap picks.
- **Picker and fork** become full-screen sheets: the picker's left column
  becomes a top block (face 96px, name field, suggestions), the grid is 4
  columns of 64px faces, and the footer buttons are sticky at the bottom.

## 7. Link unfurls (Open Graph)

Until the composed image below exists, the link preview's `og:image` is the
live version's still itself (6.1), with `summary_large_image`.

The OG image is 1200x630: paper with the home page's glows, the app's still
(or a 120px blob on surface if none) in a surface frame with radius 20 and
`--shadow-lg` on the left 60%, and on the right the app name in Commissioner 700
56px ink, "38 people changed it · v14" in 24px ink-2, and up to five 56px
faces of recent changers. Title: the app name. Description: the latest
version summary. `theme-color` is `#f7f3ec`; the favicon is the blob.

## 8. Building it in React

- Plain CSS: `src/styles/tokens.css` (section 4), `src/styles/base.css`
  (reset, body font and smoothing, focus ring,
  reduced-motion rules, `.keys`), and one CSS module per component. No
  Tailwind in the playground.
- Motion: CSS transitions and keyframes for everything listed here; the only
  JS-driven motion is the sheet drag, the capsule drag and settle, the build
  line's progress and the iframe cross-fade, all with the tokens above.
- Shared parts in `src/ui/` (section 5). Surfaces in `src/surfaces/`
  (`Home`, `AppPage`, `Room`, `RoomHeader`, `Stream`, `ChatMessage`,
  `BuildCard`, `Composer`, `Timeline`, `ViewingPill`, `ForkModal`,
  `CharacterPicker`, `Capsule`, `NotFound`).
- Every color, radius, shadow, duration and easing comes from a token. A
  number in a component's CSS that is not a token is either a one-off layout
  measure listed in this document or a bug.
