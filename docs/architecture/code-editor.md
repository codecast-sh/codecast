# Code editor

Codecast edits code. The Files surface (`/files`, internally "vault") opens any
text file in a CodeMirror 6 editor with a real vim mode that reads the person's
own vimrc, tabs and split groups, quick open, project search, a git gutter,
language servers, and a session blame gutter. The same editor opens beside a
conversation from every place a path or a diff appears.

This replaces the Aug 2026 rule that source files are read-only in Files
(`VaultFileView.tsx` header, session jx7cxyq). Ashot reversed it on 2026-11-21.

## The job

A person watching agents work wants to read the code an agent touched, fix a
line by hand, steer the agent with a pointer to exact lines, and review what
changed, without leaving codecast for another editor. The primary action is
editing the file in front of them; everything else (search, jump, diff, send
to agent) is one key away.

What codecast can do that Zed, Cursor and VS Code cannot: it knows which
session wrote every line, which agent is editing a file right now, and which
conversation the person is steering. The editor shows those facts in place.

## Choices

- **CodeMirror 6, not Monaco.** CM6 is already in the bundle (the markdown
  editor), renders only the viewport, has the best vim emulation of any web
  editor (`@replit/codemirror-vim`, a CM5 Vim API port with `Vim.map`,
  `defineEx`, `defineOperator`), Marijn's official `@codemirror/lsp-client`,
  and `@codemirror/merge`. Monaco is 2-4 MB, its vim layer (monaco-vim) is
  thinner, and it fights the app's theme tokens.
- **Saving is explicit for code** (`:w`, Cmd-S), with hot exit: a dirty buffer
  is held in IndexedDB so a reload or crash loses nothing. Autosave (the notes
  default) would hand half-typed code to watchers, typecheckers and agents
  reading the disk. A setting turns autosave on.
- **Vim is on when a vimrc is found**, off otherwise, toggled from the status
  bar mode chip and in Settings > Editor.
- **The daemon is the backend.** Reads, writes, search (ripgrep), git, blame,
  vimrc and language servers all run on the machine that holds the files,
  behind the loopback bridge's existing envelope (`authorizeLocalRequest`).
  A cloud host's files are reached through the existing SSH forward
  (`hostForwardedEndpoint`, `/term/forward`), so editing works there too.

## Layout

```
packages/cli/src/code/            daemon: the /code/* routes and /lsp/ws
  codeServer.ts                   handleCodeHttp: one prefix handler, mounted in daemon.ts
  codeSearch.ts                   ripgrep --json, streamed as NDJSON; git grep fallback
  codeGit.ts                      HEAD blob, porcelain status, branch (async, proc.ts)
  codeBlame.ts                    per-line session attribution (reuses ../blame.ts)
  vimrcSources.ts                 reads ~/.vimrc and friends, follows `source`, overlay file
  lsp/                            server registry, process pool, framing, /lsp/ws
packages/cli/src/vault/           writes to source files (vaultServer PUT, vaultFs)
packages/shared/contracts/codeProtocol.ts   every request/response type above
packages/web/lib/code/            editor engine, no React
  buffers.ts                      open buffers: EditorState cache, base etag, dirty, hot exit
  languages.ts                    lazy language loading (@codemirror/language-data)
  theme.ts                        sol token theme + highlight style (shared with VaultEditor)
  vim/                            vim setup, vimrc parser + translator, ex adapters, plugins
  lsp/                            transport over /lsp/ws, client pool
  git/                            gutter + diff-vs-HEAD extensions
  blame/                          session blame gutter
  agent/                          send-to-session, agent edit highlights, presence
  commands.ts                     the workspace command registry ex adapters and palette call
packages/web/components/code/     React shell: CodeEditor, tabs, groups, status bar, panels
packages/web/store/codeStore.ts   workspace UI state (tabs, groups, panels) - never per keystroke
packages/web/app/settings/editor/ Settings > Editor (vim, vimrc report, LSP servers, options)
```

## Contracts every piece keeps

1. **A keystroke costs React nothing.** Typing in the editor commits React zero
   times and writes nothing to any zustand store. The editor's document,
   selection and undo live in CM `EditorState`. The status bar (mode, line:col,
   selection) is a ViewPlugin writing text nodes. `codeStore` changes only on
   transitions a person sees in chrome (a tab opens, a buffer goes from clean
   to dirty, a panel toggles). See the typing budget in the root CLAUDE.md.
2. **Switching tabs swaps EditorState, never remounts the view.** The buffer
   manager keeps each open file's `EditorState` (doc, undo history, selection,
   folds, vim marks) and scroll position, and `view.setState` restores it.
3. **Lazy by default.** The editor chunk loads on first open and prewarms on
   idle once Files mounts. Each language loads on first use. LSP, merge and
   blame load only when their feature turns on. Nothing new joins the main
   bundle.
4. **Writes are compare-and-swap.** Every PUT carries the buffer's own base
   etag. A 409 never overwrites: a clean buffer adopts disk, a dirty one opens
   a three-way merge (base, disk, mine). Line endings and the file's mode bits
   survive a save; saving an untouched buffer writes nothing.
5. **Global shortcuts yield to the editor.** A focused editor is a
   `data-owns-keys` region: single-key app shortcuts never fire inside it,
   vim owns Ctrl chords and Escape, and only Cmd chords the editor does not
   claim reach the app. Keys render as `<KeyCap>`.
6. **The daemon stays responsive.** No sync spawns or sync tree walks (the
   loop-budget guard). Processes spawn through `src/proc.ts`, never
   `node:child_process` directly (the ratchet). Search and language servers
   stream and cancel. Paths always resolve through `resolveVaultPath`.
