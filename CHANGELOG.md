# Changelog

## v1.0.91 (2026-03-23)

**Web Dashboard**
- Store refactor with generic list views and command palette overhaul
- Responsive density controls for task and document panels
- Error boundaries on all pages with detail split layouts
- Full-text palette search and standalone compose mode
- Compose focus and sidebar toggle keyboard shortcuts

**Backend**
- Multi-scope digest generation with team-scoped filtering
- Task triage system with active/suggested/dismissed status
- Team-scoped digest upsert fix for privacy isolation

**CLI**
- Codex app-server for dedicated Codex integration
- TMux reliability improvements and session lifecycle fixes
- Subagent description passthrough for session linking

**Desktop**
- Palette-start-session IPC for compose flow integration

## v1.0.88 (2026-03-18)

**Web Dashboard**
- 3-column layout with resizable SessionListSidebar and ConversationColumn
- Collaborative document editor with TipTap, ProseMirror sync, and image upload
- Creation modals for tasks, plans, and docs from sidebar
- Entity mention autocomplete in message input with rich expansion
- Shortcut registry with 35+ context-aware keyboard shortcuts
- Dashboard redesign with project-scoped activity feeds
- Unified document detail layout and plan page redesign
- Profile pictures, keyboard nav for messages, doc markdown copy

**Backend**
- Plans as rich documents with body content and promote-to-plan flow
- Conversation comment summaries, task-plan binding, image attachments
- Entity linking and session insights for palette search
- Sequential short ID generation for all entities
- Stale daemon command expiry with 5-minute TTL

**CLI**
- Summarize tool calls in `cast read` output with `--full` hint
- Workflow snippet, overview command, plan body support, task `--plan` binding
- Agent session sync improvements and desktop notification hooks
- Idle notification throttling and permission tool extraction
- Session matching accuracy improvements

**Desktop**
- Native macOS notifications with click-to-navigate
- Auto-update mechanism with global command palette shortcuts

## v1.0.86 (2026-03-10)

**Web Dashboard**
- Session starting state with extended stuck banner
- Arrow key jump-to-start/end in conversation navigation

**Backend**
- Todo sync insight type and desktop dismissed field

**CLI**
- Command deduplication and idle detection during session start

## v1.0.85 and earlier

**Workflows**
- Visual workflow execution with human gates and free-form text input
- Run detail permalink pages, gate badges in inbox
- Primary conversation creation for workflow runs
- Workflow runner with task context and variable injection

**Orchestration**
- Wave-based parallel task execution across agents
- Plan decomposition and automated orchestration
- Retry handling with escalation logging
- Drive rounds for iterative polish

**Core**
- Background daemon with multi-agent file watching
- Real-time sync to self-hosted Convex backend
- Full-text search with embeddings and vector similarity
- Team sharing with directory-based auto-share rules
- API key redaction and optional encryption
