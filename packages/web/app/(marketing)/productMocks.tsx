"use client";

/**
 * Hand-built HTML mocks of the product used on the marketing landing page.
 * Real screenshots are too dense to read at page scale; these render the same
 * surfaces at legible sizes with simplified, representative content.
 * Solarized-light palette, matching the page: #fdf6e3 bg, #eee8d5 borders,
 * #002b36 ink, accents #859900 / #b58900 / #268bd2 / #6c71c4 / #2aa198.
 */

export const AGENT_COLORS: Record<string, string> = {
  claude: "#268bd2",
  codex: "#859900",
  cursor: "#b58900",
  opencode: "#6c71c4",
  pi: "#2aa198",
};

export function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="text-[11px] font-medium" style={{ color: AGENT_COLORS[agent] ?? "#657b83" }}>
      {agent}
    </span>
  );
}

export type SessionStatus = "working" | "needs-input" | "idle";
export const STATUS_COLORS: Record<SessionStatus, string> = { working: "#859900", "needs-input": "#b58900", idle: "#93a1a1" };

export function StatusDot({ kind }: { kind: SessionStatus }) {
  const color = STATUS_COLORS[kind];
  return (
    <span
      className="inline-block h-2 w-2 rounded-full shrink-0"
      style={kind === "idle" ? { border: `1.5px solid ${color}` } : { backgroundColor: color }}
    />
  );
}

export function Avatar({ initials, color = "#6c71c4" }: { initials: string; color?: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </span>
  );
}

export function WindowChrome({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: "#eee8d5", borderBottom: "1px solid #e4ddc8" }}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#dc322f" }} />
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#b58900" }} />
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#859900" }} />
      <span className="mx-auto flex items-center gap-2 rounded-md px-3 py-1 text-[11px]" style={{ backgroundColor: "#fdf6e3", color: "#93a1a1", border: "1px solid #e4ddc8" }}>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
        {title}
      </span>
      <span className="rounded-md px-2.5 py-1 text-[11px] font-medium text-white" style={{ backgroundColor: "#002b36" }}>+ New</span>
    </div>
  );
}

export type HeroSession = { status: SessionStatus; title: string; note: string; agent: string; time: string; active?: boolean };

export const HERO_SESSIONS: HeroSession[] = [
  { status: "needs-input", title: "Migrate billing webhooks", note: "Allow running npm test?", agent: "claude", time: "now", active: true },
  { status: "working", title: "Dashboard rewrite", note: "sarah · merging the dashboard half", agent: "claude", time: "1m" },
  { status: "working", title: "Fix flaky auth test", note: "Reproduced, writing regression test", agent: "codex", time: "2m" },
  { status: "working", title: "Ship dark mode", note: "Applying tokens across settings", agent: "cursor", time: "9m" },
  { status: "working", title: "Investigate p95 latency", note: "Profiling the sync endpoint", agent: "opencode", time: "14m" },
  { status: "needs-input", title: "Refactor session cache", note: "Two eviction strategies, which one?", agent: "pi", time: "31m" },
  { status: "idle", title: "Add rate limiting", note: "Merged. 34 files changed", agent: "claude", time: "2h" },
];

/** App sidebar: nav with the Inbox badge, then projects. `badge` may be a node so the film can swap counts. */
export function HeroSidebar({ badge = 2, badgeProps, className = "" }: { badge?: React.ReactNode; badgeProps?: React.HTMLAttributes<HTMLSpanElement>; className?: string }) {
  return (
    <div className={`flex w-44 shrink-0 flex-col gap-0.5 px-3 py-4 text-[12px] ${className}`} style={{ borderRight: "1px solid #eee8d5", color: "#657b83" }}>
      <div className="flex items-center justify-between rounded-md px-2.5 py-1.5 font-medium" style={{ backgroundColor: "#eee8d5", color: "#002b36" }}>
        <span>Inbox</span>
        <span {...badgeProps} className="relative inline-block rounded-full px-1.5 text-[10px] text-white" style={{ backgroundColor: "#b58900", ...badgeProps?.style }}>{badge}</span>
      </div>
      <div className="px-2.5 py-1.5">Feed</div>
      <div className="px-2.5 py-1.5">Tasks</div>
      <div className="px-2.5 py-1.5">Docs</div>
      <div className="px-2.5 py-1.5">Workflows</div>
      <div className="mt-4 px-2.5 text-[10px] uppercase tracking-wider" style={{ color: "#93a1a1" }}>Projects</div>
      <div className="px-2.5 py-1.5">codecast</div>
      <div className="px-2.5 py-1.5">api</div>
      <div className="px-2.5 py-1.5">mobile</div>
    </div>
  );
}