7. **No personal data in the repo.** The repo is public. Tests of the vimrc
   translator use synthetic fixtures that mirror real config shapes, never a
   copy of anyone's vimrc.

## Vim

`@replit/codemirror-vim` is the engine. Codecast adds:

- **The vimrc reader.** The daemon serves the person's config (`~/.vimrc`,
  `~/.vim/vimrc`, `~/.config/nvim/init.vim`, following `source` inside the home
  folder, bounded in size and depth) plus an overlay at
  `~/.codecast/editor/vimrc` that wins. The web parses it without executing
  vimscript: line continuations, comments, `if has(...)` evaluated for a
  browser editor (nvim, gui and mac are false or true per a fixed table),
  `function`/`augroup`/most `autocmd` skipped as blocks,
  `autocmd FileType x setlocal ...` kept as per-language options,
  `let mapleader`/`maplocalleader`, `set`/`setlocal` options mapped to CM
  (tabstop, shiftwidth, expandtab, number, relativenumber, wrap, scrolloff,
  ignorecase, smartcase, hlsearch, incsearch, gdefault, clipboard=unnamed,
  colorcolumn, cursorline, list, iskeyword), every map family (map, nmap,
  vmap, xmap, omap, imap, cmap and their noremap forms, with `<silent>`,
  `<buffer>`, `<nowait>`; `<expr>` and `<Plug>` skipped), and `command` when
  its body is a plain ex command. macOS option-key glyphs (`˙`, `∆`) map as
  the characters they are.
- **Ex adapters.** Ex commands that name editor or plugin features run the
  codecast equivalent: `:w :q :wq :x :e :sp :vs :bn :bp :bd :tabnew`, `<C-w>`
  window moves to split groups, NERDTree/netrw/Explore to the file tree,
  CtrlP/FZF/Files/Telescope find_files to quick open, CtrlPBuffer/Buffers to
  the tab switcher, grep/Rg/Ag/Ack/Telescope live_grep to project search,
  Gdiffsplit/Gvdiffsplit/DiffviewOpen to diff vs HEAD, Git blame to the
  session blame gutter. A map whose right side calls an adapted command works
  through the adapter.
- **Plugins built in.** commentary (`gc`, `gcc`), surround (`ys`, `cs`, `ds`,
  visual `S`), `ae`/`ie` and `ii`/`ai` text objects, and LSP motions (`gd`,
  `gr`, `K`, `[d`/`]d`).
- **The report.** Settings > Editor shows each source file and every directive
  as applied, translated (to what) or skipped (why), filterable, so a person
  sees exactly what took effect.

## Integration

- **Files.** Source files open in the editor instead of the read-only Prism
  view. The tree shows git status colors. Quick open covers every file.
- **Beside a conversation.** A path link, a Read/Edit/Write tool card, and a
  file in a diff view open the editor beside the conversation at the line,
  through `openFilesBeside`. That conversation becomes the editor's linked
  session.
- **Send to the agent.** Cmd-L quotes the selection (`path:L10-20` plus code)
  into the linked session's composer as a pending quote
  (`addReviewComment`); a press on that quote in the composer's tray opens
  the file at those lines. Cmd-K asks for an instruction inline and sends it to
  the linked session with the range; the agent's edit then streams into the
  buffer.
- **Which session.** A session the person picks for the folder wins, then the
  conversation beside this editor's Files pane (the one it was opened from,
  `AppTab.editorOpenedFrom`, while it is on stage; when the active tab holds
  Files only that tab counts, and a conversation on another tab counts only
  if its session works in this vault's folder), then the most recently active session whose
  `project_path` or `git_root` holds the vault root. A folder link holds while
  its session still works there, so two sessions in one repo never trade
  places under the person. Cmd-K pins its target when the box opens; only the
  box's own picker changes it. Every candidate, pick and beside session must
  run on the vault's machine (`owner_device_id`: this window's daemon for a
  local vault, the host for a host vault, the source Mac for a mirror) or not
  be routed yet; the same path on another Mac is a different checkout, so it
  is neither linked nor named as a writer. Client session rows carry no `worktree_path` or
  `recent_files` (both are stripped from the inbox projection), so a session
  is matched by its project and checkout root, and an edit is attributed from
  the session's latest tool calls and the paths in its activity line while it
  is working. A bare file name in the activity line ("Editing index.ts") is a
  weak hint: ignored for a session whose transcript names a file, never used
  for presence dots, and used to name the writer of a change only when no
  other open tab in the vault shares the name. An edit no working session
  names takes a neutral color, never a guessed name.
- **Sent marker.** After a Cmd-K send the range says "sent to <session>"
  until the file changes under it or the turn that read the message ends:
  keyed by the message's client id, it waits for the message to reach the
  transcript before a turn end counts, so an instruction queued behind a
  running turn keeps its marker past that turn.
- **Agent edits, live.** When a session writes an open file, the changed
  ranges flash in that session's color and stay marked until the person moves
  on; the tab shows which session is editing the file now.
- **Session blame.** A gutter names the session that wrote each line (git
  trailer for committed lines, content match for uncommitted ones); a click
  opens that conversation.
- **Review.** Diff vs HEAD (and vs a session's base) opens as a merge view
  with per-hunk revert.
- **Elsewhere.** The command palette opens any file and runs editor commands;
  the repo blob page opens a local checkout in the editor; the terminal dock
  opens at the editor's root. Mobile is out of scope (phones read code in
  transcripts and diffs).
