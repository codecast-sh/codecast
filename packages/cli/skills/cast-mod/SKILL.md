---
name: cast-mod
description: Make a codecast mod, a small sandboxed module that adds panes, commands and new kinds of blocks agents can draw to the codecast app, and that reads the person's sessions, tasks, plans, PRs and more. Use when asked to customize, extend or add something to codecast's interface, to build a dashboard or view over the fleet inside codecast, or when a fenced block type should render richly everywhere.
argument-hint: "<what the mod should do>"
---

A mod is a folder: `codecast-mod.json` (what it adds and what it may touch) and
`ui.tsx` exporting `register(on)`. It runs in a sandboxed frame inside the
person's codecast app on every device, reads codecast's data from their local
store, and returns element trees that codecast draws with its own components.
The whole API, every event and every element is typed in `codecast-mod.d.ts`,
which `cast mod new` writes beside the code: read it before writing, it is the
reference.

## The loop: build it with the person watching

```bash
cast mod new <name>        # a working scaffold: a pane, a command and a fence
cd <name>
cast mod build             # bundle, typecheck, check the code against the grants
cast mod push              # live in their app within seconds; prints the pane's link
cast mod logs <name>       # what it printed and threw while drawing
cast browser open "$(cast mod open <name>)"   # look at it yourself
```

Put the pane's link alone on its own line in your reply. It renders as the
running pane inside the conversation, and each later push redraws it there
(the header's rev ticks), so the person watches the mod take shape in the
thread instead of switching windows. A fence shows the same way: write an
example block in your reply. Work in small pushes: get something real on
screen first, then ask what to change. Look before you claim it works: a
render that throws shows its error in place of the surface and in
`cast mod logs`, so a blank or broken pane always has a reason you can read.
`cast mod publish -m "<note>"` makes a numbered version with its source once
it is right.

## Writing it well

- Ask for the least the mod needs. `permissions.read` lists the collections it
  reads, `permissions.write` the writes it makes, `permissions.fetch` the origins
  it calls. `cast mod build` refuses code that reaches past its grants and names
  the grant.
- See the rows a mod would get before writing against them:
  `cast browser eval "__modHost.query('sessions', { limit: 3 })"` on any open
  codecast page answers exactly what `$.data.list` answers.
- Read with `$.data.list(collection, { where, sort, limit, fields })`. It answers
  from the local store instantly, and the surface redraws by itself when those
  answers change, so a pane is live with no polling. Session rows carry a
  derived `state` (working, needs_input, done, dormant, idle) and `project`.
- Draw with the elements, not raw HTML: they follow the person's theme, draw on
  every device and keep codecast's look. `Ref` turns any codecast id into the
  live pill messages use; `Table`, `Stat`, `Chart`, `Markdown` and `Card` carry
  most views. Reach for `Canvas` only for drawing the elements cannot express.
- Keep a mod's own values in `$.state` (they survive reloads and redraw the
  mod), not in module variables.
- When the person tracks a kind of thing (bugs, incidents, experiments,
  customers), declare it under `objects`: a prefix, statuses and typed fields.
  Every object gets a `<prefix>-<n>` short id that renders as a live pill, a
  list at `/objects/<prefix>`, a page at `/o/<id>` (draw its top with
  `on("ui.render", { object: "<prefix>" })`) and `cast obj` verbs, with no code
  of yours. Read them with `$.data.list("objects", { where: { prefix } })` and
  write with `$.objects`.
- A fence is how agents use what the mod adds: declare it, draw it in
  `on("ui.render", { fence })`, and any agent's ```<lang> block renders that way
  for everyone who has the mod.

## The local half

When the mod needs the machine itself (files, git, processes, a private API
behind your network), add `"local": { "main": "local.ts" }` and export
`register(on)` from `codecast-mod/local`: `on("local.start")` to publish values
on a timer with `$.publish`, `on("local.call", { method })` to answer the UI's
`$.local.call`, `on("session.state")` to react to any session changing who
acts next with no window open. The UI reads published values with
`$.local.get` and redraws when they change. The daemon runs it only where a person approved that exact
version with `cast mod approve <name>` in a terminal, so after a push that
changes it, tell the person to run that; you cannot approve it for them.
`bun add -d @types/bun` in the folder types `node:` imports for the editor.

When it is done, give the person the pane's link and say what it adds and what
it may read and write.
