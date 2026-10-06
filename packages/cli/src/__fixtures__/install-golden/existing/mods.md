# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Mods

A mod extends the codecast app itself: panes, palette commands, sidebar sections, new kinds of objects (`bug-14`) with their own pages and live pills, fenced blocks that draw richly wherever markdown renders, and optionally a local half that runs on the person's own machines. It is one small sandboxed module that reads their sessions, tasks, plans, pull requests and more from the app's local store. When someone wants a view, a dashboard, a tracker or a control inside codecast, or wants some kind of output to render as more than code, build it as a mod.

Build it with the person watching, in small steps:

```bash
cast mod new <name>     # a working scaffold; codecast-mod.d.ts beside it types every event, $ method and element: read it first
cast mod build          # bundle, typecheck, and check the code against the grants in codecast-mod.json
cast mod push           # live in their app within seconds; prints the pane's link
cast mod logs <name>    # what it printed and threw while drawing
cast mod publish -m "<note>"   # once it is right: a numbered version with its source
```

Put the pane's link alone on its own line in your reply: it renders as the running pane right in the conversation, and every later push redraws it there, so the person sees each change land without leaving the thread. Show a fence the same way, by writing an example block in your reply. Before saying something works, look at it (`cast browser open` the link) or read `cast mod logs`: a render that throws shows its error in place and in the logs. Then ask what to change, and push again.

Grant only what the mod reads and writes. A local half runs only where the person approves it in their own terminal (`! cast mod approve <name>`); you cannot approve it for them. When work produces something a person will track and a kind for it exists, file it there rather than in prose: `cast mod guide` prints what the running mods ask of agents, and `cast obj kinds` the objects they track.
<!-- cast @VERSION@ -->
<!-- /codecast-mods -->
