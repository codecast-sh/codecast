# @codecast/cli

The `cast` CLI — syncs coding agent conversations (Claude Code, Codex, Cursor, Gemini) and queries them from your terminal or from inside agent sessions.

## Install

```bash
curl -fsSL codecast.sh/install | sh    # macOS / Linux
irm codecast.sh/install.ps1 | iex      # Windows
```

## Setup

```bash
cast auth     # authenticate via browser (works over SSH too)
cast setup    # auto-start on login
cast start    # start the sync daemon
```

## Commands

### Search & Browse
```bash
cast search "auth"                # team-wide search
cast search "bug" -g -s 7d        # global, last 7 days
cast feed                         # browse recent conversations
cast read <id> 15:25              # read messages 15-25
```

### Live Sessions
```bash
cast sessions                     # work-state snapshot (needs input / working / idle)
cast sessions -w                  # stream state changes live
cast send <id> "text"             # message another session
cast resume auth bug              # search history and resume the match
cast attach                       # tmux session picker TUI
cast fork --from 15               # branch a conversation from a message
cast tree <id>                    # show a conversation's fork tree
cast accounts                     # save/switch/remove Claude Code account profiles
```

### Analysis
```bash
cast diff <id>                    # files changed, commits, tools used
cast diff --today                 # aggregate today's work
cast summary <id>                 # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions
cast ask "how does X work"        # query across sessions
cast blame src/auth.ts            # which session wrote each line
cast similar --file src/auth.ts   # sessions that touched a file
```

### Tasks, Plans & Triggers
```bash
cast task create "Fix bug" -p high
cast plan create "Overhaul" -g "goal"
cast plan orchestrate <id>        # run plan tasks in waves across agents
cast overview                     # top-down view of plans and tasks
cast trigger add "Check CI" --in 30m
```

### Handoff & Tracking
```bash
cast handoff                      # generate context transfer doc
cast bookmark <id> <msg> --name x # save shareable link
cast decisions add "title" --reason "why"
cast learn add "name" --description "pattern"
```

### Common Options
- `-g` - global (all projects)
- `--mine` / `-m <name>` - scope to yourself / a team member
- `--label <name>` - sessions filed under a label
- `-s`, `-e` - start/end time (7d, 2w, yesterday)
- `-p` - page number
- `-n` - limit results

## Development

Run the CLI from source code:

```bash
# Option 1: Use bun directly
bun run src/index.ts <command>

# Option 2: Install local wrapper (recommended)
ln -sf $(pwd)/scripts/codecast-local ~/.local/bin/codecast
```

The wrapper runs from source, so changes take effect immediately without rebuilding.
