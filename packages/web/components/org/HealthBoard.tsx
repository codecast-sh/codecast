"use client";
// The health page (org-staffing.md S29, as a page): how work moves through
// the company this week, and what a person can change about it. Three
// columns on a desktop: the chart as a flow map (the page passes it in, drawn
// by OrgGraph in its flow mode), the week's numbers and each role's volume
// with a what if, and the Chief of Staff's conversation at full height. What
// waits on the person runs as one strip across the top, each card saying
// what kind of ask it is, who asks, and the one thing to do. Every number
// comes from orgFlow.ts over org.health; this file computes none.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ArrowRightLeft, ChevronDown, ChevronRight, ExternalLink, MessageSquareText, PanelRightClose, PanelRightOpen, Sparkles } from "lucide-react";
import { agoOf } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { OrgButton } from "./OrgButton";
import { RoleFace } from "./RoleFace";
import { SectionLabel } from "./OrgScopePanel";
import { AreaDetail, AskRole, ChiefReadSection, Composer, HealthNote, ReviewEndedLine, ReviewSessionLink } from "./StaffingPane";
import { chiefRead, needsYou, type NeedsYouItem } from "./staffingModel";
import { companyFlow, flowDays, moveAsk, projectCap, projectMove, type RoleFlow } from "./orgFlow";
import type { QueueItem } from "../../lib/decisionQueue";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgRole, OrgTree } from "./orgTypes";

export type HealthBoardProps = {
  tree: OrgTree | null;
  health: OrgHealth | null;
  /** Each role's week (orgFlow.roleFlows), read once by the page for the map and this column. */
  flows: RoleFlow[];
  healthMissing?: boolean;
  healthError?: string;
  onRetryHealth?: () => void;
  proposals: OrgProposalRow[];
  queue: QueueItem[];
  chief: OrgRole | null;
  now: number;
  /** The chart in its flow mode; the page owns it so selection and the fit stay its own. */
  map: ReactNode;
  phone?: boolean;
  /** The role the map and the volume list both point at (hover or click). */
  focusRoleId: string | null;
  onFocusRole: (roleId: string | null) => void;
  /** A row under the pointer: the map lights it without opening anything. */
  onHoverRole?: (roleId: string | null) => void;
  reviewing?: boolean;
  reviewEnded?: boolean;
  reviewSessionId?: string | null;
  onOpenSession: (id: string) => void;
  onPickProposal: (shortId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onAnswerDecision?: (decisionId: string, index: number) => void;
  onTrigger?: (taskId: string, verb: "pause" | "resume" | "runNow") => void;
  onSetTriggerEvery?: (taskId: string, intervalMs: number) => void;
  onSendToRole?: (conversationId: string, text: string) => void;
  onResumeChief?: (roleId: string) => void;
  /** Set a role's daily limit, when the viewer may edit that role. */
  onSetLimit?: (roleId: string, perDay: number) => void;
  canEditRole?: (roleId: string) => boolean;
};

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";
/** One colour per measure, everywhere on the page: the map's flow, the bars, the tiles. */
export const FLOW_TONE = { reached: "var(--sol-blue)", closed: "var(--sol-green)", asked: "var(--sol-violet)", limit: "var(--sol-orange)" } as const;
const CHIEF_W = 400;

export function HealthBoard(props: HealthBoardProps) {
  const { tree, health, now } = props;
  const { flows } = props;
  const company = useMemo(() => companyFlow(flows), [flows]);
  const items = useMemo(() => needsYou(tree, health, props.queue, props.proposals, null), [tree, health, props.queue, props.proposals]);
  const read = useMemo(() => chiefRead(tree, health, props.proposals), [tree, health, props.proposals]);
  // The board measures itself: beside the app's own sidebars the page can be
  // 1200px or 2400px, and the map must never be the column that loses.
  const rootRef = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  // Measured before the first paint, so a narrow page never flashes the roomy layout.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.phone]);
  const roomy = width === 0 || width >= 1260;
  const [chatChoice, setChatOpen] = useState<boolean | null>(null);
  const chatOpen = chatChoice ?? roomy;
  // The org is a wide, shallow tree: the map is a band across the page,
  // and the numbers sit below it in two columns when there is room.
  const mainW = width === 0 ? 1200 : width - (chatOpen ? CHIEF_W : 44);
  const mapH = Math.round(Math.max(260, Math.min(400, (height || 900) * 0.3)));
  const insights = (
    <Insights {...props} company={company} read={read} />
  );
  if (props.phone) {
    return (
      <div className="h-full overflow-y-auto px-4 pb-10" data-health-page="phone">
        <WaitingStrip items={items} now={now} onAnswer={props.onAnswerDecision} onOpenSession={props.onOpenSession} onPickProposal={props.onPickProposal} onSend={props.onSendToRole} stacked />
        {insights}
        {props.chief?.standing?.conversation_id && (
          <OrgButton className="mt-4 w-full" onClick={() => props.onOpenSession(props.chief!.standing!.conversation_id!)}>
            <MessageSquareText className="w-3.5 h-3.5" /> Talk to {props.chief.name}
          </OrgButton>
        )}
      </div>
    );
  }
  return (
    <div ref={rootRef} className="h-full flex min-h-0" data-health-page="desktop">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <WaitingStrip items={items} now={now} onAnswer={props.onAnswerDecision} onOpenSession={props.onOpenSession} onPickProposal={props.onPickProposal} onSend={props.onSendToRole} />
        <div className="relative shrink-0 border-b" style={{ height: mapH, borderColor: BORDER, background: "radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--sol-bg-alt) 55%, transparent) 0%, transparent 70%)" }} data-health-map>
          {props.map}
          <MapLegend />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-10" data-health-insights>
          <Insights {...props} company={company} read={read} columns={mainW >= 820} />
        </div>
      </div>
      <ChiefColumn chief={props.chief} open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} onOpenSession={props.onOpenSession} onResume={props.onResumeChief} />
    </div>
  );
}