/** Mirrors ConversationList's parent link: rotated reply arrow, label, the parent's title in cyan. */
export function ParentLink({ title, label = "spawned by" }: { title: string; label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] min-w-0" style={{ color: "#93a1a1" }}>
      <svg className="h-2.5 w-2.5 rotate-180 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
      <span className="shrink-0">{label}</span>
      <span className="truncate" style={{ color: "rgba(42,161,152,0.8)" }}>{title}</span>
    </div>
  );
}

/**
 * One inbox row. `dot`, `note` and `chip` accept nodes so the film can stack
 * cross-fading states in place; defaults render the plain session.
 */
export function SessionRow({ s, dot, note, chip, parent, className = "", style }: {
  s: HeroSession;
  dot?: React.ReactNode;
  note?: React.ReactNode;
  chip?: React.ReactNode;
  parent?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`flex flex-col gap-1 px-4 py-2.5 ${className}`}
      style={{ ...(s.active ? { backgroundColor: "rgba(181,137,0,0.08)", borderLeft: "2px solid #b58900" } : { borderLeft: "2px solid transparent" }), ...style }}
    >
      {parent}
      <div className="flex items-center gap-2">
        {dot ?? <StatusDot kind={s.status} />}
        <span className="truncate text-[13px] font-medium" style={{ color: "#002b36" }}>{s.title}</span>
        <span className="ml-auto text-[10px] shrink-0" style={{ color: "#93a1a1" }}>{s.time}</span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        <span className="relative min-w-0 flex-1 truncate text-[11px]" style={{ color: "#93a1a1" }}>{note ?? s.note}</span>
        <span className="ml-auto shrink-0">{chip ?? <AgentChip agent={s.agent} />}</span>
      </div>
    </div>
  );
}

export function ConversationHeader({ title, status, agent, initials, avatarColor, className = "" }: {
  title: string; status: SessionStatus; agent: string; initials: string; avatarColor: string; className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 px-5 py-3 text-[12px] ${className}`} style={{ borderBottom: "1px solid #eee8d5" }}>
      <span className="font-medium" style={{ color: "#002b36" }}>{title}</span>
      <span className="flex items-center gap-1.5" style={{ color: STATUS_COLORS[status] }}>
        <StatusDot kind={status} /> {status === "needs-input" ? "needs input" : status}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <Avatar initials={initials} color={avatarColor} />
        <AgentChip agent={agent} />
      </span>
    </div>
  );
}

/** Real UserPrompt chrome: blue-tinted card, name header. */
export function UserPromptCard({ name = "Ashot", initials = "A", color = "#cb4b16", children }: { name?: string; initials?: string; color?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ backgroundColor: "rgba(38,139,210,0.1)", border: "1px solid rgba(38,139,210,0.3)" }}>
      <div className="mb-1 flex items-center gap-1.5">
        <Avatar initials={initials} color={color} />
        <span className="text-[11px] font-medium" style={{ color: "#268bd2" }}>{name}</span>
      </div>
      <div style={{ color: "#002b36" }}>{children}</div>
    </div>
  );
}

export const CANVAS_BARS = [
  { x: 6, h: 26, c: "#93a1a1" }, { x: 25, h: 20, c: "#93a1a1" }, { x: 44, h: 22, c: "#93a1a1" },
  { x: 63, h: 12, c: "#268bd2" }, { x: 82, h: 9, c: "#268bd2" }, { x: 101, h: 7, c: "#859900" },
];

/** A cast-canvas block: titled card with the p95 bar chart. `bar` wraps each bar so the film can grow them. */
export function CanvasCard({ title = "Webhook p95 by endpoint", bar, className = "" }: {
  title?: string; bar?: (rect: React.ReactNode, i: number) => React.ReactNode; className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-lg overflow-hidden ${className}`} style={{ border: "1px solid rgba(147,161,161,0.25)", backgroundColor: "#ffffff" }}>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px]" style={{ color: "#93a1a1", borderBottom: "1px solid rgba(147,161,161,0.12)" }}>
        {title}
        <svg className="ml-auto h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
      </div>
      <svg viewBox="0 0 120 40" className="block w-full px-2 py-1.5">
        {CANVAS_BARS.map((b, i) => {
          const rect = <rect key={b.x} x={b.x} y={36 - b.h} width={13} height={b.h} rx={1.5} fill={b.c} />;
          return bar ? <g key={b.x}>{bar(rect, i)}</g> : rect;
        })}
        <line x1="2" y1="36.5" x2="118" y2="36.5" stroke="#eee8d5" strokeWidth="1" />
      </svg>
    </div>
  );
}

