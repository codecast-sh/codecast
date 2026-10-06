# Clayground: design

This is the visual and verbal identity of the playground, and the build spec
for every surface. `SPEC.md` says what the product does; this file says how it
looks, moves and talks. When the two disagree on behavior, SPEC wins; on
looks, this file wins. The reference mockup is `design/arcade.html`; where this
document and the mockup differ, this document is right (the mockup's room
stream is too cramped, and its headline treatment is retired).

## 1. The idea

**Software is clay, and the animals are the players.** Every surface is a
chunky toy: a thick ink outline, a flat fill, and a hard offset shadow that
squashes flat when you press it. Poking someone else's app should feel like
squishing a toy, never like risking damage to software.

Four rules decide every tradeoff:

1. **The app is the hero.** On the clean link, Clayground owns one small
   yellow capsule and nothing else. The app is full-bleed and never tinted,
   framed or dimmed, except to mark "you are looking at the past".
2. **The crowd is the invitation.** Faces come first, everywhere: on gallery
   cards, in the capsule, on every message, on every version. A link reads as
   "Pocket and six others are in here".
3. **A change is a small show.** The build card narrates out loud and
   everyone watches it. Going live is the one celebrated moment.
4. **Breaking things is safe.** Undo is big and on every live card; every
   version is a bead you can step back to. Nothing ever disappears.

## 2. Name

**Clayground.** Software as clay people shape together in public. One word that
says playful, shared and changeable, and rhymes with what it replaces.
Domain: `clayground.fun` is available ($2.57 first year, renews $31.41,
checked 2026-10-06 with the Porkbun checker). `clayground.app` is taken.

- Wordmark: "Clayground" in Bagel Fat One, ink, preceded by **the blob**: a
  tomato squircle with two ink eyes (see 6.1). Never write it "ClayGround" or
  "clayground" in prose.
- **The builder is Clay.** The agent that makes changes appears in the room
  as Clay, with the blob as its face. "Clay is building v15", "Clay couldn't
  finish this one". It is a character like the animals, never "the AI" or
  "the assistant".

## 3. Voice and copy rules

Talk like a friend holding the controller out to you: short, warm, a little
cheeky, always concrete.

- **Verbs over nouns.** "Change it", "Make it", "Fork from here", "Back to
  live", "Be Pocket". Never "Submit", "Request", "Confirm", "Proceed".
- **Name people by their character.** "Juniper asked", "Pocket restored v12".
  Never "a user", "someone", "you have", except for the person reading:
  "You're viewing v12, nobody else is".
- **Versions are `v14`.** Lowercase v, no space, always in the display font
  when it stands alone.
- **Sentence case everywhere.** No ALL CAPS strings in the DOM (the display
  font is already loud). No letterspaced uppercase labels.
- **No emdashes, no exclamation marks**, no trailing ellipses in labels.
- **Errors say what happened and what to do**, in one line each:
  "Clay couldn't finish this one. It ran out of time on a big change." + "Try
  again". Never show a stack trace by default.
- **Numbers are human.** "7 here", "38 people changed it", "2nd in line",
  "0:11" for a running build, "6 min ago" for history.

Canonical strings (use these exactly):

| Where | String |
|---|---|
| Home input placeholder | `Make something` (rotating examples typed in after 1.2s idle: "a guestbook where every visitor plants a tiny planet", "a frog choir, one note per person", ...) |
| Home submit | `Make it` |
| Starter row label | `Or start with` |
| Gallery heading | `Busy right now` |
| Capsule button | `Change it` |
| First-visit hint | `{N} people are in here. Open the room to watch them or change the app.` |
| Composer modes | `Auto` · `Change it` · `Just chat` |
| Composer placeholder | Auto: `Say anything, or ask for a change` · Change it: `What should change?` · Just chat: `Say something` |
| Composer hint (Change it) | `Goes live for everyone` |
| Queued card | `2nd in line` (ordinal) |
| Building card | `Building v15` |
| Live card | `v15 is live` |
| Failed card | `Didn't make it` |
| Live card actions | `See it` · `Undo` |
| Viewing pill | `You're viewing v12, nobody else is` + `Back to live` |
| Peek actions | `View` · `Restore` · `Fork from here` |
| Fork modal | title `Fork v12`, button `Fork it` |
| Fork note in source room | `{name} forked v12 into {fork name}` |
| Lineage line | `forked from {app} v12` |
| Picker title | `Who are you today?` |
| Picker buttons | `Surprise me` · `Be {name}` |
| New version toast (clean link) | `v15 is live · {name}: {summary}` |

## 4. Tokens

All tokens live in `src/styles/tokens.css` as CSS custom properties on
`:root`. Components never use a raw hex value.

### 4.1 Color

