# Activity Feed Visual Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the ActivityFeed component with strict 7-tier visual hierarchy and cross-session narrative synthesis.

**Architecture:** Rewrite 3 frontend components (DaySection, SessionCard, SessionTurns) in ActivityFeed.tsx with strict typography tiers. Update the day narrative LLM prompt to produce structured bullets instead of a paragraph. No schema changes.

**Tech Stack:** React/Next.js, Tailwind CSS, Convex backend, Claude Haiku API

---

## File Structure

- Modify: `packages/web/components/ActivityFeed.tsx` -- rewrite rendering components
- Modify: `packages/convex/convex/sessionInsights.ts` -- update day narrative prompt

## Chunk 1: Backend -- Day Narrative Prompt

### Task 1: Update day narrative prompt to produce structured bullets

**Files:**
- Modify: `packages/convex/convex/sessionInsights.ts:1621-1629`

- [ ] **Step 1: Replace the day narrative prompt**

The current prompt at line 1621-1629 asks for "exactly 2 sentences." Replace it with a prompt that returns JSON with structured bullets:

```typescript
    const prompt = `Day summary for ${args.date}. Return ONLY valid JSON with this shape:
{
  "bullets": ["string (cross-session synthesis, max 3 items)"],
  "headline": "string (one sentence, the day's main story)"
}

Sessions:
${sessionsText}

Rules:
- bullets: 2-3 items. Each synthesizes ACROSS sessions, not per-session. Example: "Fixed notification pipeline end-to-end: root cause in idle detection, fallback via osascript, electron integration (3 sessions)". Reference specific technical details. Most impactful first.
- headline: One sentence summary of the day's main thrust. Max 80 chars.
- No markdown. No commentary. Just JSON.`;
```

Also update `max_tokens` from 150 to 300 (line 1642).

- [ ] **Step 2: Parse structured response and store**

Replace the narrative extraction at lines 1648-1661. Parse JSON response, fall back to raw text if JSON parse fails:

```typescript
      const data = await response.json();
      const raw = data.content?.[0]?.text?.trim();
      if (!raw) return { status: "error", reason: "empty_response" };

      let narrative = raw;
      let bullets: string[] = [];
      let dayHeadline = "";
      try {
        const parsed = JSON.parse(raw);
        bullets = Array.isArray(parsed.bullets) ? parsed.bullets.map((b: any) => String(b).slice(0, 200)) : [];
        dayHeadline = parsed.headline ? String(parsed.headline).slice(0, 120) : "";
        narrative = dayHeadline || bullets.join(" | ") || raw;
      } catch {
        // Legacy: raw text narrative
      }

      await ctx.runMutation(internal.sessionInsights.upsertDayTimeline, {
        user_id: args.user_id,
        team_id: args.team_id,
        date: args.date,
        events: cappedEvents.map((e) => ({
          ...e,
          session_id: e.session_id || undefined,
        })),
        narrative,
        generated_at: Date.now(),
      });
```

Note: We store `narrative` as the headline string and the `bullets` get embedded in the narrative field as a JSON-encoded string with a prefix marker. Actually, simpler: store `narrative` as `dayHeadline + "\n---\n" + bullets.join("\n")` so we can parse it back on the frontend without schema changes.

```typescript
      const storedNarrative = bullets.length > 0
        ? `${dayHeadline}\n---\n${bullets.join("\n")}`
        : narrative;

      await ctx.runMutation(internal.sessionInsights.upsertDayTimeline, {
        user_id: args.user_id,
        team_id: args.team_id,
        date: args.date,
        events: cappedEvents.map((e) => ({
          ...e,
          session_id: e.session_id || undefined,
        })),
        narrative: storedNarrative,
        generated_at: Date.now(),
      });
```

- [ ] **Step 3: Deploy Convex changes**

```bash
cd /Users/ashot/src/codecast && npx convex deploy
```

- [ ] **Step 4: Regenerate day narratives to populate new format**

```bash
# From browser: click "regen" button in the ActivityFeed, or:
# This will be tested after the frontend changes are in place
```

- [ ] **Step 5: Commit**

```bash
git add packages/convex/convex/sessionInsights.ts
git commit -m "feat(convex): structured day narrative bullets instead of paragraph"
```

---

## Chunk 2: Frontend -- Rewrite ActivityFeed Components