// ---------------------------------------------------------------- waiting on you

const ASK_KIND: Record<NeedsYouItem["kind"], { word: string; tone: string; hint: string }> = {
  decision: { word: "Decision", tone: "var(--sol-violet)", hint: "A question only you can answer." },
  blocked: { word: "Blocked on you", tone: "var(--sol-orange)", hint: "The role stopped and is waiting for your word in its thread." },
  proposal: { word: "Org change", tone: "var(--sol-blue)", hint: "Changes to the org chart, proposed for your verdict." },
};

/** What waits on the person, oldest first inside each kind: one card each,
 *  across the top so it never pushes the picture of the company down. */
function WaitingStrip({ items, now, onAnswer, onOpenSession, onPickProposal, onSend, stacked }: { items: NeedsYouItem[]; now: number; onAnswer?: (decisionId: string, index: number) => void; onOpenSession: (id: string) => void; onPickProposal: (shortId: string) => void; onSend?: (conversationId: string, text: string) => void; stacked?: boolean }) {
  const counts = items.reduce<Record<string, number>>((m, it) => ({ ...m, [it.kind]: (m[it.kind] ?? 0) + 1 }), {});
  return (
    <section className={cn("shrink-0", !stacked && "border-b px-4 sm:px-6 py-3")} style={{ borderColor: BORDER }} data-needs-you={items.length || "empty"}>
      <div className="flex items-baseline gap-3 mb-2">
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--sol-text)" }}>{items.length === 0 ? "Nothing is waiting on you" : `${items.length} ${items.length === 1 ? "thing is" : "things are"} waiting on you`}</h2>
        <span className="text-[11.5px] flex items-center gap-3" style={{ color: "var(--sol-text-dim)" }}>
          {(Object.keys(ASK_KIND) as NeedsYouItem["kind"][]).filter((k) => counts[k]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5" title={ASK_KIND[k].hint}><span className="w-1.5 h-1.5 rounded-full" style={{ background: ASK_KIND[k].tone }} />{counts[k]} {ASK_KIND[k].word.toLowerCase()}</span>
          ))}
        </span>
      </div>
      {items.length > 0 && (
        <div className={cn(stacked ? "flex flex-col gap-2" : "flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1 snap-x")}>
          {items.map((it) => <WaitingCard key={it.key} it={it} now={now} onAnswer={onAnswer} onOpenSession={onOpenSession} onPickProposal={onPickProposal} onSend={onSend} wide={stacked} />)}
        </div>
      )}
    </section>
  );
}