/** Mirrors the transcript's SessionMessageBlock: cyan left border, "MESSAGE FROM" header, the sender's session pill. */
export function SessionMessageCard({ from, age, size = "sm", children }: { from: string; age?: string; size?: "sm" | "md"; children: React.ReactNode }) {
  const md = size === "md";
  return (
    <div className="rounded" style={{ borderLeft: "2px solid rgba(42,161,152,0.6)", backgroundColor: "rgba(42,161,152,0.05)" }}>
      <div className={`flex items-center gap-2 ${md ? "px-3 pt-2 pb-1" : "px-2.5 pt-1.5 pb-0.5"}`}>
        <CornerDownRightIcon color="rgba(42,161,152,0.7)" />
        <span className={`${md ? "text-[10px]" : "text-[9px]"} font-medium uppercase tracking-wide`} style={{ color: "rgba(42,161,152,0.8)" }}>Message from</span>
        <SessionPill title={from} />
        {age && <span className="ml-auto text-[10px]" style={{ color: "#93a1a1" }}>{age}</span>}
      </div>
      <div className={md ? "px-3 pb-2" : "px-2.5 pb-1.5 text-[11px]"} style={{ color: "#002b36" }}>{children}</div>
    </div>
  );
}

export function PermissionBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-3" style={{ backgroundColor: "#fdf6e3", border: "1px solid #b58900" }}>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium" style={{ color: "#b58900" }}>
        <StatusDot kind="needs-input" /> Permission
      </div>
      <div className="mb-2.5" style={{ color: "#002b36" }}>{children}</div>
      <div className="flex gap-2">
        <span className="rounded-md px-3 py-1 text-[11px] font-medium text-white" style={{ backgroundColor: "#859900" }}>Approve</span>
        <span className="rounded-md px-3 py-1 text-[11px]" style={{ border: "1px solid #e4ddc8", color: "#657b83" }}>Deny</span>
      </div>
    </div>
  );
}

