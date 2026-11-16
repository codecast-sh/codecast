---
name: cast-mod
description: Make a codecast mod, a small sandboxed module that adds panes, commands and new kinds of blocks agents can draw to the codecast app, and that reads the person's sessions, tasks, plans, PRs and more. Use when asked to customize, extend, retheme or add something to codecast's interface, to build a dashboard or view over the fleet inside codecast, or when a fenced block type should render richly everywhere.
argument-hint: "<what the mod should do>"
---

A mod is a folder: `codecast-mod.json` (what it adds and what it may touch) and
`ui.tsx` exporting `register(on)`. It runs in a sandboxed frame inside the
person's codecast app on every device, reads codecast's data from their local
store, and returns element trees that codecast draws with its own components.
The whole API, every event and every element is typed in `codecast-mod.d.ts`,
which `cast mod new` writes beside the code: read it before writing, it is the
reference.

## When someone asks what mods can do

They want to know what they could have, not how the SDK works. Answer with
what codecast could look like and do for them: their own color theme for the
whole app, the things they track (customers, bugs, deals) as objects with ids
that turn into live references, a pane or sidebar section over their work,
richer blocks in agents' replies, something that watches their machine. Tie
each to their own work where you can, and offer to build one with them now.
Leave manifests, grants and the build loop for once they pick something.

Before telling someone a mod cannot do something, try it: scaffold, push and
look. A guess from the reference is not an answer.

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
  most views.
- To read a product the team has connected to codecast (`cast connector ls`),
  grant it under `permissions.connectors` and call `$.connector.read(source,
  reader, args)`. Codecast signs those requests, so the mod holds no key, and
  each viewer reads as themselves. When the product lacks a reader the mod
  needs, add the reader to the product rather than reaching around it.
- A service with no connector that needs a key: declare the key under
  `secrets` with the origins it may go to, and call `$.http.fetch(url, {
  secret: "NAME" })`; codecast's server attaches it. Never write a key into the
  mod's code or a fetch header. The person sets the value on the Mods page;
  `cast mod push` names any key still unset, so ask them for it there.
- Keep a mod's own values in `$.state` (they survive reloads and redraw the
  mod), not in module variables.
- Start from the nouns. When the mod is about things the person names and
  follows (contacts, bugs, incidents, experiments, customers), make them an
  object kind under `objects`: a prefix, statuses and typed fields, before any
  view. Every object gets a `<prefix>-<n>` short id that reads as a live
  reference wherever codecast renders text, the same way a task does: its
  title inline, a hover card built from its status and fields, and a caret that
  opens its page right under the line. It also gets a list at
  `/objects/<prefix>`, a page at `/o/<id>` and `cast obj` verbs, with no code
  of yours. Put the rich view on that page (`on("ui.render", { object:
  "<prefix>" })`), so it shows wherever the object is expanded. Choose fields
  that make a useful preview: the hover card shows the first few filled ones.
  Read them with `$.data.list("objects", { where: { prefix } })` and write with
  `$.objects`.
- When the things live in another system (a CRM's contacts, a product's
  emails, calls or orders), declare the kind `external: true` and answer
  `object.resolve` live from that system: its own id becomes the reference and
  nothing is copied into codecast.
- An object's page is where a person opens the thing itself, so show it
  whole: an email's headers and body, a call's summary and transcript, a
  ticket's description and thread. That holds for every kind the mod
  declares, not only the few that get a rich view; a page of fields alone is
  a hover card, not a page. When the product has no reader that returns the
  full thing, look for one it already exposes, then add one. Show a link or a
  value when there is one and nothing when there is not, never a label about
  what is missing.
- `AGENTS.md` beside the manifest is the mod's surface for agents, the way a
  pane is its surface for people: every session the mod applies to starts
  with it (a team's mod in that team's projects, a personal mod everywhere),
  and it ships, versions and publishes with the rest. Write it for an agent
  that has never seen the mod: what the mod adds, and when to reach for each
  part. For an object kind, that means mentioning an object by its short id
  in prose (and filing one with `cast obj create` when a conversation turns up
  a new one), not drawing a card for it. Keep it current as the mod grows.
- A fence is for a view that is not one object: a comparison, a live query, a
  chart of many. Declare it, draw it in `on("ui.render", { fence })`, and any
  agent's ```<lang> block renders that way for everyone who has the mod.
- The elements already look like codecast, and a fence already sits in the
  frame every rich block in a message wears (a title strip, copy, fullscreen,
  a fold for tall blocks). Compose plainly and leave out colors, sizes and
  spacing unless the view needs them. A fence that returns one `Card` is the
  block: its title and actions move into the strip. `e.surface` says where a
  render lands (fence, pane, object, sidebar) when one tree should adapt.
- When the props fall short, every layout element, `Card`, `Text` and
  `Heading` takes `style`: box and type properties freely, colors only from
  the theme's `--sol-*` variables. For a view the elements cannot express,
  `Canvas` takes your own HTML and stays interactive through `data-press` and
  `data-change` names wired to its `on` handlers.
- To restyle the app, declare `themes`: an id, a title, and a `light` and/or
  `dark` palette of hex values per token (`bg`, `bg-alt`, `card`, `border`,
  `text`, `text-muted`, `text-dim`, `link`, the nine accents) plus `font-ui`
  and `font-mono` stacks. The person picks it in Settings > Appearance, and it
  recolors every surface, Tailwind's color scales included. A theme is data
  only: there is no CSS hook, so it survives every change to the app.

## The local half

When the mod needs the machine itself (files, git, processes, a private API
behind your network), add `"local": { "main": "local.ts" }` and export
`register(on)` from `codecast-mod/local`: `on("local.start")` to publish values
on a timer with `$.publish`, `on("local.call", { method })` to answer the UI's
`$.local.call`, `on("session.state")` to react to any session changing who
acts next with no window open. The UI reads published values with
`$.local.get` and redraws when they change. The daemon on each of the
person's machines starts it within 30s of a push and restarts it when it
changes; `cast mod local` shows where it runs, `cast mod revoke <name>` stops
it on one machine.

When it is done, give the person the pane's link and say what it adds and what
it may read and write.
