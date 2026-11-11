---
name: codecast
description: Run your team and its agents in one workspace.
colors:
  accent: "#5e6ad2"
  accent-dark: "#7c86e8"
  link-dark: "#8f98f0"
  page: "#ffffff"
  sidebar: "#f7f7f8"
  highlight: "#efeff1"
  hairline: "#e4e4e7"
  panel-rule: "#ececef"
  ink: "#18181b"
  ink-secondary: "#3f3f46"
  ink-muted: "#6b6b74"
  ink-dim: "#75757e"
  ink-faint: "#a1a1aa"
  page-dark: "#0f0f11"
  sidebar-dark: "#141417"
  panel-dark: "#17171a"
  highlight-dark: "#1f1f24"
  hairline-dark: "#2a2a30"
  panel-rule-dark: "#222227"
  ink-dark: "#ededef"
  ink-secondary-dark: "#d4d4d8"
  ink-muted-dark: "#a1a1aa"
  ink-dim-dark: "#8b8b94"
  state-red: "#d93d42"
  state-amber: "#b2620e"
  state-green: "#2f8a57"
  state-red-dark: "#ef5f63"
  state-amber-dark: "#e3a24a"
  state-green-dark: "#4cb782"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.012em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  row-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, Roboto, ui-sans-serif, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0em"
  mono:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  control: "4px"
  base: "6px"
  row: "8px"
spacing:
  hair: "4px"
  sm: "8px"
  row-x: "12px"
  inset: "16px"
  page-x: "20px"
  group: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.page}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-primary-sm:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.page}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.highlight}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.highlight}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  input:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "36px"
  nav-row:
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.row}"
    padding: "5px 10px"
    height: "30px"
  nav-row-active:
    backgroundColor: "{colors.highlight}"
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
  list-row:
    textColor: "{colors.ink}"
    typography: "{typography.row-title}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  list-row-hover:
    backgroundColor: "{colors.highlight}"
  section-head:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.meta}"
    padding: "10px 16px 6px 22px"
  banner:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.ui}"
    padding: "0 16px"
    height: "36px"
  banner-action:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    typography: "{typography.meta}"
    rounded: "{rounded.base}"
    padding: "0 10px"
    height: "26px"
  panel-head:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    padding: "0 16px"
    height: "44px"
---

# Design System: codecast

## Overview

**Creative North Star: "The Quiet Desk"**

Codecast is a workspace people keep open all day beside their terminals, so it is built to the category standard set by Linear, Slack and Superhuman, played straight. Every signed-in page uses one style in light and dark: neutral greys, one indigo accent, the platform's own UI sans, hairline rules and flat surfaces. Colour is spent only on what changes what the person does next: the primary action, what waits on them, unread, focus, and real state (failed, warning, done).

Density is high and even. Lists are rows, not cards; each row has three lines (title, the state or summary, a dim context line of ID, agent, project, model and message count) with the age at the right edge in tabular figures. Text sits on a four-step scale (15 / 13 / 12 / 11) with page titles at 18. Labels are sentence case everywhere, and the system picks one way to do each thing instead of offering options: one style, six daily nav rows plus More, one banner at a time, one Filter menu, one quiet line under the new-session prompt, workers folded under the agent that spawned them.

The system rejects the incumbent mono, badge-dense, twenty-item-nav dashboard and any themed costume: no tinted section bands, no per-feature colour, no tracked all-caps labels, no thick coloured stripes, no chip rows.

**Key Characteristics:**
- Neutral greys with one indigo accent; red, amber and green only for real state.
- Platform UI sans; mono only for code and short IDs; sentence case throughout.
- Four text sizes (15 / 13 / 12 / 11) plus an 18px page title; weights 400, 500, 600.
- Flat at rest: hairline rules separate surfaces, including menus and dialogs.
- Three-line list rows, 44px panel heads, 16px content inset, left-aligned pages.
- Opinionated defaults: one of everything, with the rest under More or ⌘K.

## Colors

A cool neutral grey ground with a single desaturated indigo; everything else is ink at four strengths.

### Primary
- **Workspace Indigo** (accent; accent-dark in dark mode): the only accent. It fills the primary button (every tinted button face collapses to it), draws the focus ring, colours what waits on the person ("needs you" lines, the needs-you count, "1 needs you" on a workers line), the unread dot, links, and the default colour of your own message bubbles (mixed 25% into the page in light, 30% in dark). In code the accent is the `sol-cyan` slot: every `text-sol-cyan`, `bg-sol-cyan/N` and `ring-sol-cyan` renders indigo.
- **Link Indigo, dark** (link-dark): link text on the dark ground, one step lighter than the accent for legibility.

