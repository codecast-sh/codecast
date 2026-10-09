
## Mods

A mod extends the codecast app itself: panes, palette commands, sidebar sections, new kinds of tracked objects (`bug-14`) with their own pages and live pills, fenced blocks that render richly wherever markdown does, and optionally a local half on the person's own machines. It is one small sandboxed module that reads their sessions, tasks, plans and pull requests from the app's local store. When someone wants a view, tracker or control inside codecast, or some output to render as more than code, build it as a mod, in small steps with them watching:

```bash
cast mod new <name>            # a working scaffold; read codecast-mod.d.ts beside it first
cast mod build                 # bundle, typecheck, and check the code against its grants
cast mod push                  # live in their app within seconds; prints the pane's link
cast mod logs <name>           # what it printed and threw while drawing
cast mod publish -m "<note>"   # once it is right: a numbered version with its source
```

Put the pane's link alone on its own line in your reply: it renders as the running pane and redraws on every push. Before saying something works, look at it or read its logs. Grant only what the mod reads and writes; a local half runs on each of the person's machines within 30s of a push. When work produces something a person tracks and a kind for it exists, file it there: `cast mod guide` prints what running mods ask of agents, and `cast obj kinds` the objects they track.
<!-- cast @VERSION@ -->
<!-- /codecast-mods -->
