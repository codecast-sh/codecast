Most tools let an agent change your code. Codecast also lets an agent change the tool. A mod adds panes, palette commands, sidebar sections, whole new kinds of objects (`bug-14`, `inc-3`) and blocks that draw richly wherever markdown renders. You ask for a dashboard, a tracker or a control in the conversation, the agent builds it as a mod, and you watch the running pane redraw in the thread each time it pushes a change.

## What a mod adds to the app

| What | Where you see it | What happens |
|---|---|---|
| Panes | A tab of their own, or one cell of a split | A full page drawn by the mod. Its header shows the version and revision, with **Logs** and **All mods** buttons. |
| Palette commands | A **Mods** group in the command palette | Panes open as tabs; commands run in place, with no page change. A failure shows as a toast. |
| Sidebar sections | Under the app's nav | A titled section, such as "Open bugs", whose contents the mod draws. |
| Blocks | Messages, docs, comments and cards | The mod claims a block type (`bug`, `incident`) and every place markdown renders draws that block through it. With the mod off, the block reads as plain code. |
| Object kinds | A board, a page per object, and pills | New first-class objects with their own numbering, statuses and typed fields. |
| A local half | Your own machines | Code that can read files and processes on a machine you approved, feeding values to the panes. |

Mods are drawn with codecast's own cards, tables, stats, charts, tabs and pills, so a mod looks native rather than embedded. They read your sessions, tasks, plans and pull requests from the app's local store, so a pane fills instantly and updates as sessions move.

![The Fleet Pulse mod open as a pane in codecast: four stat tiles (working, needs you, done, parked) over a table of sessions waiting on the viewer](/blog/field-manual/mods-pane.webp "Fleet Pulse, a small mod, running as a tab inside the app. The tiles and the &quot;Waiting on you&quot; table read straight from the local store, so they update as sessions move.")

## Building one in the thread

You describe what you want; the agent writes the mod and pushes it. A link to a mod pane alone on its own line in a message renders the running pane right there in the conversation, with an **Open** button to pop it into a tab. Every later push redraws it in place: the header flashes violet and the revision number ticks up, so you see each change land without leaving the thread. You say what to change, the agent pushes again.

When something breaks, it breaks small. A pane that fails to draw shows a red box in its own spot with **Try again**, and if a redraw fails the last good drawing stays on screen with a one-line note under it; the conversation and sidebar around it are untouched. The agent reads the same errors you see under **Logs**, so "it threw on an empty list" is usually fixed before you mention it. When the mod is right, the agent publishes it as a numbered version.

The **Mods** page lists everything you and your agents added: each card says whether it is running, off or failed, what it adds (panes, commands, blocks) and what it may touch ("reads sessions", "writes tasks"), with an on/off switch, its logs and an **Open** button. A workspace with no mods yet offers **Ask an agent** as the way in. (Agents, and anyone who prefers a terminal, can also start from a working scaffold with `cast mod new`.)

## Mods teach agents new nouns

A mod that adds an object kind changes what your agents do, not only what you see. In this workspace two showcase mods add bugs and incidents. Each kind gets a board with one column per status (triage, open, fixing, fixed), where you drag cards between columns, a table view, and a "New bug…" field at the top. Each object gets its own page with an editable title, status buttons, its typed fields (severity, area, the session it came from) and markdown notes. And `bug-14` written anywhere, in a message, a doc, a task comment, renders as a live pill with the bug's title, dimmed and struck through once it is fixed.

The mod also tells agents how to use it. Every agent learns that when it finds a bug it is not fixing in this session, it should file one rather than mention it in passing, or, to leave the call to you, write a `bug` block in its reply. That block draws as a card with the mod's button to file it, so a finding becomes a tracked `bug-N` with one click instead of a paragraph that scrolls away.

## The trust model

A mod's interface runs in a locked-down sandbox: no access to the page around it, no navigation, and network calls only to the sites its manifest names. Every read and write is checked against the grants the mod declared, and a mod writes only the object kinds it owns. It sees your name, never your email.

A teammate's mod appears under **Shared by your team** and runs for you only after you press **Install**, at the grants shown on its card. If its author later widens what it may read, write or fetch, it stops and the button reads **Grants changed: review** until you install it again. A local half runs only on a machine where a person approved that exact version of its code, by typing the mod's name in a terminal there; agents are told they cannot approve their own.

> **Why it matters.** The team's workflow stops being limited to the views codecast ships. If a team tracks incidents, an agent builds the incident desk in an afternoon, and from then on every agent knows the noun, files the object, and renders the block. Live redraws in the thread make building one a conversation instead of a deploy.
