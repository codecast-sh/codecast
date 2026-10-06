
## Mods

Agents build mods that extend the codecast app, live in the conversation (cast mod). Teaches agents to build mods: small sandboxed modules that add panes, palette commands, sidebar sections, fenced blocks and new kinds of tracked objects (bug-14) to the codecast app, reading your sessions, tasks, plans and pull requests from the local store. The agent pushes each change and the running pane redraws inline in the conversation, so you watch it take shape and say what to change. A mod touches only what its manifest grants; a local half that runs on your machine starts only after you approve it in your own terminal, and every version keeps its source.

Run `cast guide mods` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-mods -->
