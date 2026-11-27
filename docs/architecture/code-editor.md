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
  bar mode chip (on screen while off too, as a dim "Vim") and in Settings >
  Editor.
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
  theme.ts                        sol token theme, highlight roles, overlay look; syntax colors
                                  match Prism's (codeHighlightParity.test.ts)
  vim/                            vim setup, vimrc parser + translator, ex adapters, plugins
  lsp/                            transport over /lsp/ws, client pool
  git/                            gutter + diff-vs-HEAD extensions
  blame/                          session blame gutter
  agent/                          send-to-session, agent edit highlights, presence
  commands.ts                     the workspace command registry ex adapters and palette call
  gutterSlots.ts                  each lazy gutter's column, and its stand-in while it loads
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

8. **Columns never shift the text.** A feature that loads after the first
   paint and draws a gutter (blame, lint, git) or changes the core's options
   (vim's `nonumber`) passes `placeholder` to `registerEditorFeature`: a
   synchronous stand-in, decided from what is already known, that holds its
   slot at the real gutter's precedence and width (`gutterSlots.ts`). The
   real extension replaces it in the same compartment; a feature that ends
   up drawing nothing, or fails, gives the column back.
9. **One "editor the person was in".** Commands run without a view (the
   palette, a chip) act on `focusedEditorView()` from features.ts, never a
   tracker of their own.
10. **Idle costs what is on screen.** Agents save files all day, so an open
   editor pays per save only for what it shows: watcher events land in
   batches, the daemon is asked once per burst, one request per kind is in
   flight, a hidden page asks nothing until it is shown (`whenVisible`,
   idle.ts), and a file no buffer holds is not read again. The budgets and
   their numbers are in packages/web/perf/README.md ("Editor").

## When disk and the daemon disagree

Every state below is a strip over the editor and a mark on the file's tab
(the dot's slot: yellow waits on the person, red is deleted or refused), the
same mark in the tab switcher and quick open (`FileStateMark`). Nothing in
any of them drops text: hot exit holds every dirty buffer.

- **Read-only mode (0444).** The daemon's read sends `X-Vault-Writable: 0`
  and the mode, so the status bar's lock shows the mode before any save; the
  file stays editable, as in vim. A save the daemon refuses (403 read-only)
  opens the "Read-only on disk" strip; its Overwrite, the lock itself and
  `:w!` go through the shared confirm, then resend with `force=1`, still on
  the buffer's etag, the mode bits kept.
- **Read-only in the editor.** The lock names why: `mirror` (another
  machine's vault), `offline` (held text shown while the daemon
  reconnects; the lock reconnects), `encoding` (text that did not decode). A
  save that writes nothing flashes the lock.
- **Daemon unreachable.** A save that got no answer (no endpoint, a refused
  connection, a timeout) is "Not saved · Reconnecting", and runs again when
  Files reconnects; any answer from the daemon is a refusal ("Save failed"
  with its reason word). After a reconnect's rescan, open code files whose
  mtime moved are read again.
- **Deleted under the app.** An agent's `rm`, a branch switch or a stash
  keeps the tab, struck through, with Recreate; the file returning drops
  back into it. Only the person's own delete in the tree closes clean tabs.
- **Renamed under the app.** The watcher's removed plus add is followed as a
  rename when the added file has the same size and its etag is the buffer's
  base: tabs, unsaved text, hot exit and history move to the new path.
- **Large files** (past `LARGE_FILE_BYTES`) say "Large file" in the status
  bar; language servers, word completion and selection matches are off.

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
  codecast equivalent: `:w :q :wq :x :e :sp :vs :bn :bp :bd :tabnew`, `:b#`,
  `:e#` and `<C-^>` to the alternate tab, every `<C-w>` key to split groups
  (moves, `w`/`W`/`p`/`t`/`b` focus, `x`/`r` swap, `H J K L` to an edge,
  `=`, `_`, `|` and counted `+ - < >` sizes; a key with no counterpart is
  spent with a note, never passed to the engine as a command), NERDTree/netrw/Explore to the file tree,
  CtrlP/FZF/Files/Telescope find_files to quick open, CtrlPBuffer/Buffers to
  the tab switcher, grep/Rg/Ag/Ack/Telescope live_grep to project search,
  Gdiffsplit/Gvdiffsplit/DiffviewOpen to diff vs HEAD, Git blame to the
  session blame gutter. A map whose right side calls an adapted command works
  through the adapter.
- **Command line.** gdefault flips `:s`'s `g` flag on the way into the
  engine (vim/gdefault.ts), which has no such option. Tab completes command
  names, paths for `:e :sp :vs :tabe` and open tabs for `:b`, wildmenu style
  (vim/complete.ts). While vim runs, `<C-o>`/`<C-i>` stops are the engine's
  own jumps (G, gg, /, n, *, %, marks) plus file switches, never a line
  distance.
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
  buffer. A vimrc's own Cmd maps win over both (vim takes the key first), so
  each has vim ways in that never collide: `:Ask instruction` sends it about
  the line, a typed range or the visual selection to the linked session at
  once (bare `:Ask`, or no linked session, opens the box instead, prefilled),
  `:Quote` quotes it, and `<leader>k` / `<leader>l` (normal and
  visual) are bound unless the vimrc maps those keys or keys that start with
  them.
- **Which session.** A session the person picks for the folder wins (kept per
  vault in localStorage beside the code workspace), then the
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
- **Sent marker.** After a Cmd-K send the range says "sent to <session>",
  with a dot that is hollow while the message waits and filled in the
  session's color once its turn runs, until that range's lines change (typed,
  or written on disk; a write elsewhere only maps it) or the turn that read
  the message ends:
  keyed by the message's client id, it waits for the message to reach the
  transcript before a turn end counts, so an instruction queued behind a
  running turn keeps its marker past that turn.
- **Agent edits, live.** When a session writes an open file, the changed
  ranges flash in that session's color (the fade starts when the buffer is
  first on screen) and keep a bar and a scrollbar tick until the cursor
  enters them (the bar is drawn over the git bar's place, so it takes no
  column, and a session's color is never git's green, red or blue), the bar is clicked, or `:AgentClear` / the status item's ×
  clears them; Escape never does. The status bar counts them in the writer's
  color, and a press on the count, `]a`/`[a` or Alt-F6/Shift-Alt-F6 (beside the git hunk pair on Alt-F5; Cmd-Alt-arrows move between groups) steps through
  them. Over unsaved edits the write merges at once: lines only disk changed
  land (marked the same way) and the person's own stay unsaved; a region both
  wrote opens the merge view, its conflicts red-barred, counted apart from the
  person's clean edits and stepped to first. Keep mine writes the person's
  text over that disk version on its etag; Take disk drops theirs. The tab
  shows which session is editing the file now.
- **Session blame.** A gutter names the session that wrote each line (git
  trailer for committed lines, content match for uncommitted ones), in the
  same color the session takes everywhere in the editor (sessionColor); a
  click opens that conversation beside, scrolled to the message that made
  the edit (`/conversation/<id>#msg-<mid>` as a stage leaf).
- **Review.** Diff vs HEAD or any ref (the picker: previous commit,
  upstream, merge base, and each session's base, in its color) opens inline
  or side by side, with Revert as the one per-hunk action. A session's base
  is read off its own commits (`sessionGitRefs`, lib/code/agent/sessions.ts):
  the parent of its first commit, HEAD while it has committed nothing, never
  the branch's merge base, which on a trunk checkout holds other sessions'
  commits. The conversation diff's Edit opens the same refs (Session, Commit
  as the session's last commit, Branch as the merge base), and the picker
  offers the linked session's and every blamed writer's. A PR, commit or
  compare diff gives each file an Edit into this machine's checkout, with the
  diff against the PR base, the commit's parent or the compare base when the
  checkout holds that revision. A new file (untracked or added) has no gutter
  and diffs against nothing ("New file") or an older ref. The side-by-side
  pane's commands (vim's `]c`, Alt-F5) act on its diff. An edit tool card
  opens at the edit's text where it is now, with its old lines peeked.
- **Terminals.** A path in terminal output (the dock's shells, a
  conversation's attached pane, a host's relayed pane) is a link: `x.ts:12:4`,
  tsc's `x.ts(12,4)`, a grep hit, a `git status` line (lib/terminal/fileLinks.ts,
  the prose grammar of filePathLinks plus the `(line,col)` suffix). A relative
  path resolves where the shell is now: the daemon's `/term/sessions` carries
  tmux's `pane_current_path` as `cwd`, read at the click with a 400 ms cap
  and without touching the panel's probe state (most shells never report a
  `cd`), else what OSC 7 last reported, else the start directory. In
  an agent's pane it resolves in the conversation's project. It opens on the
  pane's machine.
