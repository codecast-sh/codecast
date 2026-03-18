# Activity Feed Visual Hierarchy Redesign

## Problem

The ActivityFeed component renders all text at similar visual weight. Titles, headlines, descriptions, metadata, and turn labels all blur together. There is no cross-session understanding -- sessions are listed chronologically within a day with no synthesis of related work. The result is a wall of same-emphasis text that is hard to scan.

## Design

### Typography Hierarchy (7 tiers)

| Tier | Element | Size | Weight | Color | Purpose |
|------|---------|------|--------|-------|---------|
| 1 | Day label | 18px | bold | `text-sol-text` | Temporal anchor |
| 2 | Narrative bullets | 13px | regular | `text-sol-text-secondary` | Cross-session synthesis |
| 3 | Session title | 14px | bold | `text-sol-text` | Session identity |
| 4 | Headline/summary | 12px | regular | `text-sol-text-muted` | What happened (one line) |
| 5 | User ask | 12px | medium | `text-sol-blue` | User intent (with profile pic) |
| 6 | Did items | 11px | regular | `text-sol-text-dim` | Agent work detail |
| 7 | Metadata | 10px | mono | `text-sol-text-dim/50` | Duration, msg count, time |

No two adjacent tiers should look the same.

### Day Level

- **Day header**: Bold date (18px, `text-sol-text`), thin horizontal rule to the right, session count at quaternary level.
- **Narrative bullets**: 2-3 cross-session synthesis bullets below the header. These summarize themes and arcs across sessions, not individual sessions. Secondary weight (`text-sol-text-secondary`, 13px).
- **Collapsed days**: Show date + narrative bullets only. No session cards.
- **Today auto-expanded** to show session cards.

### Session Cards

**Collapsed (default)**:
- Title: bold, 14px, `text-sol-text`
- Project badge: monospace, small, dim (quaternary)
- Headline: `text-sol-text-muted`, 12px, regular weight, one line truncated
- Metadata (duration, msg count, time): `text-sol-text-dim/50`, 10px mono, right-aligned

**Expanded (click to toggle)**:
- Title stays
- Headline SWAPS to longer bulleted summary (from `key_changes` or expanded summary text) in `text-sol-text-muted`
- Below the bullets: turns section
- Cards separated by subtle divider (`border-sol-border/15`)
- No colored left borders, no outcome badges, no theme tags

### Turns (Expanded Detail)

- **User ask**: 20px circle avatar (initial or profile pic) + ask text in `text-sol-blue`, medium weight, 12px
- **Did items**: indented under each ask, `text-sol-text-dim`, 11px, dash-prefixed. Code/file refs in cyan monospace.

### What to Remove

- Outcome badges (shipped/progress/blocked labels)
- Theme tag pills
- Outcome bar (green/yellow/red stacked bar)
- Colored left borders on cards
- `OUTCOME_STYLES`, `PROJECT_PALETTE` constants
- `TIMELINE_TYPE_STYLES` (timeline events replaced by turns)

### What to Keep

- Feed/Raw toggle
- 24h/7d/30d time window
- Regen button
- People row filter (team mode)
- Project filter (click project badge to filter)
- ConversationList for raw view

## Changes Required

### Frontend: `packages/web/components/ActivityFeed.tsx`

Rewrite `DaySection`, `SessionCard`, `SessionTurns` components:
- DaySection: large date header, narrative bullets at secondary weight, collapse/expand
- SessionCard: strict tier separation, headline-to-bullets swap on expand
- SessionTurns: profile pic avatar + blue text for asks, dim text for did items
- Strip all badge/tag/colored-border rendering

### Backend: `packages/convex/convex/sessionInsights.ts`

Update `backfillDayNarratives` prompt to produce structured bullet array instead of paragraph narrative. Each bullet synthesizes across sessions (e.g., "Fixed notification pipeline end-to-end across 3 sessions") rather than summarizing individual ones.

### No Schema Changes

Existing fields sufficient: `headline`, `key_changes`, `turns`, `day_narratives` with events.