export function Composer({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[11px] ${className}`} style={{ border: "1px solid #eee8d5", color: "#93a1a1" }}>
      Send a message...
      <span className="ml-auto rounded px-1.5" style={{ backgroundColor: "#eee8d5" }}>↵</span>
    </div>
  );
}

export function InboxHeroMock() {
  return (
    <div
      className="rounded-xl overflow-hidden font-mono text-left shadow-2xl"
      style={{ backgroundColor: "#fdf6e3", border: "1px solid #e4ddc8" }}
      aria-label="Codecast inbox: live agent sessions on the left, one conversation open with a permission prompt"
      role="img"
    >
      <WindowChrome title="Search conversations…  ⌘K" />
      <div className="flex" style={{ minHeight: 430 }}>
        <HeroSidebar className="hidden md:flex" />

        <div className="w-full sm:w-[19rem] shrink-0 py-2" style={{ borderRight: "1px solid #eee8d5" }}>
          {HERO_SESSIONS.map(s => <SessionRow key={s.title} s={s} />)}
        </div>

        <div className="hidden sm:flex min-w-0 flex-1 flex-col">
          <ConversationHeader title="Migrate billing webhooks" status="needs-input" agent="claude" initials="A" avatarColor="#cb4b16" />
          <div className="flex flex-1 flex-col gap-3 px-5 py-4 text-[12px]" style={{ color: "#657b83" }}>
            <UserPromptCard>
              switch us to the new Stripe webhook API. <span style={{ color: "#6c71c4" }}>@sarah</span> owns the dashboard side
            </UserPromptCard>

            <div className="leading-relaxed">
              Done with <span style={{ color: "#002b36" }}>14 of 16 endpoints</span>. Filed{" "}
              <TaskPill title="Retry queue for failed webhooks" /> and handed the dashboard half to{" "}
              <SessionPill title="Dashboard rewrite" />. Latency after the switch:
            </div>

            <div className="flex gap-2.5">
              <CanvasCard className="flex-1" />
              <div className="w-[34%] shrink-0 rounded-lg overflow-hidden" style={{ border: "1px solid rgba(147,161,161,0.25)" }}>
                <div className="h-2.5" style={{ backgroundColor: "#002b36" }} />
                <div className="space-y-1 px-2 py-1.5" style={{ backgroundColor: "#fdf6e3" }}>
                  <div className="h-1.5 w-3/4 rounded-full" style={{ backgroundColor: "#e4ddc8" }} />
                  <div className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: "#e4ddc8" }} />
                  <div className="h-4 w-full rounded" style={{ backgroundColor: "rgba(133,153,0,0.25)" }} />
                </div>
                <div className="px-2 py-1 text-[9px]" style={{ color: "#93a1a1", backgroundColor: "#ffffff" }}>checkout, after</div>
              </div>
            </div>

            <SessionMessageCard from="Dashboard rewrite">dashboard half merged, staging green on my end</SessionMessageCard>

            <PermissionBlock>
              Allow running <span className="rounded px-1" style={{ backgroundColor: "#eee8d5" }}>npm test</span> in packages/api?
            </PermissionBlock>

            <Composer className="mt-auto" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Icons: inline copies of the lucide glyphs the real task list uses ── */

export function CircleIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><circle cx="12" cy="12" r="10" /></svg>;
}
export function CircleDotIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1.5" fill={color} /></svg>;
}
export function CheckCircleIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M9 11l3 3L22 4" /></svg>;
}
export function ArrowUpIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}
export function MinusIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M5 12h14" /></svg>;
}
export function BotIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 13h.01M16 13h.01" /></svg>;
}
export function CornerDownRightIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M4 4v7a4 4 0 0 0 4 4h12" /><path d="M15 10l5 5-5 5" /></svg>;
}
export function MessageSquareIcon({ color }: { color: string }) {
  return <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

/** Mirrors EntityIdPill for sessions: blue tint, message icon, the session TITLE (never the raw id). */
export function SessionPill({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] align-baseline" style={{ backgroundColor: "rgba(38,139,210,0.1)", color: "#268bd2", borderColor: "rgba(38,139,210,0.2)" }}>
      <MessageSquareIcon color="#268bd2" />
      {title}
    </span>
  );
}

/** Mirrors EntityIdPill for tasks: yellow tint, status glyph, the task TITLE (never the raw id). */
export function TaskPill({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] align-baseline" style={{ backgroundColor: "rgba(181,137,0,0.1)", color: "#b58900", borderColor: "rgba(181,137,0,0.2)" }}>
      <svg className="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="#b58900" strokeWidth={2.5}><circle cx="12" cy="12" r="10" /></svg>
      {title}
    </span>
  );
}

/**
 * Mirrors TaskRow in app/tasks/page.tsx: status icon → dim mono short id →
 * title → source-agent icon → plan pill (cyan) → label dots → assignee avatar
 * (cyan ring) → priority icon → age.
 */
export const PLAN_PILL_STYLE = { backgroundColor: "rgba(42,161,152,0.1)", color: "#2aa198", borderColor: "rgba(42,161,152,0.2)" };

export function PlanPill({ name }: { name: string }) {
  return <span className="shrink-0 rounded border px-1.5 text-[10px]" style={PLAN_PILL_STYLE}>{name}</span>;
}

/** The cyan-ringed assignee slot every task row carries. */
export function AssigneeSlot({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(42,161,152,0.1)", border: "1px solid rgba(42,161,152,0.3)", ...style }}>
      {children}
    </span>
  );
}

export type TaskRowData = { icon: React.ReactNode; id: string; title: React.ReactNode; pill: React.ReactNode; dots: string[]; who: React.ReactNode; pri: React.ReactNode; age: string };

export const TASK_ROWS: TaskRowData[] = [
  { icon: <CircleDotIcon color="#b58900" />, id: "ct-619", title: "Fix supply write-back", pill: null, dots: ["#268bd2"], who: <span title="codex"><BotIcon color="#859900" /></span>, pri: <ArrowUpIcon color="#cb4b16" />, age: "2h" },
  { icon: <CircleDotIcon color="#6c71c4" />, id: "ct-703", title: "Investigate matchmaker costs", pill: null, dots: ["#d33682"], who: <span title="claude"><BotIcon color="#268bd2" /></span>, pri: <MinusIcon color="#93a1a1" />, age: "3h" },
  { icon: <CircleIcon color="#268bd2" />, id: "ct-712", title: "SMS reminders before sched", pill: null, dots: ["#b58900", "#2aa198"], who: <Avatar initials="A" color="#cb4b16" />, pri: <ArrowUpIcon color="#cb4b16" />, age: "6h" },
  { icon: <CheckCircleIcon color="#859900" />, id: "ct-698", title: "Rename provider IDs", pill: <PlanPill name="Billing" />, dots: [], who: <span title="opencode"><BotIcon color="#6c71c4" /></span>, pri: <MinusIcon color="#93a1a1" />, age: "1d" },
];

/**
 * Mirrors TaskRow in app/tasks/page.tsx: status icon, dim mono short id,
 * title, plan pill (cyan), label dots, assignee avatar (cyan ring), priority
 * icon, age. `whoSlot` replaces the whole assignee slot when a caller animates it.
 */
export function TaskRow({ r, whoSlot, className = "", style }: { r: TaskRowData; whoSlot?: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-[7px] ${className}`} style={{ borderBottom: "1px solid rgba(147,161,161,0.08)", ...style }}>
      {r.icon}
      <span className="w-12 shrink-0 text-[11px]" style={{ color: "#657b83" }}>{r.id}</span>
      <span className="relative min-w-0 flex-1 truncate text-[12.5px]" style={{ color: "#002b36" }}>{r.title}</span>
      {r.pill}
      {r.dots.map(d => <span key={d} className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d }} />)}
      {whoSlot ?? <AssigneeSlot>{r.who}</AssigneeSlot>}
      {r.pri}
      <span className="w-6 shrink-0 text-right text-[10px]" style={{ color: "#93a1a1" }}>{r.age}</span>
    </div>
  );
}

