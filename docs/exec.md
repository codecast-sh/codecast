# `cast exec`: print mode for every agent harness

`cast exec` runs a prompt on any harness we launch, prints the result, and exits. It is the scripting form of `claude -p`, with one set of flags for Claude, Grok, Codex, Cursor, OpenCode, pi, and Gemini.

The process is the session. Stdout is the result. The exit code is the agent's. There is no inbox card.

```bash
cast exec "summarize this repo"
cast exec --agent grok --model grok-4.6 --effort high "review the diff"
git diff | cast exec --agent claude --model sonnet "write a commit message"
cast exec --output-format json --max-turns 4 "list the public API"
cast exec --dry-run --agent codex "what command would run"
```

## What it is not

| Command | What it does |
|---|---|
| `cast exec` | Run a prompt now. Print the result. Exit. |
| `cast spawn` | Start a session in the inbox and return immediately. |
| `cast ask` | Search conversation history. |
| `cast claude` | Pass flags through to the Claude binary only. |
| `cast remote run` | Drive a session that was moved to a remote Mac. |
| `cast workflow run` | Run a `.cast` graph with several steps. |

`cast spawn` is the inbox verb. `cast exec` is the script verb. If you want a card you can `cast send` and `cast read`, use spawn. If you want stdout in this process, use exec.

`cast claude -p "…"` still works. It is a raw pass-through. `cast exec --agent claude` is the same idea with unified flags, and it works for the other harnesses too.

## Flags

Shared across harnesses. Each maps onto that client's native headless form (`claude -p`, `grok -p` / `--single`, `codex exec`, `cursor-agent -p`, `opencode run`, `pi -p`, `gemini -p`).

| Flag | What it does |
|---|---|
| `--agent` | `claude` (default), `codex`, `cursor`, `gemini`, `opencode`, `pi`, `grok` |
| `-m` / `--model` | Picker key (`opus`) or a raw id (`grok-4.6`) |
| `--effort` | Reasoning effort. Levels vary by agent (claude: `low\|medium\|high\|max`) |
| `-C` / `--dir` | Working directory |
| `--output-format` | `text` (default), `json`, or `stream-json` |
| `--permission-mode` | `bypass` (default), `default`, `acceptEdits`, `full_auto`, or a native mode |
| `-r` / `--resume` | Resume a previous session by id |
| `-c` / `--continue` | Continue the most recent session in this directory |
| `--max-turns` | Cap turns (claude, grok) |
| `--system-prompt` | Replace the default system prompt (claude, grok, pi) |
| `--append-system-prompt` | Append to the default system prompt (claude, grok, pi) |
| `--json-schema` | Constrain the final answer (claude, grok) |
| `--bare` | Skip hooks / plugins / CLAUDE.md discovery (claude; opencode `--pure`) |
| `--isolated` | Start in a git worktree (grok, cursor, gemini) |
| `--timeout` | Kill the run after this long (`30s`, `2m`, `10m`) |
| `--dry-run` | Print the resolved command and exit |

A flag the chosen agent cannot honor is ignored, with a warning on stderr.

Permission defaults to bypass, same as a session the daemon launches, so a script does not hang on a TUI prompt. Pass `--permission-mode default` to keep the client's own prompts.

## Stdin

```bash
cast exec "summarize this repo"          # prompt is the argument
cast exec - <<'EOF'                      # prompt is stdin
…multi-line…
EOF
echo "what is 2+2?" | cast exec          # prompt is the pipe
git diff | cast exec "write a commit message"   # prompt is the argument; the pipe is extra context
```

When a prompt argument is present and stdin is piped, the child inherits stdin. That is how `cat file | claude -p "query"` works, and exec keeps that shape.

## Output and exit

- stdout: the agent's result
- stderr: warnings, ignored flags, errors
- exit 0: the agent succeeded
- exit 124: `--timeout` fired
- any other code: the agent's own failure code

`--output-format json` is the agent's native JSON, not a Codecast envelope. Pipe it to `jq` as you would with `claude -p --output-format json`.

`--dry-run` prints the resolved binary and args, then exits 0. Use it to check the mapping without spending a turn.

## Auth and the daemon

`cast exec` does not need `cast auth`. It launches the local agent CLI, so that CLI must be installed and logged in.

If the Codecast daemon is running and watching this project, the transcript still syncs. You can `cast read` it later. The run itself does not create an inbox card.

To start work on another machine, use `cast spawn --device <name>` instead, or `cast spawn --cloud` for an isolated worktree on the cloud host. Exec always runs here.

## `cast spawn --effort`

`cast spawn` now takes `--effort` as well, so the two commands share the same model and effort settings. Spawn still returns immediately with a session id; exec still waits and prints.
