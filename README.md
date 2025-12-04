# code-chat-sync

Sync your coding agent conversations (Claude Code, Codex CLI, Cursor) to a shared team database in real-time.

## What it does

- Watches your local Claude Code, Codex CLI, and Cursor history files
- Automatically syncs conversations to a shared Convex database
- Provides a web dashboard to browse and search team conversations
- Supports private (personal) and shared (team) conversation views
- Runs as a background daemon with zero manual effort after setup

## Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Node.js 18+
- A Convex account (free at [convex.dev](https://convex.dev))

## Installation

### 1. Clone and install dependencies

```bash
git clone https://github.com/ashot/code-chat-sync.git
cd code-chat-sync
bun install
```

### 2. Set up Convex

```bash
cd packages/convex
bunx convex dev
```

This will prompt you to log in to Convex and create a new project. It creates a `.env.local` file in `packages/convex/` with your deployment URL.

### 3. Configure the web dashboard

Copy the Convex URL to the web package:

```bash
cd ../web
cp .env.example .env.local
```

Edit `packages/web/.env.local` and add the same Convex URL from step 2:

```
NEXT_PUBLIC_CONVEX_URL=https://your-project.convex.cloud
```

### 4. Build the CLI

```bash
cd ../cli
bun run build
```

Optionally, link it globally:

```bash
bun link
```

## Usage

### Initial Setup

Run the setup wizard:

```bash
code-chat-sync setup
```

This will:
1. Detect installed coding agents (Claude Code, Codex CLI, Cursor)
2. Open a browser to authenticate with Convex
3. Optionally create or join a team

### Start the daemon

```bash
code-chat-sync start
```

The daemon runs in the background, watching your history files and syncing new conversations.

### Check status

```bash
code-chat-sync status
```

### Stop the daemon

```bash
code-chat-sync stop
```

### View logs

```bash
code-chat-sync logs
```

### Mark a conversation as private

```bash
code-chat-sync private <conversation-id>
```

## Web Dashboard

The web dashboard runs locally on your machine alongside the CLI daemon. Start it with:

```bash
cd packages/web
bun run dev
```

Then open [http://localhost:3000](http://localhost:3000) to:
- Sign in or create an account
- Browse your conversations and team conversations
- Search across all synced conversations
- View conversation details with code blocks and tool calls

## Project Structure

```
code-chat-sync/
├── packages/
│   ├── cli/          # CLI daemon and commands
│   ├── convex/       # Convex backend (schema, functions)
│   └── web/          # Next.js web dashboard
├── package.json      # Monorepo root (Bun workspaces)
└── turbo.json        # Turborepo config
```

## Supported Agents

| Agent | History Location | Status |
|-------|-----------------|--------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | Supported |
| Codex CLI | `~/.codex/history/**/*.jsonl` | Supported |
| Cursor | `~/.cursor/` | Planned (P1) |

## Development

### Run all packages in dev mode

```bash
bun run dev
```

### Type check

```bash
bun run typecheck
```

### Build all packages

```bash
bun run build
```

## Configuration

Config is stored at `~/.code-chat-sync/config.json`:

```json
{
  "web_url": "http://localhost:3000",
  "convex_url": "https://your-project.convex.cloud",
  "auth_token": "...",
  "team_id": "..."
}
```

## Privacy

- Conversations are synced to your team's Convex database
- API keys and secrets are automatically redacted before sync
- Project paths are hashed for privacy
- Mark any conversation as private to exclude from team view

## License

MIT
