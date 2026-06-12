# Codecast — session blame (VS Code / Cursor)

`git blame`, but the author column is the **codecast session** (and the person)
that wrote each line — and you can jump straight to the conversation behind it.

This extension is a thin client over the `cast` CLI: it shells out to
`cast blame …`, which holds your auth token and resolves each line's SHA to a
session server-side. So all attribution logic is shared with the terminal and
the vim-fugitive integration.

## Requirements

- The **codecast CLI** installed and authenticated (`cast auth`). If `cast`
  isn't on your editor's `PATH`, set `codecast.cliPath` to its absolute path
  (find it with `which cast`).

## Features

- **Inline session blame** — the session that wrote the current line shows at
  the end of the line (like GitLens current-line blame), plus a status-bar
  item. Toggle with **Codecast: Toggle Inline Session Blame**.
- **Open Session for Current Line** — `Cmd/Ctrl+Alt+B` (or right-click) opens
  the conversation that wrote the line, anchored to the exact edit.
- **Session Log for File** — `Cmd/Ctrl+Alt+L` lists every session that shaped
  the file, newest first; pick one to open its conversation.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codecast.cliPath` | `cast` | Path to the `cast` CLI. |
| `codecast.inlineBlame` | `true` | Show the current-line session annotation. |

## Coverage

A line resolves when it was committed (or written) through a synced codecast
session you can see. Other lines simply show nothing — the same model as the
terminal `cast blame`.

Learn more: https://codecast.sh/documentation#editor-integration