export function TaskToolbar() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)", color: "#657b83" }}>
      <span className="rounded px-2 py-0.5 font-medium" style={{ backgroundColor: "#eee8d5", color: "#002b36" }}>All</span>
      <span className="px-1">Filter</span>
      <span className="ml-auto flex items-center gap-2">
        <span>Sort by priority</span>
        <span className="rounded px-1" style={{ backgroundColor: "#eee8d5" }}>⌘K</span>
      </span>
    </div>
  );
}

export function TasksMock() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-left" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }} role="img" aria-label="Task tracker with tasks assigned to agents and people">
      <TaskToolbar />
      <div className="py-0.5">
        {TASK_ROWS.map(r => <TaskRow key={r.id} r={r} />)}
      </div>
    </div>
  );
}

/**
 * Mirrors DocumentDetailLayout: slim icon-toolbar header, bordered title
 * block, prose body — plus a live collaborator presence chip.
 */
export function DocsMock() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-left" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }} role="img" aria-label="Shared doc being edited by a person and an agent together">
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)", color: "#657b83" }}>
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        <span className="ml-auto flex items-center gap-1.5 text-[10px]">
          <Avatar initials="A" color="#cb4b16" />
          <span className="flex items-center gap-1 rounded-full px-2 py-0.5" style={{ backgroundColor: "rgba(38,139,210,0.1)", color: "#268bd2" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#268bd2" }} /> claude editing
          </span>
        </span>
      </div>
      <div className="px-4 py-2.5" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)" }}>
        <div className="text-[15px] font-semibold" style={{ color: "#002b36" }}>Auth migration plan</div>
        <div className="mt-0.5 text-[10px]" style={{ color: "#93a1a1" }}>doc:auth-migration · updated 4m ago</div>
      </div>
      <div className="space-y-2 px-4 py-3 text-[12px]" style={{ color: "#657b83" }}>
        <div className="font-semibold" style={{ color: "#002b36" }}>Rollout steps</div>
        <div>1. Dual-write sessions to the new token store</div>
        <div>2. Migrate refresh flow behind a flag</div>
        <div className="rounded px-1 -mx-1" style={{ backgroundColor: "rgba(38,139,210,0.12)" }}>3. Rollback: flip the flag, tokens stay valid<span className="inline-block ml-0.5 h-3.5 w-0.5 align-middle" style={{ backgroundColor: "#268bd2" }} /></div>
        <div className="mt-1 rounded-lg p-2.5 text-[11px]" style={{ backgroundColor: "#ffffff", border: "1px solid rgba(147,161,161,0.2)" }}>
          <span style={{ color: "#268bd2" }}>claude</span> — added the rollback section from <SessionPill title="Token store migration" />. Review?
        </div>
      </div>
    </div>
  );
}

