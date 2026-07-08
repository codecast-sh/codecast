# Screenshot Capture Guide

Screenshots are captured from the live production app at `codecast.sh` at retina
resolution (1440×900 logical, 2880×1800 actual) for crisp rendering on the README.
Use your personal/team workspace with the codecast project rail filter applied so
the content stays on-brand and consistent across shots.

## Current screenshots

| Filename | View | What it shows |
|----------|------|---------------|
| `hero.png` | A conversation, sidebar expanded | The full three-column workspace — nav rail, open conversation, and the session feed rail |
| `inbox.png` | `/inbox` | Session feed grouped by label with live status, model badges, and summaries next to the open conversation |
| `conversation.png` | Any conversation | Message thread with syntax-highlighted code, collapsed tool calls, and the file-changed pill |
| `command-palette.png` | `Cmd+K` over a conversation | Palette open showing conversation actions (pin, label, change model & effort, stash, kill) |
| `tasks.png` | `/tasks` | Task list in the workspace column with checkboxes and titles |
| `logo.png` | — | App mark used at the top of the README |

## How they were captured

A headless Chrome driven over the Chrome DevTools Protocol, with the Convex auth
JWT + refresh token seeded into `localStorage` for `convex.codecast.sh` before
navigating. The device metrics are set to 1440×900 at `deviceScaleFactor: 2`.

Two production-only quirks to handle when scripting captures:

- **Desktop handoff dialog** — fresh navigations on the `codecast.sh` host hand off
  to the desktop app and show an "Opened in Codecast desktop" overlay. Dismiss it
  after load by clicking the **Open in browser** button (this does not change the
  user's sticky preference). It never fires on `local.codecast.sh` or `localhost`.
- **Heavy list views** (`/plans` with hundreds of plans) need a long settle time
  before they finish rendering; give them 20s+ or capture a specific item's detail
  by full Convex id instead of the list.

To refresh a shot: capture at 1440×900 logical / retina, then drop the PNG into
this directory under the matching filename.