### Neutral
- **Paper White** (page) / **Graphite Ground** (page-dark): the work area, panel heads, banners and section heads. In dark mode the page is the deepest surface.
- **Sidebar Grey** (sidebar) / **Sidebar Graphite** (sidebar-dark): the navigation rail, one step off the page.
- **Panel Graphite** (panel-dark): cards, insets and popovers in dark mode.
- **Highlight Grey** (highlight / highlight-dark): the current nav row, the open tab, a pressed tool, row hover.
- **Hairline** (hairline / hairline-dark): borders on controls and floating layers. **Panel Rule** (panel-rule / panel-rule-dark): the lighter rule under panel heads, the top bar, the tab strip, banners and section heads.
- **Ink** (ink / ink-dark): titles, row titles, nav labels. **Secondary Ink** (ink-secondary): prose body. **Muted Ink** (ink-muted): summaries, state lines, section heads, banner text. **Dim Ink** (ink-dim): taglines, context lines, ages, counts, group labels. **Faint Ink** (ink-faint): placeholders and disabled marks.

### State
- **Fault Red** (state-red / state-red-dark): failures and the destructive button only.
- **Caution Amber** (state-amber / state-amber-dark): warnings and stale or blocked state.
- **Done Green** (state-green / state-green-dark): success and live state.

### Named Rules
**The One Accent Rule.** Indigo is the only hue that is not a state. If a colour on screen is not indigo, red, amber or green-for-state, it is grey.

**The Waiting-On-You Rule.** Indigo marks the primary action, focus, unread and what waits on the person. Group heads, project names, pins and kinds read in ink, never in colour.

**The No Bands Rule.** No tinted section bands and no per-feature colour. A group head is a muted caption on the page ground with a hairline under it.

The colour-theme picker remains; "Standard" (the neutral greys and indigo above) is the default, and other themes are options that retune the same slots.

## Typography

**UI Font:** the platform UI sans (SF Pro on Mac, Segoe UI Variable / Segoe UI on Windows, Inter, then Roboto)
**Display Font:** none; page titles and documents set in the UI face (the serif slot maps to it)
**Mono Font:** JetBrains Mono, for code and short IDs only

**Character:** The operating system's own voice, so the app sits beside the terminal and the OS chrome without a costume. Hierarchy comes from size and weight, never from case or tracking.

### Hierarchy
- **Headline** (600, 18px): the page title, followed on the same baseline by a 13px dim tagline and the page's controls at the right.
- **Title** (600, 15px, -0.012em): the conversation title in its 44px header.
- **Body** (400, 15px): what you read and write: prose, bubbles, the composer.
- **Row title** (500, 14px, 20px line): the first line of a list row.
- **UI** (400, 13px, 20px line): what you scan: nav rows, tabs, search, row summaries, banner text, empty states. Unread nav rows step to 500.
- **Meta** (400, 12px, 1.45): the line under a title: state, summary, the context line, section heads (at 500), ages.
- **Label** (500, 11px): marks: chips, times, counts, status pills. Sentence case, no tracking.

### Named Rules
**The Sentence Case Rule.** Every label, heading, button and group head is sentence case. Tracked all-caps micro labels are removed globally; a short code typed in caps (an ID, a key name) keeps its own case.

**The One Family Rule.** One sans family for everything a person reads. Mono appears only where the text is code or an identifier.

**The Tabular Rule.** Ages, counts and message totals set in tabular figures so columns of numbers hold still.

## Layout

The shell is a resizable split: the sidebar takes about 15% of the window (about 216px at 1440px), the page the rest. The top bar carries history and layout toggles at the left, search and New in the middle, and the account avatar, notifications and settings at the right. One strip may sit under the top bar at a time; later strips wait their turn.

The sidebar lists six daily rows (Inbox, Decisions, Chat, Tasks, Docs, Calls when calls are available) and a More toggle that holds every other page; workspaces follow under a dim group label. No route is removed: anything under More is also reachable from search, ⌘K and links. Beside the inbox board the session rail is hidden, because the board already lists every session; opening a session brings it back.

Pages are left-aligned, not centred: content starts 20px from the page edge (16px top padding), so every page title shares one edge with the list toolbars beside it. Panels start their content 16px from their edge and every panel head is 44px tall, so the conversation header, the rail head and the list head share one line across the screen. The tab strip is 36px and appears only when there is a second tab.

Rhythm: 4px hair steps, 8px between related items, 12px row padding, 16px inset, 24px between groups. On mobile the sidebar becomes a drawer and the panes stack.

### Named Rules
**The One Line Rule.** Every panel head is 44px and every content edge is 16px in, so heads and content align across panes.

**The One Banner Rule.** Only the first strip in priority order shows; the rest wait until it is dismissed or acted on.

## Elevation & Depth

The system is flat. Surfaces are separated by tone (page, sidebar, highlight) and hairline rules, not by shadow. Menus, popovers, listboxes, tooltips and dialogs are set apart by a hairline border on the panel ground with no shadow. The filled button face is the one resting exception: a faint top light, an inner hairline and a short soft shadow, so the primary action reads as pressable.