/**
 * Mirrors the transcript's SessionMessageBlock (cyan left-border card with an
 * uppercase "MESSAGE FROM" header and a session-id pill) followed by the
 * agent's reply prose — a worker session's view of a lead agent's cast send.
 */
export function AgentChatMock() {
  return (
    <div className="rounded-xl overflow-hidden font-mono text-left" style={{ backgroundColor: "#FBF5E2", border: "1px solid #e4ddc8" }} role="img" aria-label="Two agent sessions messaging each other to divide work">
      <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)" }}>
        <span className="font-medium" style={{ color: "#002b36" }}>Fix auth race</span>
        <span className="flex items-center gap-1" style={{ color: "#859900" }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#859900" }} /> working
        </span>
        <span className="ml-auto"><AgentChip agent="codex" /></span>
      </div>
      <div className="space-y-2.5 px-3 py-3 text-[12px]">
        <SessionMessageCard from="Auth race — client half" age="2m" size="md">
          take ct-641, the API half — I&apos;ll do the client and meet you at the integration test
        </SessionMessageCard>
        <div className="leading-relaxed" style={{ color: "#657b83" }}>
          Claimed <TaskPill title="Stripe webhook API" />.
          API half done, deploying to staging — I&apos;ll message you when the integration test is green.
        </div>
        <div className="rounded px-2.5 py-1.5 text-[11px]" style={{ backgroundColor: "#eee8d5", color: "#586e75" }}>
          $ cast send jx71ejx &quot;staging is green — your turn&quot;
        </div>
      </div>
    </div>
  );
}

/** The iPhone bezel used on the page: dark frame, notch pill, dark screen. */
export function PhoneFrame({ children, className = "", screenClassName = "" }: { children: React.ReactNode; className?: string; screenClassName?: string }) {
  return (
    <div className={`relative bg-[#002b36] rounded-[2.5rem] p-3 shadow-2xl ${className}`}>
      <div className={`bg-[#002b36] rounded-[2rem] overflow-hidden ${screenClassName}`}>
        <div className="h-6 bg-[#002b36] flex items-center justify-center">
          <div className="w-20 h-4 bg-[#073642] rounded-full"></div>
        </div>
        {children}
      </div>
    </div>
  );
}