```css
:root {
  /* core */
  --butter: #ffd84a;        /* brand, presence, "you" */
  --butter-deep: #f7c21b;   /* stripes on the building header, pressed butter */
  --ink: #1d1631;           /* every outline, every shadow, body text */
  --ink-soft: #4a4160;      /* secondary text on light surfaces */
  --ink-faint: rgba(29, 22, 49, 0.13); /* dot grid, hairlines inside cards */
  --paper: #fffdf6;         /* cards, inputs, bubbles */
  --cream: #fff7e0;         /* panels (room, picker right side, composer) */

  /* meaning (each color means exactly one thing) */
  --tomato: #ff5b3a;        /* make it happen: Make it, send in Change it mode, primary CTAs */
  --tomato-soft: #ffd6cc;   /* failed card header */
  --mint: #2fd6a0;          /* live: live dot, live card, live bead, Restore */
  --pool: #3b7bff;          /* fork and lineage only */
  --bubble: #ff9fd2;        /* the past: viewing pill, viewing outline */
  --sky: #9fe3ff;           /* written files, decorative */

  /* overlays */
  --scrim: rgba(29, 22, 49, 0.45);
}
```

Color laws:

- **One meaning per accent.** Mint is only live. Pool is only fork/lineage.
  Bubble is only "you are viewing a past version". Tomato is only the action
  that makes something happen (and, softened, its failure). Butter is the
  brand and presence. If a new element needs a color, it gets ink, paper or
  cream.
- **Text on accents:** ink on butter, mint, sky, bubble, tomato-soft (all pass
  AA). Paper on tomato or pool only at 18px+ bold or in the display font
  (large-text AA); smaller labels on tomato and pool use ink.
- **Butter as a page** only on home, the 404, and the picker scrim area. The
  room is cream; the app area is the app.

### 4.2 Type

Load from Google Fonts in `index.html` with `preconnect` and `display=swap`:
`Bagel+Fat+One`, `Gabarito:wght@500;600;700;800;900`, `Martian+Mono:wght@500;700`.

```css
:root {
  --display: "Bagel Fat One", "Gabarito", sans-serif; /* one weight: 400 */
  --ui: "Gabarito", system-ui, sans-serif;
  --mono: "Martian Mono", ui-monospace, monospace;
}
```

| Token | Font | Size / line-height | Weight | Use |
|---|---|---|---|---|
| `--t-hero` | display | 104 / 0.88, tracking -2px | 400 | home headline (56 on mobile) |
| `--t-h1` | display | 44 / 1 | 400 | home section heads, 404 |
| `--t-h2` | display | 30 / 1 | 400 | live card version number, picker title (40 there) |
| `--t-h3` | display | 24 / 1 | 400 | room header app name, peek version (26) |
| `--t-state` | display | 17 / 1 | 400 | build card state ("Building v15"), queue ordinal |
| `--t-input-lg` | ui | 26 / 1.2 | 600 | home input |
| `--t-title` | ui | 20 / 1.1 | 900 | gallery card name |
| `--t-body` | ui | 15 / 1.4 | 500 | chat text, card summaries (600) |
| `--t-label` | ui | 13 / 1.3 | 800 | names in chat, buttons sm, chips |
| `--t-meta` | ui | 12 / 1.3 | 600 | timestamps, counts, `--ink-soft` |
| `--t-mono` | mono | 11 / 1.5 | 700 | element chips, file chips, URLs, timer |

Rules: the display font is never used below 17px or for more than five
words. Chat and summaries are always Gabarito so long, arbitrary text stays
readable. Mono is only for things that are literally code or addresses.

### 4.3 Space, radius, line, shadow

```css
:root {
  /* 4px base */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 20px;
  --s6: 24px; --s8: 32px; --s11: 44px; --s15: 60px;

  --r-xs: 8px;    /* file and element chips, keycaps */
  --r-sm: 12px;   /* small buttons, icon buttons, 30px faces */
  --r-md: 16px;   /* buttons, inputs, bubbles, queue rows */
  --r-lg: 20px;   /* build cards, composer field */
  --r-xl: 24px;   /* gallery cards, peek */
  --r-2xl: 34px;  /* modals, home maker bar */
  --r-pill: 999px;

  --line-thin: 2px solid var(--ink);   /* chips, faces <= 24px, keycaps */
  --line: 2.5px solid var(--ink);      /* default: buttons, bubbles, cards in the room */
  --line-thick: 3px solid var(--ink);  /* gallery cards, build cards, capsule */
  --line-heavy: 4px solid var(--ink);  /* modals, room panel edge, home maker bar */

  --pop-xs: 2px 2px 0 var(--ink);
  --pop-sm: 3px 3px 0 var(--ink);
  --pop: 5px 5px 0 var(--ink);
  --pop-lg: 8px 8px 0 var(--ink);
  --pop-xl: 12px 12px 0 var(--ink);
}
```

