# Installed app examples

Four published pages written to be installed as desktop apps (Share menu,
Install as app). Each folder is a page bundle: `index.html`, `cast-data.json`
with its `app` block, a 1024 px `icon.png`, and the fonts it uses. The
contract they build on is `docs/architecture/installed-apps.md`.

| App | What it does | Asks for |
|---|---|---|
| `needs-you/` | The flagship: a menu bar app counting what waits on you. Reads the `waiting` reader (your sessions the inbox files under Needs input, open decisions asked of you, your tasks in review or blocked), puts the count on the Dock and the menu bar, splits it by kind, and notifies once per new item. Clicking a row or its notification opens the item in Codecast's own window (`cast.app.openInCodecast`); in a browser tab it opens codecast.sh. | `notifications`, `menu-bar` |
| `team-queue/` | A menu bar app for codecast. Counts the team's tasks in review and its open issues (the whole workspace's human board, not one person's), lists the issues, puts the total on the Dock and the menu bar, and notifies once per new issue and when more tasks reach review. With the window and the popover both open, only the window notifies. The menu bar popover is the same page in a tighter layout. | `notifications`, `menu-bar` |
| `standup-board/` | A team standup on `cast.state`: one row per person per day with yesterday, today and blocked. Notifies you when a teammate is blocked on you or mentions you (`@Ada`). Pin keeps a narrow window on top; ⌘⇧U (Ctrl+Shift+U) opens quick add from anywhere. | `notifications`, `overlay`, `shortcuts` |
| `repo-pulse/` | A local git dashboard for the page's owner. Remembers a folder, runs `git status` and `git log`, and refreshes when files change. Without full access it shows the refusal's reason and an Approve button. | `full-access` |

Each one works in a browser tab too: Needs you, Team queue and Standup without their app
controls, Repo pulse as a screen that explains it runs on the computer.

## Publish and install

```bash
cast publish examples/installed-apps/needs-you
cast publish examples/installed-apps/team-queue
cast publish examples/installed-apps/standup-board
cast publish examples/installed-apps/repo-pulse

cast publish install examples/installed-apps/needs-you    # opens the install sheet; the person chooses the permissions
```

A page's readers run as its publisher, so on your own install Needs you is
your queue. Publish it in your personal workspace (`"workspace": "user:<your
id>"` in its `cast-data.json`) to count everything of yours; a team workspace
counts only what the team may see: team-visible sessions and the decisions
they asked, and tasks in that workspace. The data refreshes at most once a
minute, so a new ask can take up to a minute to reach the count. Anyone
holding the page's link reads the same list, so keep the link to yourself
or gate it.

Team queue's queries run as you in the publishing session's workspace. To pin
it to your personal workspace, add `"workspace": "user:<your id>"` to its
`cast-data.json`. Standup is meant for a team: publish it from a team
workspace and share the link.

## Trying them locally

```bash
node examples/installed-apps/dev/serve.mjs            # http://localhost:4317/<app>/
```

`dev/serve.mjs` injects `dev/fake-cast.js` ahead of the page: `cast.data`
from fixtures, `cast.state` in localStorage (live across tabs), and
`cast.me()` as `?me=<name>`. Add `?app=window` or `?app=tray` for a faked
`cast.app`, `&grants=notifications,menu-bar` for what is granted, and
`&deny=notifications:not-allowed-by-team` to try a refusal. Notifications
and the badge show in a small strip; click one to fire `notification-click`.
`__fake.data(id, rows)` and `__fake.as(name, collection, key, value)` play
new data and a teammate's write from the console.

```bash
node examples/installed-apps/dev/electron-run.mjs team-queue            # or standup-board, repo-pulse, repo-pulse-refused
```

`dev/electron-run.mjs` installs one app in the real Electron-window host
from source, with a throwaway profile, the way
`packages/electron/installedApps/host.electron.test.js` does. It approves the
install sheet, drives the app over DevTools, checks what it should do and
saves screenshots to `~/.codecast/tmp/installed-apps-demos` (`--shots <dir>`
to change). Notifications are recorded, never shown.

`node examples/installed-apps/make-icons.mjs` redraws the icons.
