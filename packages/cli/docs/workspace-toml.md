# `.codecast/workspace.toml` reference

The manifest describes how `cast workspace acquire` turns a fresh git worktree
into a working environment. Every field is optional: detection fills in what it
can infer from lockfiles and conventional files, and the manifest overrides it.

Generate a starting point with `cast workspace init`, which writes the detected
values into the file.

Precedence is per field. A field the file sets non-empty replaces detection's
value for that field; a field the file omits keeps detection's.

## `[setup]`

Four lists run in order after the worktree is created: `copy`, then `install`,
`generate`, `migrate`. `share` is not a command list — it is applied before all
of them, right after `git worktree add`.

```toml
[setup]
copy = [".env", ".env.local", "certs"]
share = ["node_modules", ".venv"]
install = ["bun install"]
generate = ["bun run codegen"]
migrate = ["bun run db:migrate"]
```

### `copy` — gitignored files the worktree gets its own copy of

Paths relative to the main checkout. Use it for the files a worktree must own:
`.env`, credentials, local certificates. A missing source is skipped, and a file
already present in the worktree is never overwritten.

The repo-root `.wt-setup-files` convention is still the include list: when that
file exists, detection reads its lines (one path per line, `#` comments allowed)
into `copy`. Write the manifest's `copy` only to override it.

On macOS the bytes are cloned rather than written. APFS gives the worktree a
copy-on-write view of the same blocks, so copying a large credential directory
costs no time and no disk. A filesystem without reflinks — and every other
platform — falls back to a plain copy, so behaviour is identical either way.

### `share` — gitignored directories the worktree borrows

Each entry is symlinked from the main checkout into the same relative path in
the worktree, so one install serves every worktree instead of each paying for
its own. Detection offers `node_modules`, `.venv`, `venv` and `vendor` when they
qualify.

An entry is only shared when it:

- exists in the main checkout as a directory,
- is gitignored there — a tracked directory is already materialized by the
  checkout, and a symlink at an unignored path reads as a worktree diff,
- names a path inside the repo — an absolute path or a `..` hop is refused,
- holds no symlinks pointing back into the repo outside the shared directory
  itself.

That last rule is why a monorepo's `node_modules` is usually **not** shared. A
package manager links workspace packages relatively
(`node_modules/@scope/web -> ../../packages/web`), and those links resolve from
the real directory: inside a worktree they reach the MAIN checkout's source with
no error, so a test run there mixes two trees at once. Codecast's own repo has
that shape, so detection offers nothing there and each worktree installs its own
dependencies.

Only dependency installs belong here, never build outputs. Two worktrees hold
different code, so a shared `target/` or `dist/` would have them overwrite each
other's artifacts.

An entry the worktree already has as a real directory is left alone.

Destroying a workspace removes these links first. A directory-only ignore rule
(`node_modules/`) matches the main checkout's real directory but never the
worktree's symlink, so git reports the link as untracked and refuses to remove
the worktree without `--force`.

## `[ports.<name>]`

A named port per workspace, exported as `PORT_<NAME>`. The actual port is
`base + resourceIndex * range`; keep `range` at 100 or more so neighbouring
workspaces never collide.

```toml
[ports.web]
base = 3000
range = 100
```

## `[services.<name>]`

A background service the workspace needs. `mode = "shared"` points every
workspace at one instance and requires `url`; `mode = "isolated"` starts one per
worktree and requires `start` and `stop`.

```toml
[services.db]
mode = "isolated"
start = "pg_ctl start"
stop = "pg_ctl stop"
port = "$PORT_DB"
ready_check = "tcp:5432"
ready_timeout_sec = 30
```

## `[env]`

Static environment variables exported into every setup command and hook.

```toml
[env]
NODE_ENV = "development"
```

## `[teardown]`

Commands run when the workspace is destroyed, before the worktree is removed.

```toml
[teardown]
run = ["docker compose down"]
```

## `[browser]`

A Chromium instance bound to the workspace, off by default. `allow` is the list
of origins `cast browser` may navigate to from this project; omitting it means
no policy, and an empty list refuses every site.

```toml
[browser]
enabled = true
headless = true
allow = ["https://app.example.com"]

[browser.cdp_port]
base = 9222
range = 100
```

## `backend`

Which substrate the workspace runs on: `local` (a git worktree here), `e2b` or
`mac`. See [workspace-backends.md](./workspace-backends.md).

```toml
backend = "local"
```
