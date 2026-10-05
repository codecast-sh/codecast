# Screenshot capture guide

The product screenshots come from the product film on the codecast.sh homepage. The film renders
the real product views (inbox, conversation, task board, PR page and so on) inside a sandbox fed
only by fixture data: a made-up "Acme" workspace with Alex Rivera, Maya Ortiz and Sarah Chen
working on webhook retries. Nothing from a real workspace can reach the image, which matters
because this repository is public. Never capture the live app for a public image: a real inbox
shows other teams, private sessions and people's faces.

The fixtures live in `packages/web/app/(marketing)/heroFly/fixtures/` and the chapters that lay
them out in `heroFly/chapters/`. Change a fixture there and recapture to change what a shot shows.

## Current screenshots

Each shot is 1920×1140, captured at 2x from the film's native 1280×760 stage and scaled down.

| File | Film time (`hero-t`) | What it shows |
|---|---|---|
| `hero.png` | 40.7 | Inbox, an open conversation, and a decision card answered inline |
| `inbox.png` | 6.6 | Sessions grouped by who acts next, next to the open conversation |
| `conversation.png` | 11.5 | A conversation with an inline diff and a tool call |
| `fanout.png` | 18 | Two workers (Cursor and Codex) spawned by one lead |
| `mobile-chat.png` | 27 | A worker's question answered from the phone |
| `session-messages.png` | 33.5 | Two sessions messaging each other |
| `tasks.png` | 46.5 | A project's tasks with status, links to Linear, and activity |
| `automations.png` | 53.3 | A workflow graph, triggers, and a run paused at a gate |
| `team-chat.png` | 58.5 | Team channel with an agent replying, and a transcribed huddle |
| `pull-request.png` | 65.5 | A PR page with its owning session, checks and review |
| `pages.png` | 72.5 | A published report with viewer comments |
| `command-palette.png` | 77.5 | Palette search across sessions and tasks |
| `blame.png` | 80.7 | `cast blame` in the repo view: each line's session |
| `logo.png` | | App mark used at the top of the README |

## How to capture

```bash
cast browser open "https://codecast.sh/?hero-t=6.6"
bun packages/web/scripts/readme-shots.ts            # every shot in the table
bun packages/web/scripts/readme-shots.ts inbox pr   # just these
```

The script (`packages/web/scripts/readme-shots.ts`) freezes the film with `?hero-t=<seconds>`,
dismisses the desktop handoff overlay, lifts the film out of the page column so it lays out at its
native 1280×760 with no scale, captures it at 2x over the cast browser bridge (`cast browser shot`
captures at 1x), and writes 1920×1140 PNGs here. To add a shot, add a name and a time to its
`SHOTS` table: the chapter windows are `CHAPTERS` in `heroFly/world.ts`, each with a `hold`; pick a
time inside one, after the chapter's motion settles.

Look at every capture before keeping it. A time between holds catches windows mid-fade.