### Task 2: Strip dead code and constants

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx:95-138`

- [ ] **Step 1: Remove unused constants**

Delete these blocks entirely:
- `OUTCOME_STYLES` (lines 95-100)
- `PROJECT_PALETTE` (lines 102-110)
- `useProjectColors` hook (lines 112-125)
- `TIMELINE_TYPE_STYLES` (lines 127-138)
- `formatRelativeTime` function (lines 156-167)
- `SessionTimeline` component (lines 169-199)
- `DayNarrative` component (lines 369-443) -- will be replaced inline in DaySection

Keep: `getRelativeTime`, `formatDate`, `formatDuration`, `extractProject`, `avatarColor`, `formatMsgCount`, `highlightCode`, `JUNK_PROJECTS`.

- [ ] **Step 2: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "refactor(web): strip unused constants and components from ActivityFeed"
```

### Task 3: Rewrite SessionTurns with profile pic and blue styling

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx` -- replace `SessionTurns` component (lines 201-227)

- [ ] **Step 1: Rewrite SessionTurns**

Replace the entire `SessionTurns` component with:

```tsx
function SessionTurns({ turns, actorName }: { turns: Array<{ ask: string; did: string[] }>; actorName?: string }) {
  if (!turns?.length) return null;
  const initial = (actorName || "U")[0].toUpperCase();
  return (
    <div className="space-y-3 mt-2">
      {turns.map((turn, i) => (
        <div key={i}>
          <div className="flex items-start gap-2">
            <span className="shrink-0 bg-sol-blue/15 text-sol-blue rounded-full w-5 h-5 text-[10px] flex items-center justify-center font-semibold mt-0.5">
              {initial}
            </span>
            <span className="text-[12px] text-sol-blue font-medium leading-snug">
              {turn.ask}
            </span>
          </div>
          {turn.did.length > 0 && (
            <ul className="mt-1 ml-7 space-y-0.5">
              {turn.did.map((d, j) => (
                <li key={j} className="flex gap-1.5 text-[11px] text-sol-text-dim leading-snug">
                  <span className="text-sol-text-dim/30 select-none shrink-0">-</span>
                  <span>{highlightCode(d)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
```

Key changes from current:
- Yellow `ASK` label replaced with blue avatar circle showing user initial
- Ask text: `text-sol-blue font-medium text-[12px]` (tier 5)
- Did items: `text-sol-text-dim text-[11px]` (tier 6)
- `actorName` prop added for the avatar initial
- Larger spacing (`space-y-3`, `mt-2`) for breathing room

- [ ] **Step 2: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "feat(web): SessionTurns with blue profile avatars instead of yellow ASK labels"
```

### Task 4: Rewrite SessionCard with strict hierarchy

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx` -- replace `SessionCard` component (lines 229-367)

- [ ] **Step 1: Rewrite SessionCard**

Replace the entire `SessionCard` component. Key design decisions:
- No colored left border (remove `outcome.border`)
- No outcome badge (remove `outcome.badge`)
- Title: `text-[14px] font-bold text-sol-text` (tier 3)
- Headline (collapsed): `text-[12px] text-sol-text-muted` (tier 4)
- When expanded: headline SWAPS to bulleted `key_changes` or expanded summary
- Metadata: `text-[10px] font-mono text-sol-text-dim/50` (tier 7)
- Project badge: `text-[10px] font-mono text-sol-text-dim/40` (tier 7)

```tsx
function SessionCard({ item, compact, showActor, onNavigate }: {
  item: any;
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const actorName = item.actor?.name || "Unknown";
  const project = extractProject(item.project_path);
  const isActive = item.status === "active";
  const isTrivial = (item.message_count || 0) < 3;

  const rawDuration = item.started_at && item.updated_at ? item.updated_at - item.started_at : 0;
  const cappedDuration = Math.min(rawDuration, 8 * 3600000);
  const duration = cappedDuration > 60000 && cappedDuration < 8 * 3600000 ? formatDuration(0, cappedDuration) : null;
  const time = getRelativeTime(item.updated_at || item.started_at || item.generated_at);

  const handleNav = useCallback(() => {
    if (onNavigate) onNavigate(item.conversation_id);
    else router.push(`/conversation/${item.conversation_id}`);
  }, [onNavigate, item.conversation_id, router]);

  const rawTitle = item.title || "Session";
  const firstName = actorName.split(" ")[0];
  const displayTitle = showActor && rawTitle.startsWith(firstName + " ")
    ? rawTitle.slice(firstName.length + 1)
    : rawTitle;

  const headline = item.headline || "";
  const changes = item.key_changes || [];
  const hasTurns = item.turns?.length > 0;
  const hasDetail = hasTurns || changes.length > 0;
  const expandedSummary = changes.length > 0 ? changes : (item.summary ? [item.summary] : []);

  const msgCount = item.message_count || 0;
  const metaParts = [
    duration,
    msgCount > 0 ? `${formatMsgCount(msgCount)} msgs` : null,
  ].filter(Boolean);

  return (
    <div
      onClick={() => hasDetail && setExpanded(!expanded)}
      className={`${compact ? "py-2 px-1" : "py-2.5 px-1"} ${isTrivial ? "opacity-40" : ""} ${hasDetail ? "cursor-pointer" : ""} hover:bg-sol-bg-alt/20 transition-colors`}
    >
      {/* Row 1: title + metadata */}
      <div className="flex items-baseline gap-2 min-w-0">
        {showActor && (
          <span className={`shrink-0 ${avatarColor(actorName)} rounded-full w-5 h-5 text-[10px] flex items-center justify-center font-semibold relative -top-px`}>
            {actorName[0].toUpperCase()}
          </span>
        )}
        <span
          onClick={(e) => { e.stopPropagation(); handleNav(); }}
          className={`font-bold text-sol-text truncate cursor-pointer hover:text-sol-blue transition-colors ${compact ? "text-[13px]" : "text-[14px]"}`}
        >
          {displayTitle}
        </span>
        {isActive && (
          <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse shrink-0" />
        )}
        <span className="flex-1" />
        {project && (
          <span className="font-mono text-[10px] text-sol-text-dim/40 shrink-0">
            {project}
          </span>
        )}
        <span className="font-mono text-[10px] text-sol-text-dim/50 tabular-nums shrink-0 whitespace-nowrap">
          {metaParts.length > 0 ? `${metaParts.join(" / ")} · ${time}` : time}
        </span>
        {hasDetail && (
          <span className={`text-sol-text-dim/25 text-[9px] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}>
            &#x25B6;
          </span>
        )}
      </div>

      {/* Row 2: headline (collapsed) or expanded summary */}
      {!expanded && headline && (
        <p className={`mt-0.5 text-[12px] text-sol-text-muted leading-snug truncate ${showActor ? "ml-7" : ""}`}>
          {headline}
        </p>
      )}

      {/* Expanded: bulleted summary replaces headline */}
      {expanded && (
        <div className={`mt-1.5 ${showActor ? "ml-7" : ""}`} onClick={(e) => e.stopPropagation()}>
          {expandedSummary.length > 0 && (
            <ul className="space-y-0.5 mb-2">
              {expandedSummary.map((c: string, i: number) => (
                <li key={i} className="flex gap-1.5 text-[12px] text-sol-text-muted leading-snug">
                  <span className="text-sol-text-dim/30 select-none shrink-0">-</span>
                  <span>{highlightCode(c)}</span>
                </li>
              ))}
            </ul>
          )}
          {hasTurns && <SessionTurns turns={item.turns} actorName={actorName} />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "feat(web): SessionCard with strict 7-tier visual hierarchy"
```

### Task 5: Rewrite DaySection with narrative bullets

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx` -- replace `DaySection` component (lines 446-561)

- [ ] **Step 1: Write helper to parse stored narrative into headline + bullets**

Add this helper after `formatMsgCount`:

```tsx
function parseDayNarrative(narrative: string): { headline: string; bullets: string[] } {
  if (!narrative) return { headline: "", bullets: [] };
  const parts = narrative.split("\n---\n");
  if (parts.length >= 2) {
    return {
      headline: parts[0].trim(),
      bullets: parts[1].split("\n").map(b => b.trim()).filter(Boolean),
    };
  }
  return { headline: narrative, bullets: [] };
}
```

- [ ] **Step 2: Rewrite DaySection**

Replace the entire `DaySection` component. Key design:
- Day label: `text-[18px] font-bold text-sol-text` (tier 1)
- Narrative bullets: `text-[13px] text-sol-text-secondary` (tier 2)
- Collapsed: show date + narrative bullets, no session cards
- Today auto-expanded (handled by parent via initial `collapsed` state)
- Remove: outcome bar, project badges in header, `outcomeBar` memo, `PROJECT_PALETTE` usage

```tsx
function DaySection({ day, items, compact, showActor, onNavigate, dayNarrative, isToday }: {
  day: { date: string; session_count: number; highlights: string[] };
  items: any[];
  compact?: boolean;
  showActor?: boolean;
  onNavigate?: (id: string) => void;
  dayNarrative?: { narrative: string; events: any[]; generated_at: number };
  isToday?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!isToday);
  const label = formatDate(day.date);

  const activeCount = useMemo(() => items.filter((i) => i.status === "active").length, [items]);

  const { headline, bullets } = useMemo(
    () => parseDayNarrative(dayNarrative?.narrative || ""),
    [dayNarrative?.narrative]
  );

  return (
    <div className={compact ? "py-1" : "py-2"}>
      {/* Day header */}
      <div
        className="flex items-center gap-3 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`text-sol-text-dim/30 text-[10px] transition-transform ${collapsed ? "" : "rotate-90"}`}>
          &#x25B6;
        </span>
        <span className={`font-bold tracking-tight text-sol-text ${compact ? "text-[15px]" : "text-[18px]"}`}>
          {label}
        </span>
        {activeCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-sol-green/60 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
            {activeCount} active
          </span>
        )}
        <div className="h-px flex-1 bg-sol-border/20" />
        <span className="text-[10px] font-mono text-sol-text-dim/40 tabular-nums">
          {items.length} session{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Narrative bullets -- always visible */}
      {bullets.length > 0 && (
        <ul className={`mt-1.5 ${compact ? "ml-5" : "ml-6"} space-y-0.5`}>
          {bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-[13px] text-sol-text-secondary leading-snug">
              <span className="text-sol-text-dim/30 select-none shrink-0">-</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
      {!bullets.length && headline && (
        <p className={`mt-1 ${compact ? "ml-5" : "ml-6"} text-[13px] text-sol-text-secondary leading-snug`}>
          {headline}
        </p>
      )}

      {/* Session cards -- only when expanded */}
      {!collapsed && (
        <div className={`${compact ? "mt-1.5 ml-3" : "mt-2 ml-4"} divide-y divide-sol-border/10`}>
          {items.map((item: any) => (
            <SessionCard
              key={item.conversation_id}
              item={item}
              compact={compact}
              showActor={showActor}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "feat(web): DaySection with narrative bullets and strict hierarchy"
```

### Task 6: Update ActivityFeed root to pass new props

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx` -- update `ActivityFeed` component (lines 602-716)

- [ ] **Step 1: Update the feed rendering loop**

In the `ActivityFeed` component, update the `DaySection` usage:
- Remove `projectColors` prop (no longer used)
- Remove `onProjectFilter` prop (no longer used)
- Add `isToday` prop based on date comparison
- Remove `projectFilter` state and its filter button
- Remove `useProjectColors` call

Replace lines 698-712 with:

```tsx
        <div className={compact ? "space-y-2" : "space-y-3"}>
          {filteredDaySummaries.map((day: any, idx: number) => {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
            return (
              <DaySection
                key={day.date}
                day={day}
                items={feedByDay.get(day.date) || []}
                compact={compact}
                showActor={mode === "team"}
                onNavigate={onNavigate}
                dayNarrative={digest.day_narratives?.[day.date]}
                isToday={day.date === today}
              />
            );
          })}
        </div>
```

Also remove:
- `const [projectFilter, setProjectFilter]` state (line 605)
- The `projectFilter` filter button JSX (lines 679-687)
- The `projectFilter` from `filteredFeed` (remove the filter clause at line 621)
- The `projectFilter` from `filteredDaySummaries` deps
- The `projectColors` line (line 625)
- Update `setWindowHours` callback to not clear `projectFilter`

- [ ] **Step 2: Move `tz` to component level**

The `tz` memo already exists at line 608. Use it in the DaySection loop instead of computing inline:

```tsx
            const isToday = day.date === new Date().toLocaleDateString("en-CA", { timeZone: tz });
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "feat(web): wire up simplified ActivityFeed with new DaySection props"
```

### Task 7: Visual verification

- [ ] **Step 1: Check dev server is running**

```bash
curl -s -o /dev/null -w "%{http_code}" http://local.codecast.sh
```

If not running: `cd /Users/ashot/src/codecast && ./dev.sh`

- [ ] **Step 2: Take screenshot of the feed view**

Navigate to `http://local.codecast.sh/dashboard` in the browser and screenshot the ActivityFeed. Verify:
- Day labels are large and bold (18px)
- Narrative bullets are visible at secondary weight below day headers
- Session titles are bold and distinct from headlines
- Headlines are lighter gray than titles
- Metadata (time, duration, msgs) is smallest and dimmest
- No colored left borders, no outcome badges, no theme tags
- Collapsed days show narrative bullets but no session cards

- [ ] **Step 3: Expand a session card and verify turns**

Click a session with turns data. Verify:
- Headline swaps to bulleted summary
- User asks show blue avatar circle + blue text
- Did items are indented, dim, smallest text
- Each tier is visually distinct from adjacent tiers

- [ ] **Step 4: Click regen to populate new day narrative format**

Click "regen" button to regenerate day narratives with structured bullets. Verify the narrative bullets appear under day headers after regeneration completes.

- [ ] **Step 5: Fix any visual issues found**

Iterate on any hierarchy problems: if two tiers look too similar, adjust size/weight/color.

- [ ] **Step 6: Final commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "fix(web): visual polish for ActivityFeed hierarchy"
```