- **Shadows are always hard, offset down-right, ink, no blur.** No soft
  shadows anywhere in the chrome (an app's own content may do whatever it
  wants).
- Shadow size scales with the object: chips `--pop-xs`, buttons `--pop-sm`,
  cards and capsule `--pop`, maker bar `--pop-lg`, modals `--pop-xl`.
- **Faces are squircles** with radius 35% of their size and an ink border:
  48px+ faces `--line-thick`, 30 to 40px `--line`, 24px and below are
  circles with `--line-thin`. Stacked faces overlap by a third of their width
  and each gets `--pop-xs`.
- Focus ring (all interactive elements): `box-shadow: 0 0 0 3px var(--paper),
  0 0 0 6px var(--ink)`, shown on `:focus-visible` only.

### 4.4 Motion

```css
:root {
  --squish: cubic-bezier(.34, 1.56, .64, 1); /* overshoot: things arriving, landing, popping */
  --glide: cubic-bezier(.2, .8, .2, 1);       /* things moving or leaving */
  --t-press: 120ms;
  --t-quick: 180ms;
  --t-move: 260ms;
  --t-arrive: 360ms;
}
```

Principles:

1. **Press squashes.** Every button: hover `translate(-1px,-1px)` and shadow
   grows by 1px over `--t-press`; active `translate(Npx,Npx)` where N is its
   shadow offset, shadow to `0 0 0`. Instant down, `--t-press` back up.
2. **Arrivals overshoot, departures glide.** Anything appearing uses
   `--squish` over `--t-arrive` from `translateY(12px) scale(.96)` and
   opacity 0. Anything leaving uses `--glide` over `--t-quick`, opacity to 0
   and `scale(.98)`.
3. **One celebration.** When a version goes live: the live card pops
   (scale .9 to 1, `--squish`, `--t-arrive`), its mint header flashes a ring
   (`box-shadow 0 0 0 0 → 0 0 0 14px` mint fading, 700ms), the live bead
   does the same, and the capsule's faces do a single 4px hop staggered 40ms
   apart. Nothing else in the product celebrates.
4. **Work is visible.** While building: the card header's diagonal stripes
   march (`background-position` 28px per 1s, linear, infinite), the spinner
   orbits (1.2s linear), the current narration line has a blinking caret
   (1s `steps(1)`).
5. **The app never jumps.** A new live version cross-fades: preload the new
   iframe hidden, when it fires `load` (or 4s max) fade it in over 280ms
   `--glide` on top of the old one, then remove the old one.
6. **Idle life is rare.** Only the blob logo wobbles (4s loop) and the home
   crowd faces bob (3.2s loop). No other ambient animation.
7. **Reduced motion** (`prefers-reduced-motion: reduce`): remove every
   infinite animation (stripes become static, caret static, wobble/bob off),
   replace transforms with 150ms opacity fades, keep the iframe cross-fade at
   150ms.

### 4.5 Layers

`z-index`: app frame 0 · viewing outline 10 · picker overlay 15 · timeline
dock 20 · room panel 30 · capsule 40 · popovers (peek, menus) 50 · modals 60
· toasts 70. Popovers render in a portal at the body so a scroll container
never clips them.

## 5. Shared pieces

Build these once in `src/ui/` and use them everywhere.

- **`<Face avatar size ring? typing? title>`**: an `<img>` of
  `AVATAR_URLS[key]` (imported from `packages/web/lib/orgAvatars.tsx`, never
  copied) inside a squircle per 4.3. `typing` adds a small paper bubble with
  three hopping dots at the top right (dots: 1.2s loop, 150ms stagger).
  `title` is `"{name} the {AVATAR_LABELS[key]}"`.
- **`<FaceStack people max=4>`**: overlapping faces, then an ink pill `+N` in
  butter text.
- **`<Button variant size>`**: variants `paper` (default), `make` (tomato),
  `live` (mint), `fork` (pool), `ink` (ink fill, butter text); sizes `sm`
  (13px, padding 6/12, `--r-sm`, `--pop-xs`), `md` (16px, 10/18, `--r-md`,
  `--pop-sm`), `lg` (display 26px, 0/34, height 64, `--line-heavy`, `--pop`).
- **`<Chip>`**: pill, `--line`, 15px/700, `--pop-xs`, padding 7/16, an
  optional 12px rounded-square color dot.
- **`<ElementChip ref>`**: butter fill, `--line-thin`, `--r-xs`, mono 11/700,
  a 9px dashed square glyph, then `tag · text` (text truncated to 28 chars
  with an ellipsis character). Hovering it outlines the element in the app
  when the app is on the same version.
- **`<FileChip path written?>`**: mono 11/700, `--line-thin`, `--r-xs`,
  cream fill; written files sky fill.
- **`<LiveDot>`**: 10px mint circle with a 2px ink border and a pulsing mint
  ring (1.6s loop).