### Shadow Vocabulary
- **Button face** (see sidecar `button-face`): filled buttons only; turns inward on press.

### Named Rules
**The Hairline Rule.** Anything that floats is set apart by a hairline, never a shadow.

## Shapes

Small, even corners. Buttons and inputs take the control radius (4px); the base radius (6px) covers list rows, banner actions and cards; navigation rows take the softer row radius (8px). Borders are 1px hairlines. No coloured stripe down a row's or card's left edge is wider than 1px: a selected or flagged item carries its state in its fill and a hairline. Icons are 16–17px stroke glyphs at a 1.7 stroke, in the row's own ink.

## Components

### Buttons
Quiet and few: one filled action per view, the rest secondary or ghost.
- **Shape:** control radius (4px); heights 36 / 32 / 28px (default, sm, xs).
- **Primary:** indigo fill with a white label and the button face; violet, green, blue, amber, orange and yellow tinted faces all render as this primary. Red is reserved for the destructive button.
- **Hover / Focus:** hover drifts the fill toward its label colour over 150ms; press sinks half a pixel and turns the shadow inward; focus is a 2px indigo outline offset 2px.
- **Secondary / Ghost:** secondary is a highlight-grey face with an inner hairline in its label colour; ghost is bare until hover fills it with highlight grey.

### Inputs / Fields
- **Style:** 1px hairline, transparent ground, control radius (4px), 36px tall, 13px text on desktop.
- **Focus:** a 1px indigo ring.
- **Disabled:** 50% opacity.

### Navigation
- **Rows:** 30px tall, 10px horizontal padding, 10px gap to a 17px stroke icon, 13px at 400 in ink. The current row is a highlight-grey fill alone: no stripe, no colour, no weight change. Unread rows are 500. Counts are dim numbers at the right edge, not badges.
- **Group labels:** 13px dim ink, sentence case, on the same left edge as the row icons.
- **More:** a chevron row that expands every page past the daily six.
- **Mobile:** the same list in a drawer.

### List rows (signature)
The three-line row is the system's unit of agent work, used on the inbox board and the session rail.
- **Line 1:** row title (14px, 500, ink), truncated.
- **Line 2:** the state, blocker or summary (13px muted; indigo only when it waits on the person).
- **Line 3:** short ID · agent · project · model · msgs (12px dim), joined by middots.
- **Right edge:** the age in 12px dim tabular figures.
- **States:** hover is a 4% ink wash; the open row is a neutral grey fill running the full rail width; no border, no shadow, a hairline between neighbours in the rail.
- **Groups:** Needs you / Working / Done heads are 12px muted 500 captions with the count beside them, the needs-you count in indigo when non-zero.
- **Workers:** sessions an agent spawned fold under their parent; the parent shows one 12px muted line, "N workers · 1 needs you", with only "needs you" in indigo.

### Page header
An 18px semibold title, then on the same baseline a 13px dim tagline (or the live counts, "0 need you · 0 working · 7 done"), and the page's controls (a segmented toggle, a Filter menu, New) at the right.

### Filter menu
One quiet Filter button in the panel head replaces the chip row. It opens a menu of recent folders and labels; while a filter is on, the button names it.

### Banner strip
One 36px row under the top bar on the page ground with a panel-rule hairline below: a 14px dim icon, 13px muted text, one secondary action (26px, 6px radius, hairline, 12px 500 ink) and a dim dismiss. Never tinted.

### New session line
The new-session view is the prompt box and one quiet line beneath it, "in <folder> · <agent> · <machine>", each part 12px muted text that opens its own picker, then Options for everything else.

## Do's and Don'ts

### Do:
- **Do** spend indigo only on the primary action, focus, unread and what waits on the person.
- **Do** keep red, amber and green for real state: failed, warning, done or live.
- **Do** set every label in sentence case, in the platform UI sans, on the 15 / 13 / 12 / 11 scale with 18px page titles.
- **Do** use mono only for code and short IDs.
- **Do** build lists from three-line rows with the age right-aligned in tabular figures.
- **Do** separate surfaces with tone and hairlines; set floating layers apart with a hairline.
- **Do** give each thing one way: one Filter menu, one banner, one primary button per view, new pages under More.
- **Do** nest spawned workers under their parent with one "N workers · 1 needs you" line.

### Don't:
- **Don't** tint section heads, bands or whole features; group heads read in muted ink.
- **Don't** use tracked all-caps micro labels or eyebrows above titles.
- **Don't** draw a coloured left stripe wider than 1px on a row, card or callout.
- **Don't** fill buttons in feature colours; every filled action is the indigo primary, or red when destructive.
- **Don't** add chip rows, badge counts or pills where a dim number or one menu will do.
- **Don't** stack banners; a second strip waits for the first.
- **Don't** put a shadow on a panel, row or popover at rest.
- **Don't** add a top-level nav row for a new feature; it belongs under More.
