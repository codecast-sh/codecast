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

## The loop

```bash
cast mod new <name>        # a working scaffold: a pane, a command and a fence
cd <name>
cast mod build             # bundle and check the code against the manifest's grants
cast mod push              # push a dev build; the person's open app reloads it
cast mod logs <name>       # what it printed and threw while drawing
cast browser open "$(cast mod open <name> <pane>)"   # look at it
```

Build, push, read the logs, look, repeat until it is right. A render that
throws shows its error in place of the surface and in `cast mod logs`, so a
blank or broken pane always has a reason you can read. `cast mod publish -m
"<note>"` makes a numbered version with its source once it works.

## Writing it well

- Ask for the least the mod needs. `permissions.read` lists the collections it
  reads, `permissions.write` the writes it makes, `permissions.fetch` the origins
  it calls. `cast mod build` refuses code that reaches past its grants and names
  the grant.
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
- A fence is how agents use what the mod adds: declare it, draw it in
  `on("ui.render", { fence })`, and any agent's ```<lang> block renders that way
  for everyone who has the mod.

When it is done, give the person the pane's link and say what it adds and what
it may read and write.