- **Keys**: import `KeyCap` from `packages/web/components/KeyCap.tsx` and
  always render it inside `<span class="keys">`. `.keys kbd` restyles it to
  Clayground: paper fill, `2px solid var(--ink)` with a 4px bottom border,
  `--r-xs`, `font: 700 11px var(--mono) !important` (KeyCap inlines its font,
  so `!important` is required here and nowhere else). Every keyboard hint in
  the product is a KeyCap.

## 6. Surfaces

### 6.1 Home `/`

Butter page with the dot grid (`radial-gradient(var(--ink-faint) 1.6px,
transparent 1.8px) 0 0 / 22px 22px`) and three soft color fields (paper at
top left, bubble at top right, mint at mid left; flat circles at 35 to 55%
opacity, no blur). Content column 1200px max, 44px side padding.

1. **Top bar** (height 88): wordmark left (blob 46px + "Clayground" display
   34). Right: the **you chip** (paper pill, `--line`, `--pop-sm`, 36px
   face, name 800, "that's you" 500 ink-soft), opens the picker.
2. **Hero:** headline "Make a thing. Pass it around." in `--t-hero`, ink,
   one color, two lines, left aligned. To its right (300px), the **crowd**:
   three 92px faces of animals currently active across Clayground, tilted
   -8/0/6 degrees, bobbing, with an ink speech tag in butter text "anyone can
   change it".
3. **Maker bar:** butter fill, `--line-heavy`, `--r-2xl`, `--pop-lg`, 14px
   padding; inside, a paper input (`--line`, `--r-lg`, `--t-input-lg`,
   tomato blinking caret) and the `lg` `make` button "Make it". Enter submits.
   Submit pops the bar (press squash) and navigates to the new room
   immediately (the app row is created optimistically; see 6.10 for the
   first-build state).
4. **Starters:** "Or start with" + four chips with colored dots. One tap fills
   the input and submits.
5. **Gallery** "Busy right now" (h1) with a right-aligned meta line
   (`LiveDot` + "41 people building in 12 apps"). Grid: 3 columns
   (1.35fr 1fr 1fr), 26px gap, the first card spans two rows. Each card:
   paper, `--line-thick`, `--r-xl`, `--pop`; hover lifts `translate(-3px,-4px)
   rotate(-.6deg)` with `--pop-lg` over 250ms `--squish`.
   - Thumbnail (min 168px, ink bottom border): the app's still image if one
     exists, else a live iframe of the live version at 25% scale,
     `pointer-events: none`, mounted only while in the viewport, at most six
     live at once.
   - Top-left badge: paper pill with `LiveDot` and "7 here".
   - Foot: name (`--t-title`), meta "38 people changed it · v14", and when
     forked, a pool line "forked from Haiku Wall". Right: `FaceStack` of who
     is in it now (max 3).
   - The whole card links to the clean link `/<slug>`.
6. Footer: none. The gallery is the end of the page.

### 6.2 Clean app link `/<slug>`

The app iframe fills the viewport, edge to edge, no shell background
visible. The shell adds exactly two things:

**The capsule** (presence affordance), default bottom-right, 20px from both
edges:

- Butter, `--line-thick`, radius 22, `--pop`, padding 7/7/7/6, gap 10.
- Left to right: a **grip** (2x3 ink dots, 14x28, `cursor: grab`), a
  `FaceStack` (30px faces, max 4, the most recent speaker first, a typing
  bubble on anyone typing), a **timeline** icon button (opens the timeline
  dock alone, see 6.6), and the **"Change it"** button (ink fill, butter text,
  radius 15, a speech glyph, `KeyCap` "/").
- `/` anywhere (when focus is not in an input) opens the room with the
  composer focused.
- **Drag:** the grip moves it; on release it snaps to the nearest of the four
  corners (260ms `--squish`). Dragging past a side edge by 40px **tucks** it:
  it becomes a 36px-wide tab flush against that edge showing one face and
  the count, at the same vertical position. Click the tab to untuck. Position
  and tucked state persist per device in `localStorage`
  (`clayground.capsule`).
- The capsule never moves itself. If the app needs that corner, people drag
  it; the first-visit hint tells them they can.

**The new-version toast**, top center, 16px from the top: ink pill, paper
text 14/700, a 24px face of the asker, "v15 is live · Juniper: planets orbit
now". Arrives with `--squish`, stays 4s (pauses on hover), leaves with
`--glide`. Click opens the room scrolled to that live card. Shown only for
versions that go live while you are here.

**First-visit hint** (only the first time a device opens any app with 2+
people present): a paper callout above the capsule, `--line`, `--pop-sm`,
240px max, rotated -1deg: the hint string plus a second line "Drag it
anywhere. `/` opens the room." It goes away on any click, on drag, or after
10s, and never returns.

`/<slug>?room` opens with the room open. `/<slug>/v/<n>` opens the clean
link on version n in viewing mode (6.7).