function WaitingCard({ it, now, onAnswer, onOpenSession, onPickProposal, onSend, wide }: { it: NeedsYouItem; now: number; onAnswer?: (decisionId: string, index: number) => void; onOpenSession: (id: string) => void; onPickProposal: (shortId: string) => void; onSend?: (conversationId: string, text: string) => void; wide?: boolean }) {
  const k = ASK_KIND[it.kind];
  const [replying, setReplying] = useState(false);
  const who = it.kind === "proposal" ? (it.proposal.author.name ?? "A proposal") : it.role?.name ?? "A session";
  const at = it.kind === "decision" ? it.item.createdAt : it.kind === "blocked" ? it.role.standing?.state_at ?? null : it.proposal.created_at;
  // A role's pinned line often opens with its own name, which the card's header already says.
  const ownName = it.kind === "blocked" ? `${it.role.name}:` : "";
  const body = it.kind === "decision" ? it.item.question : it.kind === "blocked" ? (it.line.toLowerCase().startsWith(ownName.toLowerCase()) ? it.line.slice(ownName.length).trim() : it.line) : it.proposal.title;
  const conv = it.kind === "decision" ? it.item.conversationId : it.kind === "blocked" ? it.conversationId : null;
  return (
    <article className={cn("snap-start shrink-0 rounded-xl border flex flex-col", wide ? "w-full" : "w-[300px]")} style={{ borderColor: `color-mix(in srgb, ${k.tone} 32%, transparent)`, background: "var(--sol-card)", boxShadow: `inset 3px 0 0 ${k.tone}` }} data-needs-you-item={it.kind}>
      <div className="flex items-center gap-2 px-3 pt-2">
        {it.kind !== "proposal" && it.role ? <RoleFace role={it.role} size={18} /> : <Sparkles className="w-4 h-4" style={{ color: k.tone }} />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: "var(--sol-text-secondary)" }}>{who}</span>
        {at ? <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{agoOf(now - at).replace(/ ago$/, "")}</span> : null}
        <span className="shrink-0 text-[10.5px] font-semibold px-1.5 h-[18px] inline-flex items-center rounded" style={{ background: `color-mix(in srgb, ${k.tone} 14%, transparent)`, color: k.tone }} title={k.hint}>{k.word}</span>
      </div>
      <p className="px-3 mt-1 text-[12.5px] leading-snug line-clamp-2" style={{ color: "var(--sol-text)" }} title={body}>{body}</p>
      <div className="mt-auto px-3 pt-1.5 pb-2 flex flex-col gap-1">
        {it.kind === "proposal" && <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{it.remaining === 1 ? "1 change" : `${it.remaining} changes`} to decide</span>}
        {it.kind === "decision" && it.canAnswerInPlace && onAnswer ? (
          <div className="flex flex-wrap gap-1" data-needs-you-options>
            {it.item.options.map((o, i) => (
              <OrgButton key={i} size="sm" primary={it.item.defaultOption === i} onClick={() => onAnswer(it.item.decisionId!, i)} title={o.description}>{o.label}</OrgButton>
            ))}
          </div>
        ) : null}
        {it.kind === "blocked" && replying && (
          <AskRole role={it.role} conversationId={it.conversationId} onSend={onSend} onOpenSession={onOpenSession} />
        )}
        <div className="flex items-center gap-1.5">
          {it.kind === "proposal" && <OrgButton size="sm" primary onClick={() => onPickProposal(it.proposal.short_id)} data-needs-you-open>Review the changes</OrgButton>}
          {it.kind === "blocked" && !replying && onSend && <OrgButton size="sm" primary onClick={() => setReplying(true)} data-needs-you-reply>Reply</OrgButton>}
          {conv && (
            <button type="button" onClick={() => onOpenSession(conv)} className="inline-flex items-center gap-1 text-[11.5px] h-7 px-1.5 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-needs-you-open>
              Open the thread <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- the insights column

function Insights(props: HealthBoardProps & { company: ReturnType<typeof companyFlow>; read: ReturnType<typeof chiefRead>; columns?: boolean }) {
  const { flows, company, now, health } = props;
  const days = flowDays(now);
  const listRef = useRef<HTMLDivElement>(null);
  // A click on the map opens the role's row and brings it into view.
  useWatchEffect(() => {
    if (!props.focusRoleId) return;
    listRef.current?.querySelector(`[data-flow-row="${props.focusRoleId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [props.focusRoleId]);
  const [open, setOpen] = useState<string | null>(null);
  useWatchEffect(() => { if (props.focusRoleId) setOpen(props.focusRoleId); }, [props.focusRoleId]);
  const total = flows.reduce((n, f) => n + f.wakesTotal, 0);
  const max = Math.max(1, ...flows.map((f) => f.wakesTotal));
  const summary = (
    <>
      <div className="pt-4">
        <h2 className="text-[19px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>This week</h2>
        <p className="mt-1 text-[12px]" style={{ color: "var(--sol-text-muted)" }}>
          {props.reviewing ? "A review of the company is running; its proposal lands in the strip above." : `How much work reached each role over the last seven days, what got closed, and where the load sits. ${health && Number.isFinite(health.generated_at) ? `Read ${agoOf(now - health.generated_at)}.` : ""}`}
        </p>
        {props.reviewing && props.reviewSessionId && <ReviewSessionLink id={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
        {props.reviewEnded && <div className="mt-2"><ReviewEndedLine sessionId={props.reviewSessionId} onOpenSession={props.onOpenSession} /></div>}
        <HealthNote missing={props.healthMissing} error={props.healthError} hasHealth={!!health} onRetry={props.onRetryHealth} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2" data-flow-kpis>
        <Kpi label="Work reaching roles" value={flows.reduce((n, f) => n + f.wakesTotal, 0)} series={company.wakes} days={days} tone={FLOW_TONE.reached} note="messages, routines and hand-ins that woke a role" />
        <Kpi label="Tasks closed" value={flows.reduce((n, f) => n + f.doneTotal, 0)} series={company.done} days={days} tone={FLOW_TONE.closed} note="tasks in the roles' areas marked done" />
        <Kpi label="Decisions routed" value={flows.reduce((n, f) => n + f.decisionsTotal, 0)} series={company.decisions} days={days} tone={FLOW_TONE.asked} note="questions sent to a role before reaching you" />
        <LimitTile flows={flows} stalls={company.stalls} />
      </div>
    </>
  );
  const after = (
    <>
      <Gaps health={health} />
      {props.read && <ChiefReadSection read={props.read} now={now} onPickProposal={props.onPickProposal} onTrigger={props.onTrigger} onSetEvery={props.onSetTriggerEvery} />}
    </>
  );
  const list = (
    <>
      <SectionLabel right={<span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>busiest first</span>}>Where the work goes</SectionLabel>
      <div className="flex flex-col gap-1" ref={listRef} data-flow-rows={flows.length} onMouseLeave={() => props.onHoverRole?.(null)}>
        {flows.length === 0 && <p className="text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>No roles yet.</p>}
        {flows.map((f) => (
          <FlowRow
            key={f.role._id}
            f={f}
            flows={flows}
            max={max}
            share={total > 0 ? f.wakesTotal / total : 0}
            days={days}
            open={open === f.role._id}
            focused={props.focusRoleId === f.role._id}
            onHover={() => props.onHoverRole?.(f.role._id)}
            onToggle={() => { const next = open === f.role._id ? null : f.role._id; setOpen(next); props.onFocusRole(next); }}
            board={props}
          />
        ))}
      </div>
    </>
  );
  if (props.columns) {
    return (
      <div className="grid grid-cols-[minmax(320px,5fr)_minmax(380px,7fr)] gap-8" data-health-columns>
        <div>{summary}{after}</div>
        <div>{list}</div>
      </div>
    );
  }
  return <>{summary}{list}{after}</>;
}

function Kpi({ label, value, series, days, tone, note }: { label: string; value: number; series: number[]; days: string[]; tone: string; note: string }) {
  return (
    <div className="rounded-xl border px-3 pt-2.5 pb-2" style={{ borderColor: BORDER, background: "var(--sol-card)" }} title={note} data-kpi={label}>
      <div className="text-[11px]" style={{ color: "var(--sol-text-muted)" }}>{label}</div>
      <div className="flex items-end justify-between gap-2 mt-0.5">
        <span className="text-[22px] leading-none font-semibold tabular-nums" style={{ color: "var(--sol-text)" }}>{value.toLocaleString()}</span>
        {series.some((v) => v > 0) && <DayBars values={series} days={days} tone={tone} width={92} height={28} />}
      </div>
      <div className="mt-1 text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{series.some((v) => v > 0) ? `today ${series[series.length - 1] ?? 0}` : "over the last 7 days"}</div>
    </div>
  );
}

function LimitTile({ flows, stalls }: { flows: RoleFlow[]; stalls: number }) {
  const at = flows.filter((f) => f.daysAtCap > 0);
  return (
    <div className="rounded-xl border px-3 pt-2.5 pb-2" style={{ borderColor: at.length ? `color-mix(in srgb, ${FLOW_TONE.limit} 40%, transparent)` : BORDER, background: "var(--sol-card)" }} data-kpi="limits">
      <div className="text-[11px]" style={{ color: "var(--sol-text-muted)" }}>Hit their daily limit</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="text-[22px] leading-none font-semibold tabular-nums" style={{ color: at.length ? FLOW_TONE.limit : "var(--sol-text)" }}>{at.length}</span>
        <span className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>of {flows.length} roles</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {at.slice(0, 4).map((f) => <RoleFace key={f.role._id} role={f.role} size={16} title={`${f.role.name}: ${f.daysAtCap} of 7 days at its limit`} />)}
      </div>
      <div className="mt-1 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{stalls} stuck {stalls === 1 ? "item" : "items"} to chase</div>
    </div>
  );
}

/** The week as seven bars, today last; an optional dashed line at a limit. */
export function DayBars({ values, days, tone, width, height, limit, ghost, max: fixedMax }: { values: number[]; days: string[]; tone: string; width: number; height: number; limit?: number; ghost?: number[]; max?: number }) {
  const max = fixedMax ?? Math.max(1, ...values, ...(ghost ?? []), limit ?? 0);
  const gap = 2;
  const bw = (width - gap * (values.length - 1)) / values.length;
  const y = (v: number) => height - (v / max) * height;
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" role="img" aria-label={days.map((d, i) => `${d}: ${values[i]}`).join(", ")}>
      {values.map((v, i) => {
        const x = i * (bw + gap);
        const g = ghost?.[i];
        return (
          <g key={i}>
            <title>{`${weekday(days[i])} ${days[i].slice(5)}: ${v}`}</title>
            {g !== undefined && g > 0 && <rect x={x} y={y(g)} width={bw} height={height - y(g)} rx={1.5} fill="none" stroke={tone} strokeOpacity={0.45} strokeDasharray="2 2" />}
            <rect x={x} y={v > 0 ? y(v) : height - 1} width={bw} height={v > 0 ? height - y(v) : 1} rx={1.5} fill={tone} opacity={i === values.length - 1 ? 1 : 0.62} />
          </g>
        );
      })}
      {limit !== undefined && limit <= max && <line x1={-2} x2={width + 2} y1={y(limit)} y2={y(limit)} stroke={FLOW_TONE.limit} strokeWidth={1} strokeDasharray="3 2" />}
    </svg>
  );
}

const weekday = (day: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()];

// ---- one role's week

function FlowRow({ f, flows, max, share, days, open, focused, onHover, onToggle, board }: { f: RoleFlow; flows: RoleFlow[]; max: number; share: number; days: string[]; open: boolean; focused: boolean; onHover: () => void; onToggle: () => void; board: HealthBoardProps }) {
  const perDay = f.wakesTotal / 7;
  const hot = f.daysAtCap > 0;
  return (
    <div className={cn("rounded-lg border transition-colors", open ? "bg-sol-bg-highlight/50" : focused ? "bg-sol-bg-highlight/40" : "hover:bg-sol-bg-highlight/30")} style={{ borderColor: open ? "color-mix(in srgb, var(--sol-violet) 40%, transparent)" : "transparent" }} data-flow-row={f.role._id} data-area-row={f.role.handle} onMouseEnter={onHover}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full text-left px-2.5 py-2 flex flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <RoleFace role={f.role} size={22} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{f.role.name}</span>
          <span className="shrink-0 text-[11px] font-medium" style={{ color: f.color }} data-area-status={f.status}>{f.statusWord}</span>
          {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-text-dim)" }} /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-text-dim)" }} />}
        </span>
        <span className="flex items-center gap-3 pl-[30px]">
          <span className="min-w-0 flex-1 flex flex-col gap-1">
            {/* Its share of the week, against the busiest role. */}
            <span className="block h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
              <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (f.wakesTotal / max) * 100)}%`, background: FLOW_TONE.reached }} />
            </span>
            <span className="flex items-center gap-2.5 text-[11px] tabular-nums" style={{ color: "var(--sol-text-muted)" }}>
              <span><span className="font-semibold" style={{ color: "var(--sol-text)" }}>{f.wakesTotal}</span> reached it</span>
              <span style={{ color: FLOW_TONE.closed }}>{f.doneTotal} closed</span>
              {f.decisionsTotal > 0 && <span style={{ color: FLOW_TONE.asked }}>{f.decisionsTotal} asked</span>}
              <span className="ml-auto" style={{ color: "var(--sol-text-dim)" }}>{Math.round(share * 100)}%</span>
            </span>
          </span>
          <DayBars values={f.wakes} days={days} tone={FLOW_TONE.reached} width={84} height={30} limit={f.cap} />
        </span>
        {(hot || f.stalls > 0) && (
          <span className="pl-[30px] text-[11px]" style={{ color: hot ? FLOW_TONE.limit : "var(--sol-text-dim)" }} data-flow-limit={f.daysAtCap}>
            {hot ? `At its limit of ${f.cap} a day on ${f.daysAtCap} of 7 days; about ${Math.round(perDay)} a day reach it.` : ""}
            {hot && f.stalls > 0 ? " " : ""}
            {f.stalls > 0 && <span style={{ color: "var(--sol-text-dim)" }}>{f.stalls} stuck {f.stalls === 1 ? "item" : "items"} to chase.</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="pb-1" data-flow-detail={f.role.handle}>
          <WhatIf f={f} flows={flows} days={days} board={board} />
          <AreaDetail row={f} now={board.now} onOpenSession={board.onOpenSession} onSelectNode={board.onSelectNode} onTrigger={board.onTrigger} onSetEvery={board.onSetTriggerEvery} onSend={board.onSendToRole} />
        </div>
      )}
    </div>
  );
}

// ---- what if

/**
 * Two levers a person actually has, replayed over this week: the role's
 * daily limit (applied in place, when they may edit it), and handing part of
 * its work to another role (sent to the Chief of Staff, whose proposal is
 * how the org changes). The projection says what it cannot know.
 */
function WhatIf({ f, flows, days, board }: { f: RoleFlow; flows: RoleFlow[]; days: string[]; board: HealthBoardProps }) {
  const [lever, setLever] = useState<"limit" | "move">(f.daysAtCap > 0 ? "limit" : "move");
  const [cap, setCap] = useState(f.cap);
  const others = flows.filter((o) => o.role._id !== f.role._id && o.role.status !== "paused");
  const [toId, setToId] = useState<string>(() => [...others].sort((a, b) => a.loadRatio - b.loadRatio)[0]?.role._id ?? "");
  const [share, setShare] = useState(0.3);
  const [sent, setSent] = useState(false);
  const to = others.find((o) => o.role._id === toId) ?? null;
  const capP = projectCap(f, cap);
  const moveP = to ? projectMove(f, to, share) : null;
  const canEdit = !!board.onSetLimit && (board.canEditRole?.(f.role._id) ?? true);
  const chiefConv = board.chief?.standing?.conversation_id ?? null;
  const top = Math.max(f.cap * 2, 80, ...f.wakes);
  return (
    <div className="mx-2.5 mb-2 rounded-lg border p-2.5" style={{ borderColor: BORDER, background: "var(--sol-card)" }} data-what-if={lever}>
      <div className="flex items-center gap-1 mb-2">
        <span className="text-[11.5px] font-semibold mr-1" style={{ color: "var(--sol-text)" }}>What if</span>
        {(["limit", "move"] as const).map((l) => (
          <button key={l} type="button" onClick={() => setLever(l)} aria-pressed={lever === l} className={cn("h-6 px-2 rounded-md text-[11.5px]", lever === l ? "font-medium" : "hover:bg-sol-bg-highlight")} style={lever === l ? { background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)", color: "var(--sol-violet)" } : { color: "var(--sol-text-muted)" }}>
            {l === "limit" ? "its daily limit changed" : "some of its work moved"}
          </button>
        ))}
      </div>
      {lever === "limit" ? (
        <>
          <div className="flex items-center gap-3">
            <DayBars values={f.wakes} days={days} tone={FLOW_TONE.reached} width={150} height={44} limit={cap} max={Math.max(cap, ...f.wakes, 1)} />
            <div className="min-w-0 flex-1">
              <label className="flex items-center justify-between text-[11px]" style={{ color: "var(--sol-text-muted)" }}>
                <span>Limit a day</span>
                <span className="font-semibold tabular-nums" style={{ color: "var(--sol-text)" }}>{cap}</span>
              </label>
              <input type="range" min={5} max={Math.ceil(top / 5) * 5} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="w-full accent-[var(--sol-violet)]" aria-label={`${f.role.name}'s daily limit`} data-what-if-limit />
            </div>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-what-if-says>
            {cap === f.cap
              ? `Now ${f.cap} a day. It sat at that limit on ${f.daysAtCap} of 7 days.`
              : capP.unknownDays > 0
                ? `At ${cap} a day, the ${capP.unknownDays} ${capP.unknownDays === 1 ? "day" : "days"} it sat at ${f.cap} would have gone further; held work is not counted, so whether they would reach ${cap} is unknown.`
                : `At ${cap} a day it would have sat at its limit on ${capP.daysAtCap} of 7 days${capP.heldAtLeast > 0 ? `, holding at least ${capP.heldAtLeast} pieces of work` : ""}.`}
          </p>
          {cap !== f.cap && (
            <div className="mt-2 flex items-center gap-1.5">
              {canEdit ? (
                <OrgButton size="sm" primary onClick={() => board.onSetLimit!(f.role._id, cap)} data-what-if-apply>Set its limit to {cap} a day</OrgButton>
              ) : (
                <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>Only an admin or the role's owner can change its limit.</span>
              )}
              <OrgButton size="sm" onClick={() => setCap(f.cap)}>Reset</OrgButton>
            </div>
          )}
        </>
      ) : !to || !moveP ? (
        <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>There is no other role to hand work to.</p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }}>
            <span className="tabular-nums font-semibold" style={{ color: "var(--sol-text)" }}>{Math.round(share * 100)}%</span>
            <input type="range" min={0.1} max={0.9} step={0.05} value={share} onChange={(e) => { setShare(Number(e.target.value)); setSent(false); }} className="flex-1 accent-[var(--sol-violet)]" aria-label="Share of its work to move" data-what-if-share />
            <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
            <select value={toId} onChange={(e) => { setToId(e.target.value); setSent(false); }} className="h-6 rounded border bg-transparent px-1 text-[11.5px] outline-none max-w-[140px]" style={{ borderColor: BORDER, color: "var(--sol-text-secondary)" }} aria-label="Hand it to" data-what-if-to>
              {others.map((o) => <option key={o.role._id} value={o.role._id}>{o.role.name}</option>)}
            </select>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <MoveSide f={f} after={moveP.from} days={days} atCap={moveP.fromDaysAtCap} />
            <MoveSide f={to} after={moveP.to} days={days} atCap={moveP.toDaysAtCap} />
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-what-if-says>
            About {moveP.moved} pieces of work move over the week. {f.role.name} would sit at its limit on {moveP.fromDaysAtCap} days instead of {f.daysAtCap}; {to.role.name} on {moveP.toDaysAtCap} instead of {to.daysAtCap}.
          </p>
          {chiefConv && board.onSendToRole && (
            <div className="mt-2 flex items-center gap-2">
              <OrgButton size="sm" primary disabled={sent} onClick={() => { board.onSendToRole!(chiefConv, moveAsk(f, to, moveP)); setSent(true); }} data-what-if-ask>
                <Sparkles className="w-3 h-3" /> Ask {board.chief!.name} to propose it
              </OrgButton>
              {sent && <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-what-if-sent>Sent. Its proposal lands at the top of this page.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MoveSide({ f, after, days, atCap }: { f: RoleFlow; after: number[]; days: string[]; atCap: number }) {
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: "color-mix(in srgb, var(--sol-border) 14%, transparent)" }}>
      <div className="flex items-center gap-1.5 text-[11px] truncate" style={{ color: "var(--sol-text-secondary)" }}><RoleFace role={f.role} size={14} />{f.role.name}</div>
      <div className="mt-1 flex items-end justify-between gap-1">
        <DayBars values={after} ghost={f.wakes} days={days} tone={FLOW_TONE.reached} width={96} height={32} limit={f.cap} />
        <span className="text-[10.5px] tabular-nums text-right" style={{ color: atCap > 0 ? FLOW_TONE.limit : "var(--sol-text-dim)" }}>{atCap}/7 days<br />at limit</span>
      </div>
    </div>
  );
}

// ---- gaps

/** The work no role looks after: the company half of org.health. */
function Gaps({ health }: { health: OrgHealth | null }) {
  const c = health?.company;
  if (!c) return null;
  const lines: { key: string; text: string }[] = [
    ...c.unowned_projects.map((p) => ({ key: `u:${p.id}`, text: `${p.title} has no role looking after it.` })),
    ...(c.watched_without_lead ?? []).map((p) => ({ key: `w:${p.id}`, text: `${p.title} is watched by ${p.roles.map((h) => `@${h}`).join(", ")} with no lead named.` })),
    ...(c.unfiled_tasks > 0 ? [{ key: "unfiled", text: `${c.unfiled_tasks} open ${c.unfiled_tasks === 1 ? "task is" : "tasks are"} filed under no project or plan.` }] : []),
    ...c.plans_without_goal.slice(0, 3).map((p) => ({ key: `g:${p.id}`, text: `${p.title} has no goal on record.` })),
  ];
  if (lines.length === 0) return null;
  return (
    <>
      <SectionLabel right={<span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{lines.length}</span>}>Work nobody owns</SectionLabel>
      <ul className="flex flex-col gap-1" data-flow-gaps={lines.length}>
        {lines.slice(0, 6).map((l) => (
          <li key={l.key} className="flex items-start gap-2 text-[12px] leading-snug" style={{ color: "var(--sol-text-secondary)" }}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-[6px]" style={{ background: FLOW_TONE.limit }} />{l.text}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- the map's key

function MapLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute left-3 top-3 z-10 rounded-lg border text-[10.5px]" style={{ borderColor: BORDER, background: "color-mix(in srgb, var(--sol-bg) 88%, transparent)", color: "var(--sol-text-muted)", backdropFilter: "blur(6px)" }} data-flow-legend={open ? "open" : "closed"}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="h-7 px-2.5 inline-flex items-center gap-1.5 font-semibold text-[11px]" style={{ color: "var(--sol-text)" }} aria-expanded={open}>
        <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={FLOW_TONE.reached} strokeWidth="3" strokeLinecap="round" /></svg>
        Work flowing this week
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="px-2.5 pb-2 flex flex-col gap-1">
          <span className="flex items-center gap-1.5"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke={FLOW_TONE.reached} strokeWidth="4" strokeLinecap="round" /></svg>thicker line, more work reached the role</span>
          <span className="flex items-center gap-1.5"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke="var(--sol-violet)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>one role handing work to another</span>
          <span className="flex items-center gap-1.5"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" stroke={FLOW_TONE.limit} strokeWidth="3" strokeLinecap="round" /></svg>a role that hit its daily limit</span>
          <span style={{ color: "var(--sol-text-dim)" }}>Click a role to see its week.</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the chief's column

function ChiefColumn({ chief, open, onToggle, onOpenSession, onResume }: { chief: OrgRole | null; open: boolean; onToggle: () => void; onOpenSession: (id: string) => void; onResume?: (roleId: string) => void }) {
  if (!chief) return null;
  const conv = chief.standing?.conversation_id ?? null;
  if (!open) {
    return (
      <button type="button" onClick={onToggle} className="shrink-0 w-11 border-l flex flex-col items-center gap-3 pt-3 hover:bg-sol-bg-highlight/40" style={{ borderColor: BORDER }} title={`Talk to ${chief.name}`} data-chief-column="closed">
        <PanelRightOpen className="w-4 h-4" style={{ color: "var(--sol-text-dim)" }} />
        <RoleFace role={chief} size={24} />
        <span className="text-[11px] font-medium [writing-mode:vertical-rl] rotate-180" style={{ color: "var(--sol-text-muted)" }}>Talk to {chief.name}</span>
      </button>
    );
  }
  return (
    <aside className="shrink-0 border-l flex flex-col min-h-0" style={{ width: CHIEF_W, borderColor: BORDER, background: "color-mix(in srgb, var(--sol-bg-alt) 40%, var(--sol-bg))" }} data-chief-column="open">
      <div className="shrink-0 h-12 px-3 flex items-center gap-2.5 border-b" style={{ borderColor: BORDER }}>
        <RoleFace role={chief} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold truncate" style={{ color: "var(--sol-text)" }}>{chief.name}</span>
          <span className="block text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }} title={chief.standing?.state_line ?? undefined}>{chief.standing?.state_line || "Ask about anything on this page."}</span>
        </span>
        {conv && (
          <button type="button" onClick={() => onOpenSession(conv)} className="shrink-0 inline-flex items-center gap-1 text-[11px] h-7 px-1.5 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} title="Open the full thread">
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        <button type="button" onClick={onToggle} className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} title="Hide the conversation" data-chief-column-close>
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Composer chief={chief} onOpenSession={onOpenSession} onResume={onResume} fill />
      </div>
    </aside>
  );
}
