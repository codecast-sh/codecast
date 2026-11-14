# Screenshot capture guide

The product screenshots in the README, the docs page and the guides come from the real app running in docs shots mode: a dev-only build that renders every route over a fixture "Acme" workspace (Alex Rivera, Maya Ortiz and Sarah Chen working on webhook retries) with no server, its own origin, and no outbox. Nothing from a real workspace can reach an image, which matters because this repository is public. Never capture the live app for a public image: a real inbox shows other teams, private sessions and people's faces.

The fixture world lives in `packages/web/lib/acmeWorld/`, shared with the phone's store shots mode. Change it there and recapture to change what a shot shows.

## How shots are made

```bash
packages/web/scripts/docs-shots-dev.sh                    # shots server on :3290
bun packages/web/scripts/docs-shots.ts                    # every shot
bun packages/web/scripts/docs-shots.ts --batch <name>     # one batch
bun packages/web/scripts/docs-shots.ts <name> <name>      # just these
```

Each shot is one entry in `packages/web/docs-shots/batches/<batch>.ts`: the route, any setup, the crop, and the output path under `packages/web/public`. The script captures at 2x and composes the capture through `packages/web/docs-shots/frame.html` (window, element or phone frame, Modern palette plate) into a `.webp`. `packages/web/docs-shots/README.md` has the details. Phone shots come from the iOS simulator in store shots mode (`packages/mobile/store-shots/`) and go through the same frame with `--batch phone`.

## The README set

The PNGs here are the README's copies of framed docs shots, scaled to 1920 wide (the phone shot to 900):

| File | Source under `packages/web/public` |
|---|---|
| `hero.png` | `docs/app/inbox.webp` |
| `inbox.png` | `documentation/shots/inbox.webp` |
| `conversation.png` | `docs/app/diff.webp` |
| `fanout.png` | `documentation/forks-and-spawn/workers.webp` |
| `mobile-chat.png` | `docs/app/mobile-session.webp` |
| `session-messages.png` | `documentation/shots/session-messages.webp` |
| `tasks.png` | `docs/app/tasks.webp` |
| `automations.png` | `docs/app/triggers.webp` |
| `team-chat.png` | `docs/app/chat.webp` |
| `pull-request.png` | `documentation/shots/pull-request.webp` |
| `pages.png` | `documentation/publish/page.webp` |
| `command-palette.png` | `docs/app/palette.webp` |
| `blame.png` | `documentation/which-session-wrote-this-line/session-blame.webp` |
| `logo.png` | App mark used at the top of the README |

To refresh one after recapturing its source:

```bash
magick packages/web/public/docs/app/inbox.webp -resize '1920x>' -strip docs/screenshots/hero.png
```

Look at every capture before keeping it.