### 6.3 Room overlay (desktop, viewport 1024px and wider)

Layout when open: the room panel docks on the right; **the app column
shrinks** to the remaining width (the app stays fully interactive and is
never covered). The timeline dock sits at the bottom of the app column
(6.6). The capsule hides while the room is open (its job is done by the room
header).

**Panel:** cream, left edge `--line-heavy`. Width default 420px, min 340px,
max min(640px, 50vw), persisted. A **resize handle** straddles the left edge:
14x58 paper pill, `--line`, `--r-xs`, `cursor: col-resize`; double-click
resets to 420. Open: slides in 24px with fade, 320ms `--squish`; close:
`--glide` 180ms. `Esc` closes when focus is in the room and no popover is
open.

**Header** (butter, bottom `--line`, padding 16/18/14):

- App name in `--t-h3`, truncate with an ellipsis.
- Sub line 13/700: `LiveDot` live, a `v14` ink chip (mono 11, butter
  text, radius 7), "7 here", and when forked, "forked from Haiku Wall v3" as
  a pool link.
- Right: `FaceStack` (click opens a popover listing everyone here: face,
  name, "typing" or "viewing v12" when relevant, you first), a **copy link**
  icon button opening a menu with three rows (App link, Room link, This
  version: each with its URL in mono and a "Copied" swap for 1.5s), the
  you chip as a 36px face button (opens the picker), and close.

**Stream** (flex 1, scrolls, padding 16, gap 12):

- Sticks to the bottom while you are within 80px of it. If you scroll up and
  new items arrive, a butter pill "3 new" appears above the composer; click
  scrolls down (`--glide` 260ms).
- Contains, in time order: chat messages (6.4), build cards (6.5), system
  notes, and the typing row at the end.
- **System notes:** centered, 12/700 ink-soft, max 85% width, a 16px icon
  left of the text: pool dot for forks, mint dot for restores, blob for Clay
  notes. No join or leave notes ever.
- **Empty room** (no messages yet): centered blob (64px), "It's quiet in
  here." (`--t-state`), "Say what you'd change. Clay builds it and everyone
  sees it." (13/600 ink-soft), and three chips with change ideas written for
  this app by the builder at v1 ("make it dark", "add a sound", ...); a tap
  puts the idea in the composer in Change it mode, not sent.

**Typing row** (last item in the stream, 13/700 ink-soft): faces (24px) +
"Pebble is typing", "Pebble and Juniper are typing", or "3 people are
typing", followed by three hopping dots.

**Composer** (cream, top `--line`, padding 12/14/14):

- **Mode switch:** a segmented control, `--line`, `--r-sm`, 13/800: `Auto`
  (selected by default; paper with ink inset when on), `Change it` (tomato
  when on, ink text), `Just chat` (ink when on, butter text). Shortcuts:
  `Ctrl/Cmd+1`, `2`, `3` while the composer has focus, shown as KeyCaps in
  each segment's tooltip. Mode persists per app per device.
- **Row:** the **pick button** (46px, butter, `--line`, `--r-md`, `--pop-xs`,
  a dashed square with a cursor), the **field** (paper, `--line`, `--r-md`,
  15/600, grows to 6 lines then scrolls, shows an `ElementChip` above the
  text when an element is attached, with an x to remove), and **send**
  (52px, `--line`, `--r-md`, `--pop-sm`, an up arrow; fill follows the mode:
  Auto ink, Change it tomato, Just chat paper).
- Under the row, only in Change it mode: "Goes live for everyone" 12/600
  ink-soft.
- Enter sends, Shift+Enter is a newline. Sent text appears immediately
  (optimistic) at 60% opacity until the server echoes it.
- **Limits:** rate limited: a tomato-soft strip above the field "Slow down a
  little. Try again in 20s" with a live countdown, send disabled. Daily
  build budget spent: Change it mode disabled with "This app has used
  today's building budget. Chat still works, and changes are back tomorrow."
  Auto still sends, as chat.

**Point and talk (picking):** the pick button toggles picking. While on:

- The pick button is pressed (inset, no shadow) and the app column gets a
  butter top banner, 36px: "Click anything in the app" + `KeyCap Esc` "to
  cancel".
- The SDK draws the hover highlight inside the app: `3px dashed var(--butter)`
  outline at 4px offset with marching dashes, and a tag above it (butter,
  `--line-thin`, mono 11) reading `tag · text`. (The SDK receives these
  token values from the shell so the look matches.)
- Click attaches the reference to the composer and ends picking. `Esc` or
  the pick button again cancels.

### 6.4 Chat messages

- **Others:** 30px face at left, then a column: name 13/800 + time 12/600
  ink-soft ("now", "2m", "4:12"), then the bubble: paper, `--line`, radius
  `4px 16px 16px 16px`, padding 8/12, 15/500, max width 100% of the column.
  Long words break (`overflow-wrap: anywhere`); URLs become links
  (underlined, ink).