- **Messages.** A ```cast-diff fence's file cards carry Edit, at the file's
  first changed line, the path resolved from the session's checkout root
  (a git diff names files from there). Outside a conversation nothing
  resolves it and the card has none. A plain code fence carries no path the
  agents write, so it has no Edit.
- **Tasks and plans.** Paths cited in a task's comments, an inline task
  thread's description and a plan's doc resolve in the task's or plan's
  `project_path` (useFolderPathContext), so `lib/x.ts:38` opens that
  project's file; a row with no project keeps the context around it (a
  thread inside a conversation keeps the conversation's). Task and plan rows
  name no machine, so the folder opens on the editor's default vault, which
  is wrong when the row came from another machine. The task description is a rich-text editor and does not link paths.
- **Review threads.** A PR line thread on the new side carries Edit: its lines,
  where the thread sits now, in this machine's worktree on the head branch.
  With no worktree on that branch the thread has no Edit: another tree's
  lines at those numbers are different lines.
- **The conversation.** The header menu's Open project in editor opens the
  session's project folder on the session's machine and links the
  conversation; the palette's Open project files on a session row opens it on
  that session's machine.
- **Elsewhere.** The command palette opens any file (code files of a local
  vault rank beside notes) and runs editor commands; the repo blob page opens
  a local checkout in the editor; the terminal dock opens at the editor's
  root; the desktop app's Go menu has Files; a `codecast://open/files?path=<abs>&l=<line>`
  link opens the editor at that line (deep links carry any in-app path); the
  keyboard shortcuts panel has an Editor section. Mobile is out of scope
  (phones read code in transcripts and diffs).
