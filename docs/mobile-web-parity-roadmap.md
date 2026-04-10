# Mobile-Web Parity Roadmap

## Gap Analysis Summary

The mobile app covers the core loop well (inbox, session viewer, tasks, notifications, settings) but is missing ~60% of the web's feature surface. The gaps fall into three tiers:

1. **Critical** — Features users expect on mobile that directly impact daily usage
2. **Important** — Features that complete the mobile experience for power users
3. **Nice-to-have** — Features that are web-native or rarely needed on mobile

---

## Tier 1: Critical Gaps (Daily Usage)

### 1.1 Conversation View Gaps
The session detail view (`session/[id].tsx` at 6333 lines) renders messages but is missing key web features:

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Thinking blocks (expandable) | Yes | No | Missing |
| File diffs (inline) | Yes | No | Missing |
| Commit cards | Yes | No | Missing |
| PR cards | Yes | No | Missing |
| Entity references (@task, #plan) | Yes | No | Missing — renders as plain text |
| Send & advance (inbox workflow) | Yes | No | Missing — can't triage from session |
| Send & dismiss | Yes | No | Missing |
| Copy message link | Yes | No | Missing |
| Search within conversation | Yes (Cmd+F) | No | Missing |

### 1.2 Inbox Gaps

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Defer session (hide until next activity) | Yes | No | Missing |
| Share conversation (privacy, team visibility, link) | Yes | No | Missing |
| Filter by agent type | Yes | No | Missing |
| Filter by status | Yes | No | Missing |
| Session context menu (full options) | Yes | Partial (swipe only) | Limited — swipe gives pin/dismiss only |

### 1.3 Task Management Gaps

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Create new task | Yes | No | Missing |
| Kanban board view | Yes | No | Missing |
| Inline title editing | Yes | No | Missing |
| Filter by labels | Yes | No | Missing |
| Filter by assignee | Yes | No | Missing |
| Sort options | Yes | No | Missing |
| Assign tasks | Yes | No | Missing |
| Add/remove labels | Yes | No | Missing |
| Dependencies display | Yes | No | Missing |

### 1.4 Plans List Screen
Mobile has a plan detail view but **no way to browse plans**. There is no plans tab or plans list screen.

### 1.5 Docs List Screen
Mobile has a doc detail view but **no way to browse docs**. There is no docs tab or docs list screen.

### 1.6 Settings Gaps

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Edit profile (name, title, bio, status) | Yes | No | Shows profile card but can't edit |
| Team management (icon, color, members, roles) | Yes | No | Missing |
| Invite team members | Yes | No | Missing |
| CLI setup / token generation | Yes | No | Missing |
| Repository sync / team mappings | Yes | No | Missing |

---

## Tier 2: Important Gaps (Power Users)

### 2.1 Missing Pages

| Page | Web Route | Purpose | Mobile Priority |
|------|-----------|---------|-----------------|
| Dashboard / Activity Feed | `/dashboard` | Team activity overview | High — key for managers |
| Search (dedicated) | `/search` | Global search across all content | High — currently buried in inbox |
| Explore | `/explore` | Browse public sessions | Medium |
| Commit viewer | `/commit/[owner]/[repo]/[sha]` | View commit diffs | Medium |
| PR viewer | `/pr/[owner]/[repo]/[number]` | View PR details | Medium |

### 2.2 Team Gaps

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Team member directory | Yes | No | Mobile shows team sessions but not members |
| Member profiles | Yes | No | Missing |
| Team activity feed | Yes | No | Missing |
| Invite members | Yes | No | Missing |
| Online/offline status indicators | Yes | No | Missing |

### 2.3 Conversation Advanced Features

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Fork conversation (branch from message) | Yes | No | Missing |
| Fork tree visualization | Yes | No | Missing |
| Subagent indicators | Yes | No | Missing |
| Worktree integration display | Yes | No | Missing |
| Diff side panel | Yes | No | Missing |

### 2.4 UI/UX Features

| Feature | Web | Mobile | Gap |
|---------|-----|--------|-----|
| Dark/light theme toggle | Yes | Auto-detect only | No manual toggle |
| Command palette | Yes (Cmd+K) | No | Missing — could be a search/action sheet |
| Loading skeletons | Yes | No | Bare loading states |
| Undo/redo for actions | Yes | No | Missing |

---

## Tier 3: Nice-to-Have (Web-Native)

These features are either web-native workflows or rarely needed on mobile:

| Feature | Reason to Deprioritize |
|---------|----------------------|
| Workflows / workflow runs | Complex graph UI, primarily a desktop workflow |
| Code review (individual + batch) | Heavy diff UI, better on desktop |
| Orchestration dashboard | Admin/power-user feature |
| Configuration editor | Developer tooling |
| Git timeline | Visualization-heavy |
| Keyboard shortcuts | N/A on mobile |
| Resizable panels | N/A on mobile |
| Zen mode | N/A on mobile |
| CLI settings / token generation | Could be useful but niche on mobile |
| GitHub App integration settings | One-time setup, fine on web |

---

## Implementation Roadmap

### Phase 1: Core Loop Completion (Est. 8 tasks)

Focus: Make the existing screens fully functional.

**P1.1 — Conversation view: thinking blocks**
Add expandable thinking block rendering in session detail. Web uses `ThinkingBlock` component with expand/collapse. Mobile needs an Animated collapsible.

**P1.2 — Conversation view: file diffs**
Render file diffs inline in messages. At minimum, show a simplified unified diff with syntax highlighting. Can reuse the existing `MarkdownRenderer` code block component as a base.

**P1.3 — Conversation view: commit & PR cards**
Render commit and PR references as tappable cards (like the web's `CommitCard` and `PRCard`). Show metadata (author, sha, status) and link to GitHub.

**P1.4 — Conversation view: entity references**
Parse @task, #plan, and doc references in message text. Render as tappable links that navigate to `/task/[id]`, `/plan/[id]`, `/doc/[id]`.

**P1.5 — Inbox: send & advance / send & dismiss**
Add quick-reply input at bottom of session detail when session is idle (from inbox). Include "Send & Advance" and "Send & Dismiss" buttons matching web's inbox workflow.

**P1.6 — Inbox: defer session**
Add "Defer" to the swipe actions or context menu. Deferred sessions are hidden until the agent produces new output.

**P1.7 — Inbox: share conversation**
Add share button on session detail or session context menu. Shows action sheet: Make Private, Share with Team (visibility picker), Copy Share Link.

**P1.8 — Inbox: filters**
Add filter bar/chips above session list: by agent type (Claude/Codex/Gemini), by status (working/idle/error).

### Phase 2: Missing List Screens (Est. 5 tasks)

Focus: Add browsable list views for plans and docs, upgrade task management.

**P2.1 — Plans tab/screen**
Add a Plans list screen (either as a new tab or accessible from a "More" menu). Show plan status, progress bar, linked task count. Tap to navigate to existing `/plan/[id]` detail.

**P2.2 — Docs tab/screen**
Add a Docs list screen. Show doc type, title, labels, pinned status. Filter by doc type. Tap to navigate to existing `/doc/[id]` detail.

**P2.3 — Task creation**
Add "New Task" FAB or button on tasks screen. Form: title, description, priority, status, labels.

**P2.4 — Task filters & sort**
Add filter bar to tasks screen: status multi-select, priority, labels, assignee. Add sort picker (updated, created, priority).

**P2.5 — Task inline editing**
Long-press or edit button on task to edit title, assign, change labels. Currently only status/priority are editable via action sheet.

### Phase 3: Team & Settings (Est. 6 tasks)

Focus: Full team collaboration and settings parity.

**P3.1 — Team member directory**
Replace or augment the team tab to show team members (not just team sessions). Show avatar, name, title, online status, last seen.

**P3.2 — Member profiles**
Tap a team member to see their profile: recent sessions, projects, stats.

**P3.3 — Team invite flow**
Add "Invite" button on team screen. Generate invite code or link.

**P3.4 — Profile editing in settings**
Add editable fields: display name, title/role, bio, status (available/busy/away), timezone.

**P3.5 — Team management in settings**
Add team settings section: edit team name, icon/color, manage members (roles, remove).

**P3.6 — Theme toggle in settings**
Add manual dark/light/system theme picker. Currently uses system-only detection.

### Phase 4: Discovery & Navigation (Est. 4 tasks)

Focus: Help users find things.

**P4.1 — Dedicated search screen**
Full search screen accessible from tab bar or header. Search across sessions, tasks, plans, docs.

**P4.2 — Activity feed / dashboard**
Add activity feed screen showing team activity: new sessions, task updates, mentions. Filter by My/Team.

**P4.3 — Explore public sessions**
Browse publicly shared sessions. Filter by agent type, trending.

**P4.4 — Command palette equivalent**
Quick-action bottom sheet (swipe up or button): navigate to any screen, quick-create task/session, search.

### Phase 5: Advanced Conversation Features (Est. 4 tasks)

Focus: Power-user conversation features.

**P5.1 — Conversation search**
In-conversation search with result highlighting and jump-to-match.

**P5.2 — Fork conversation**
Long-press a message to fork (branch) the conversation from that point.

**P5.3 — Subagent & worktree indicators**
Show subagent relationships and worktree branch info in session metadata.

**P5.4 — Copy message link**
Long-press message to copy a shareable permalink.

### Phase 6: Polish & Parity (Est. 4 tasks)

**P6.1 — Loading skeletons**
Replace bare loading states with skeleton placeholders matching the final layout.

**P6.2 — Undo for destructive actions**
Toast with "Undo" after dismiss, stash, archive operations.

**P6.3 — Improved empty states**
Rich empty states with illustrations and CTAs (matching web).

**P6.4 — Deep link handling**
Handle all `/session/`, `/task/`, `/plan/`, `/doc/`, `/share/` deep links from push notifications and external sources.

---

## Task Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| Phase 1 | 8 | Core loop completion |
| Phase 2 | 5 | Missing list screens |
| Phase 3 | 6 | Team & settings |
| Phase 4 | 4 | Discovery & navigation |
| Phase 5 | 4 | Advanced conversation |
| Phase 6 | 4 | Polish & parity |
| **Total** | **31** | |

---

## Excluded from Roadmap

These web features are intentionally excluded from mobile parity:

- **Workflows/orchestration** — Complex graph UI, desktop-first workflow
- **Code review (individual + batch)** — Heavy diff UI unsuited to mobile
- **Git timeline** — Visualization-heavy, low mobile utility
- **Configuration editor** — Developer tooling, CLI-adjacent
- **CLI settings / token generation** — One-time setup, better on web
- **GitHub App integration** — One-time setup
- **Keyboard shortcuts / zen mode / resizable panels** — Desktop-only UX patterns

---

## Architecture Notes

### Tab Bar Capacity
Currently 5 visible tabs: Inbox, Tasks, Team, Notifications, Settings. Adding Plans and Docs as tabs would make 7 — too many. Options:
- **Replace "Team" with a "More" tab** containing Team, Plans, Docs, Activity
- **Use a top-level navigation drawer** instead of bottom tabs
- **Keep 5 tabs, add Plans/Docs as sub-screens** accessible from inbox or a hub screen
- **Recommended: Add a "Library" tab** replacing or supplementing Team, containing Plans, Docs, and Team as sections

### Session Detail Refactor
`session/[id].tsx` is 6333 lines — the largest file in the app. Before adding more features (thinking blocks, diffs, entity refs, fork, search), it should be decomposed into:
- `SessionHeader` — title, status, metadata
- `MessageList` — virtualized message list
- `MessageBubble` — individual message rendering
- `ToolCallRenderer` — tool call display
- `DiffRenderer` — file diff component
- `SessionInput` — reply input with send modes
- `SessionActions` — share, fork, search controls

### Shared Code Opportunity
The mobile app already imports from `@codecast/web/store/inboxStore`. Additional sharing opportunities:
- Entity reference parsing logic
- Session categorization (`categorizeSessions`)
- Date grouping utilities
- Status/priority/label color configs
- Share link generation logic