- **You:** right aligned, no face or name, butter bubble, radius
  `16px 4px 16px 16px`.
- **Grouping:** consecutive messages from the same person within 2 minutes
  drop the face and name and sit 4px apart.
- **Same-name disambiguation:** when two people here share a name, the
  name is followed by their animal in ink-soft ("Pocket the otter"); the face
  always shows, even in grouped runs.
- **Element reference:** an `ElementChip` under the bubble.
- **Change requests do not render as a chat bubble.** A message the builder
  takes as a change (forced or triaged) renders as its build card, which
  carries the asker's face, name and words. In Auto mode, your message first
  appears as a normal bubble and, when triage returns "change", morphs into
  the queued card in place (`--t-move`, `--squish`): one item, never two.
- **Clay's messages** (when the builder speaks outside a card, such as an
  explanation after a failed build) use the blob face and the name "Clay",
  with a cream bubble.

### 6.5 Build cards

All build cards: paper, `--line-thick`, `--r-lg`, `--pop-sm`, overflow
hidden. Header row: padding 10/12, bottom `--line`, a state title in
`--t-state`, and on the right the asker's 24px face + name + one fact (12/700
ink-soft). Body padding 10/14/12. Everyone sees the same card update live.

**Queued.** No header row: a single dashed row, `2.5px dashed var(--ink)`,
`--r-md`, cream at 50%, padding 8/12: an ordinal chip (ink fill, butter
display 15, radius 10: "2nd"), the asker's face, and the request in 14/600
truncated to one line (full text in the title tooltip). It updates its
ordinal live and morphs into the building card when its turn comes.

**Building.** Header: butter/butter-deep diagonal stripes marching, a 26px
orbiting spinner (paper disc with a tomato dot), "Building v15", right:
asker + elapsed timer in mono ("0:11"). Body:

- The request in 15/700 (clamped to 3 lines, click to expand).
- **Narration:** a list, 14/500, 6px gap, each line with a 9px mint
  rounded-square check; the current line is 800 weight with a butter square
  that wobbles and a blinking ink caret after its text. Show the last 4
  lines; earlier ones fold into a "+3 earlier steps" toggle. New lines fade
  up 6px over `--t-quick`.
- **Files touched:** `FileChip`s, written files sky with a small pencil
  glyph, read files cream. Max 2 rows, then "+4 more".
- **Meter:** 12px tall, `--line`, pill, cream track; the fill is tomato
  stripes marching and its width follows elapsed time against a 30s
  expectation, easing toward 90% and never reaching 100% until live.

**Live.** Header: mint, "v15" in `--t-h2` followed by "is live" in 17px
display, right: asker. Body: the one-line summary in 15/600, then actions:
`See it` (paper sm: scrolls nothing, it returns you to live if you are
viewing the past and flashes a mint inset outline around the app column for
600ms), `Undo` (paper sm: restores the version before this one as a new
version and posts the restore note; it shows "Undoing" with a spinner until
that version is live), and a copy-version-link icon button. Arrives with the
celebration (4.4.3).

**Superseded live cards collapse.** When a newer version goes live, every
older live card collapses (`--t-move`, `--glide`) to a single 36px row: a
6px mint left bar, "v14" in 17px display, the summary truncated, the asker's
24px face, and a `See it` text button that opens that version in viewing
mode. Undo is offered only on the current live version's card; older
versions are restored from the timeline.

**Failed.** Header: tomato-soft, a tomato circle with an ink "!" glyph,
"Didn't make it", right: asker. Body: one plain line of why (from the build
error, rewritten for people: "It ran out of time on a big change", "The
code it wrote didn't run, twice"), then `Try again` (make sm, re-queues the
same request) and `Edit` (paper sm, puts the request in the composer). A
"Details" toggle reveals the raw error in mono 11 on cream, max 8 lines.

**Restore and fork events** are system notes, not cards: "Pocket restored
v12 as v16" (mint dot), "Raccoon forked v12 into Moon Party" (pool dot, the
fork name links to it).

### 6.6 Timeline

**Where it lives.** A dock at the bottom of the app column, full width of
that column, 76px tall, paper with a top `--line`. It is open whenever the
room is open, and the capsule's timeline button opens it alone over the clean
link (the app shrinks by 76px; close with its x or `Esc`). On mobile it lives
inside the sheet (6.11).

**Header row** (left, 13/800): "14 versions", then ink-soft "since Sunday".
Right: `KeyCap ←` `KeyCap →` "to step".

**Beads.** A 3px ink string across the dock with one bead per version, evenly
spaced at least 22px apart; when they do not fit, the strip scrolls
horizontally with 24px fade masks at both ends and keeps the live bead in
view on open.

