"use client";

/**
 * Hand-built HTML mocks of the product used on the marketing landing page.
 * Real screenshots are too dense to read at page scale; these render the same
 * surfaces at legible sizes with simplified, representative content.
 * Solarized-light palette, matching the page: #fdf6e3 bg, #eee8d5 borders,
 * #002b36 ink, accents #859900 / #b58900 / #268bd2 / #6c71c4 / #2aa198.
 */

const AGENT_COLORS: Record<string, string> = {
  claude: "#268bd2",
  codex: "#859900",
  cursor: "#b58900",
  opencode: "#6c71c4",
  pi: "#2aa198",
};

function AgentChip({ agent }: { agent: string }) {
  return (
    <span className="text-[11px] font-medium" style={{ color: AGENT_COLORS[agent] ?? "#657b83" }}>
      {agent}
    </span>
  );
}

function Avatar({ initials, color = "#6c71c4" }: { initials: string; color?: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </span>
  );
}

/** Mirrors the transcript's SessionMessageBlock: cyan left border, "MESSAGE FROM" header, the sender's session pill. */
function SessionMessageCard({ from, age, size = "sm", children }: { from: string; age?: string; size?: "sm" | "md"; children: React.ReactNode }) {
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

function CircleIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><circle cx="12" cy="12" r="10" /></svg>;
}
function CircleDotIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1.5" fill={color} /></svg>;
}
function CheckCircleIcon({ color }: { color: string }) {
  return <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M9 11l3 3L22 4" /></svg>;
}
function ArrowUpIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}
function MinusIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M5 12h14" /></svg>;
}
function BotIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 13h.01M16 13h.01" /></svg>;
}
function CornerDownRightIcon({ color }: { color: string }) {
  return <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M4 4v7a4 4 0 0 0 4 4h12" /><path d="M15 10l5 5-5 5" /></svg>;
}
function MessageSquareIcon({ color }: { color: string }) {
  return <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

/** Mirrors EntityIdPill for sessions: blue tint, message icon, the session TITLE (never the raw id). */
function SessionPill({ title }: { title: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] align-baseline" style={{ backgroundColor: "rgba(38,139,210,0.1)", color: "#268bd2", borderColor: "rgba(38,139,210,0.2)" }}>
      <MessageSquareIcon color="#268bd2" />
      {title}
    </span>
  );
}

/** Mirrors EntityIdPill for tasks: yellow tint, status glyph, the task TITLE (never the raw id). */
function TaskPill({ title }: { title: string }) {
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
const PLAN_PILL_STYLE = { backgroundColor: "rgba(42,161,152,0.1)", color: "#2aa198", borderColor: "rgba(42,161,152,0.2)" };

function PlanPill({ name }: { name: string }) {
  return <span className="shrink-0 rounded border px-1.5 text-[10px]" style={PLAN_PILL_STYLE}>{name}</span>;
}

/** The cyan-ringed assignee slot every task row carries. */
function AssigneeSlot({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "rgba(42,161,152,0.1)", border: "1px solid rgba(42,161,152,0.3)", ...style }}>
      {children}
    </span>
  );
}

type TaskRowData = { icon: React.ReactNode; id: string; title: React.ReactNode; pill: React.ReactNode; dots: string[]; who: React.ReactNode; pri: React.ReactNode; age: string };

const TASK_ROWS: TaskRowData[] = [
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
function TaskRow({ r, whoSlot, className = "", style }: { r: TaskRowData; whoSlot?: React.ReactNode; className?: string; style?: React.CSSProperties }) {
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

function TaskToolbar() {
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
