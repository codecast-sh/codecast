# Conversation Diff Viewer + GitHub PR Integration Roadmap

> **Status (2026-10-04):** Shipped. 19 of 21 phase items done, 1 partly, 1 not done (web worker). The diff viewer lives in `packages/web/components/ConversationDiffLayout.tsx`, `packages/web/store/diffViewerStore.ts`, `packages/web/lib/cumulativeDiff.ts` and `packages/web/app/conversation/[id]/diff/`. GitHub PR sync lives in `packages/convex/convex/githubWebhooks.ts`, `githubApi.ts` and `reviews.ts`, plus `cast pr`. The PR half is superseded by `docs/architecture/pull-requests.md`.

## Original Requirements

For the review/GitHub features, the goals are:

1. **PR Support (First Class)**
   - Two-way syncing to GitHub
   - Inline comments that sync bidirectionally
   - Auto-comment on PR with link to Codecast conversation when PR is linked

2. **Conversation Diff Viewer**
   - See a full diff for all changes from a conversation in a split pane
   - Use `react-resizable-panels` for the layout
   - Go back in time and see the diff change as you navigate the conversation timeline
   - Separate control for time navigation (not just scroll)
   - Range selection: show diffs between any two points, not just from beginning

3. **UX Requirements**
   - Amazing, performant, and efficient UI
   - Click-driven navigation
   - Bidirectional sync between conversation and diff pane

## Design

### Three-Panel Layout

```
┌─────────────────────┬───┬──────────────────────────────────┐
│                     │   │                                  │
│   CONVERSATION      │ ● │        DIFF PANE                 │
│                     │ │ │                                  │
│   [User message]    │ │ │   src/utils.ts                   │
│                     │ ● │   ─────────────────────────      │
│   [Claude...]       │ │ │   - old                          │
│   ┌───────────────┐ │ │ │   + new                          │
│   │ Edit utils.ts │─┼─●─┼── (selected)                     │
│   └───────────────┘ │ │ │                                  │
│                     │ ● │                                  │
│   [More...]         │ │ │                                  │
│                     │ ● │                                  │
│                     │   │                                  │
└─────────────────────┴───┴──────────────────────────────────┘
```

### Vertical Timeline (Center Strip)

The vertical timeline acts as the "spine" connecting conversation and diff:

- **Visual connection**: Shows where changes occurred relative to conversation flow
- **Density indicator**: Clustered dots reveal intensive editing periods
- **Click to sync**: Click any dot to sync both panes to that point
- **Compact**: ~40px wide, doesn't consume horizontal space
- **Color-coded**: Each file gets a consistent color for visual tracking
- **Hover tooltips**: File path, change type, timestamp

### Navigation Model

**Click-Driven (Primary)**
- Click Edit/Write tool call in conversation → diff pane shows that change
- Click timeline dot → both conversation AND diff sync to that point

**Range Selection**
- Click first change, then Cmd/Ctrl+click second → shows diff for that range
- Range can be any two points (not just from beginning)
- Header shows: "Changes 3-7 of 12"

**Keyboard Shortcuts**
- `[` `]` : Step to previous/next change
- `c` : Toggle cumulative/single diff mode
- `f` : Toggle file tree
- `d` : Toggle diff pane (from conversation view)
- `Escape` : Clear selection, show full diff

**Diff Modes**
- **Cumulative**: All changes from range start to selected point
- **Single**: Just the one edit at selected point

**Sync Options**
- Optional "sync scroll" toggle
- When enabled, clicking timeline scrolls conversation to that message
- Can disable if you want to look at diff without conversation jumping

### Entry Points

1. Toggle button in conversation header
2. Direct URL: `/conversation/[id]/diff`
3. Keyboard shortcut `d` from conversation view
4. Deep link to specific change: `/conversation/[id]/diff?change=5`

## GitHub PR Integration

### Two-Way Comment Sync

- **Real-time**: Comments posted in Codecast appear in GitHub within seconds
- **Reverse sync**: Comments posted in GitHub appear in Codecast
- **Inline comments**: Line-specific comments sync with correct file/line context
- **Thread support**: Replies sync bidirectionally
- **State sync**: Resolved/unresolved status syncs

### Auto-Link Conversation to PR

When a PR is linked to a Codecast conversation:
- Auto-post comment on GitHub PR with link to Codecast conversation
- Comment includes: conversation title, key changes made, link to full session
- Detection methods: branch name match, commit SHA match, manual linking

### PR Review Workflow

- View PR diff with Codecast session context side-by-side
- See which AI session created each change
- Add comments that sync to GitHub
- Approve/request changes from Codecast (syncs to GitHub)

## Technical Approach

### Dependencies
- `react-resizable-panels` for split-pane layout
- Existing: `diff`, `react-diff-view`, `prismjs` for diff rendering
- Existing: `zustand` for state management
- Existing: `@tanstack/react-virtual` for virtualization

### Performance Strategy
- **Lazy computation**: Only compute diffs as user navigates
- **Memoization**: Cache computed diffs for instant re-access
- **Virtualization**: Long diffs render only visible lines
- **Web Worker**: Heavy diff computation off main thread

### State Management
```typescript
interface DiffViewerState {
  selectedChangeIndex: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  diffMode: 'cumulative' | 'single';
  syncScroll: boolean;
  showFileTree: boolean;
  changes: FileChange[];
  selectedFile: string | null;
}
```

## Implementation Phases

### Phase 1: Core Infrastructure (P1)
- Install react-resizable-panels (done)
- FileChangeExtractor utility (done: packages/web/lib/fileChangeExtractor.ts)
- DiffViewerState zustand store (done: packages/web/store/diffViewerStore.ts)
- Three-panel layout component (done: packages/web/components/ConversationDiffLayout.tsx)

### Phase 2: Diff Pane (P1)
- DiffPane component with syntax highlighting (done: components/FileDiffView.tsx)
- Cumulative diff computation (done: lib/cumulativeDiff.ts)
- Single-change diff mode (done)
- File tree sidebar (done: components/FileDiffSidebar.tsx)

### Phase 3: Timeline & Navigation (P1-P2)
- VerticalTimeline component (done: TimelineStrip in ConversationDiffLayout.tsx)
- Clickable tool calls in conversation (done: components/conversation/blocks/toolBlocks.tsx)
- Conversation scroll sync (done)
- Keyboard shortcuts (done)

### Phase 4: Range Selection & Polish (P2)
- Range selection (Cmd+click) (done)
- Entry points and URL routes (done: app/conversation/[id]/diff, `?change=`, `d` shortcut)
- Performance optimizations (partly)
- Web worker for diff computation (not done)

### Phase 5: GitHub PR Integration (P2-P3)
- GitHub webhook endpoint (done: packages/convex/convex/githubWebhooks.ts)
- Comment sync: Codecast → GitHub (done)
- Comment sync: GitHub → Codecast (done)
- Auto-link conversation to PR (done: githubWebhooks.ts postPRCommentIfNeeded)
- PR review actions (done: convex/reviews.ts, `cast pr review`)

## Platform

**Web only** for initial implementation. Mobile may get a simplified view in a future phase.