- Normal bead: 18px circle, `--line`, fill cycling butter, bubble, sky,
  cream by version number (decorative only, never meaning).
- **Live bead:** 30px, mint, its number in mono 9/700 inside.
- **Building bead:** after the live bead, a 22px dashed-outline empty circle
  with the spinner inside (only while a build runs).
- **Restore bead:** diagonal ink-on-cream stripes (it repeats an earlier
  version).
- **Fork bead** (a version someone forked from): a 9px pool dot at its top
  right.
- **Focused/hovered bead:** grows to 28px over `--t-quick` `--squish`, lifts
  2px, gets the focus ring, and shows the asker's 18px face above it.
- **Viewing bead** (the one you are viewing): bubble fill and ring.

**Peek.** Hover (after 120ms) or keyboard focus on a bead opens the peek
popover above it (portal, flips below if clipped): 280px, paper, `--line`,
`--r-xl`, `--pop`, padding 12, with a pointer. Content: "v12" in 26px
display + 24px face + "Bandit · 6 min ago"; the summary 14/700; the request
in 13/500 ink-soft, quoted, 2 lines max; actions `View` (paper sm), `Restore`
(live sm), `Fork from here` (fork sm). On the live version, View and Restore
are replaced by "This is live".

**Keyboard** (when the strip has focus): ←/→ move focus one bead and show
its peek; Enter views it; `Esc` returns to live; Home/End jump to v1 and
live.

### 6.7 Viewing a past version

Viewing is private to you. When you view v12:

- The app column swaps to v12 with the same cross-fade as a new version.
- A 4px bubble inset outline frames the app column.
- **The viewing pill**, top center of the app column, 16px down: bubble fill,
  `--line`, pill, `--pop-sm`, 15/800: "You're viewing v12, nobody else is"
  followed by a paper `Back to live` sm button (radius pill). `Esc` also goes
  back.
- The room keeps showing the live conversation; your presence shows "viewing
  v12" in the header popover.
- `/<slug>/v/<n>` lands here directly, same treatment, with the capsule
  present (its Change it opens the room on live).

### 6.8 Fork flow

1. `Fork from here` opens the fork modal: 440px, cream, `--line-heavy`,
   `--r-2xl`, `--pop-xl`, over the scrim. Title "Fork v12" (`--t-h2`). A line
   in 15/500: "A new app with v12's code and a copy of its data. Its own
   room, its own link." A name field (paper, `--line`, `--r-md`, 20/700),
   prefilled "{App name}, {your name}'s take" (cut to 40 chars) and fully
   selected. Buttons: `Fork it` (fork md) and `Cancel` (paper md). Enter
   submits.
2. On submit, the button shows a spinner and the modal stays until the new
   app exists (usually under a second), then navigates to
   `/<newslug>?room`. The modal leaves with `--glide`.
3. The new room opens with a **lineage card** at the top of its stream: pool
   fill, `--line-thick`, `--r-lg`, paper text 15/800 "Forked from Tiny
   Planets v12" with a link arrow, and below in 13/600 "Same code, a copy of
   the data. Change anything." The header sub line carries the same lineage
   link.
4. The source room gets the system note with a pool dot.

### 6.9 Character picker

Opened from any you chip or face button for yourself. Modal on desktop:
1020px, cream, `--line-heavy`, `--r-2xl`, `--pop-xl`, over the scrim, two
columns.

**Left (360px, tomato, right `--line-heavy`, centered, paper text):**

- "Who are you today?" in 40px display.
- The current face at 188px, radius 56, `--line-heavy` 5px, `--pop-lg`,
  wobbling gently (2.6s loop).
- **Name field:** paper, `--line`, `--r-md`, 26px display, ink text, with a
  counter "6 / 24" in mono 11 ink-soft at its right (24 is
  `CHARACTER_NAME_MAX`); next to it a 54px butter **dice** button that picks a
  random name from this animal's six (`CHARACTER_NAMES[avatar]`). Names are
  cleaned with `cleanCharacterName` on save.
- **Name suggestions:** this animal's six names as paper `sm` chips; the
  current one butter.
- Footnote 13/600: "Everyone sees this face next to what you say and what
  you change."

**Right (padding 32):**

- "24 animals" in 30px display, and right-aligned 13/700 a legend: a mint
  badge "here" "someone in this room has it".
- **Grid:** 8 columns, 80px faces, 14px gap, `--line-thick`, `--pop-sm`;
  hover lifts 2px; the selected face gets the focus-ring treatment and a
  slight -3deg tilt. Faces worn in this room carry a mint pill badge at the
  top right with the count ("2 here", mono 10/700). The animal's label shows
  in a tooltip and as `aria-label`.
- **Keyboard:** arrows move across the grid, Enter selects, `Esc` closes;
  show these as KeyCaps under the grid in 12/600 ink-soft.
