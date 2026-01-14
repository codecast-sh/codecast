# @codecast/cli

CLI for syncing and querying Claude Code conversations.

## Install

```bash
npm install -g @codecast/cli
```

## Commands

### Search & Browse
```bash
codecast search "auth"                # search current project
codecast search "bug" -g -s 7d        # global, last 7 days
codecast feed                         # browse recent conversations
codecast read <id> 15:25              # read messages 15-25
```

### Analysis
```bash
codecast diff <id>                    # files changed, commits, tools used
codecast diff --today                 # aggregate today's work
codecast summary <id>                 # goal, approach, outcome, files
codecast context "implement auth"     # find relevant prior sessions
codecast ask "how does X work"        # query across sessions
```

### Handoff & Tracking
```bash
codecast handoff                      # generate context transfer doc
codecast bookmark <id> <msg> --name x # save shareable link
codecast decisions list               # view architectural decisions
codecast decisions add "title" --reason "why"
codecast learn list                   # view saved patterns
```

### Common Options
- `-g` - global (all projects)
- `-s`, `-e` - start/end time (7d, 2w, yesterday)
- `-p` - page number
- `-n` - limit results

## Setup

```bash
codecast auth    # authenticate with codecast.sh
codecast sync    # start syncing conversations
```