- Footer row: "Names can repeat. Faces tell you apart." (13/600 ink-soft),
  `Surprise me` (paper md: random animal and one of its names), and the
  primary `Be {name}` (make md in the display font, updates live as you
  type).
- Selecting a new animal swaps the big face with a pop (scale .9 to 1,
  `--squish`) and, if the name is still one of the previous animal's six
  defaults, swaps the name to a default of the new animal.

**First arrival:** no picker. A visitor gets `defaultCharacterFor` silently,
and the first time, a 4s toast (6.2 style) says "You're Pocket the raccoon.
Change" with "Change" opening the picker.

### 6.10 Empty, loading and error states

- **First build of a new app:** the app column shows butter with the dot
  grid, the blob at 96px gently squashing (scale 1/0.92 vertical, 1.2s), and
  below it in `--t-state` "Clay is shaping v1", with the current narration
  line in 14/600 under it. The room is open with the building card. When v1
  goes live it cross-fades in with the celebration.
- **App loading** (clean link, iframe not loaded yet): nothing for the first
  400ms (cached versions usually beat it), then the same butter dot grid with
  the blob, no text.
- **App runtime error** (the SDK reports `error`/`unhandledrejection` from
  inside the app): a 10px tomato dot appears on the capsule's timeline button
  and the room gets a Clay note "The app hit an error: {message}" with a
  `Fix it` button that fills the composer with "Fix this error: {message}" in
  Change it mode. At most one note per version.
- **Unknown app** (404): butter page, blob at 120px looking down (eyes shifted
  down 3px), "No app lives here" (h1), "Want to make one?" and the maker bar.
- **Reconnecting:** an ink pill at the top center of the shell, paper text
  13/800, "Reconnecting" with the three hopping dots; pending messages stay at
  60% opacity with a small clock. Disappears on reconnect without fanfare.
- **Image or avatar failing to load:** the face squircle shows its cream fill
  and the first letter of the name in 800 weight; never a broken image icon.
- **Empty gallery:** a single dashed card "Nothing's busy yet. Make the first
  thing." pointing at the maker bar.

### 6.11 Mobile (viewport below 768px; 768 to 1023 uses mobile room with desktop home)

- **Tap targets** are at least 44px. Hover states become press states.
- **Home:** hero 56px on 3 lines, crowd hidden, maker bar stacks the field
  over a full-width "Make it", starters scroll horizontally, gallery is one
  column with 4:3 thumbnails.
- **Clean link:** the capsule sits bottom-right 12px in, faces max 3, "Change
  it" without the KeyCap; dragging snaps to the four corners and tucking works
  on left and right edges. The toast spans the width minus 24px.
- **Room = bottom sheet** over the app (the app stays visible and usable
  above it): cream, top `--line-heavy`, top radius 28, a 44x5 ink grab
  handle. Three detents: **peek** 132px (the latest card or message and the
  composer), **half** 55vh, **full** 92vh. Drag between detents with velocity
  (a flick moves one detent), 320ms `--squish`. Opening from the capsule goes
  to half; focusing the composer goes to full; the keyboard pushes the sheet,
  never covers the composer (`visualViewport`).
- **Timeline** on mobile is a horizontal bead strip inside the sheet, between
  the stream and the composer, at half and full detents; tapping a bead opens
  the peek as a small card above the strip.
- **Picking:** starting a pick collapses the sheet to peek; the banner sits
  at the top of the app; a tap picks.
- **Picker and fork** become full-screen sheets: picker left column becomes a
  top block (face 120px, name field, suggestions), the grid is 4 columns of
  64px faces, the footer buttons are sticky at the bottom.

## 7. Link unfurls (Open Graph)

The OG image is 1200x630: butter with the dot grid, the app's still (or the
blob if none) in a paper frame with `--line-heavy` and `--pop-lg` on the
left two thirds, and on the right the app name in display 64, "38 people
changed it · v14", and up to five faces of recent changers. Title: the app
name. Description: the latest version summary.

## 8. Building it in React

- Plain CSS: `src/styles/tokens.css` (section 4), `src/styles/base.css`
  (reset, body font, focus ring, reduced-motion rules, `.keys`), and one CSS
  module per component. No Tailwind in the playground.
- Motion: CSS transitions and keyframes for everything listed here; the
  only JS-driven motion is the sheet drag, the capsule drag/snap and the
  iframe cross-fade, all with the tokens above.
- Shared parts in `src/ui/` (section 5). Surfaces in `src/surfaces/`
  (`Home`, `AppPage`, `Room`, `Stream`, `BuildCard`, `Composer`, `Timeline`,
  `Peek`, `ViewingPill`, `ForkModal`, `CharacterPicker`, `Capsule`, `Toast`).
- Every color, radius, shadow, duration and easing comes from a token. A
  number in a component's CSS that is not a token is either a one-off layout
  measure listed in this document or a bug.
