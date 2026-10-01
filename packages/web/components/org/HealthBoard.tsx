"use client";
// The health page (org-staffing.md S29, as a page): the org chart in its
// health mode, where each role card carries its week (how much work reached
// it against how much it closed, and what needs a person) and each line
// carries the work flowing to it. What waits on the person runs as one row
// above the chart; a role opens in a drawer under the chart with its week,
// what is stuck, and the two levers a person has; the Chief of Staff's
// conversation is its own column. Every number comes from orgFlow.ts over
// org.health; this file computes none.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRightLeft, ExternalLink, MessageSquareText, PanelRightClose, PanelRightOpen, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { agoOf } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { OrgButton } from "./OrgButton";
import { RoleFace } from "./RoleFace";
import { AreaDetail, AskRole, Composer, HealthNote, ReviewEndedLine, ReviewSessionLink } from "./StaffingPane";
import { needsYou, type NeedsYouItem } from "./staffingModel";
import { companyFlow, flowDays, moveAsk, projectCap, projectMove, type RoleFlow } from "./orgFlow";
import { DayBars, FLOW_TONE, InOutBars, RoleWeekBody } from "./orgFlowViz";
import type { QueueItem } from "../../lib/decisionQueue";
import type { OrgHealth, OrgProposalRow } from "./orgStaffingTypes";
import type { OrgRole, OrgTree } from "./orgTypes";

export type HealthBoardProps = {
  tree: OrgTree | null;
  health: OrgHealth | null;
  /** Each role's week (orgFlow.roleFlows), read once by the page for the map and the drawer. */
  flows: RoleFlow[];
  healthMissing?: boolean;
  healthError?: string;
  onRetryHealth?: () => void;
  proposals: OrgProposalRow[];
  queue: QueueItem[];
  chief: OrgRole | null;
  now: number;
  /** The chart in its health mode; the page owns it so selection and the fit stay its own. */
  map: ReactNode;
  phone?: boolean;
  /** The role open in the drawer (a click on its card). */
  focusRoleId: string | null;
  onFocusRole: (roleId: string | null) => void;
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
const CHIEF_W = 400;
/** The drawer's share of the map's height; the page hands the same number to the chart's fit. */
export const HEALTH_DRAWER_FRACTION = 0.5;

export function HealthBoard(props: HealthBoardProps) {
  const { tree, health, now, flows } = props;
  const days = flowDays(now);
  const items = useMemo(() => needsYou(tree, health, props.queue, props.proposals, null), [tree, health, props.queue, props.proposals]);
  const open = flows.find((f) => f.role._id === props.focusRoleId) ?? null;
  // The board measures itself before the first paint: beside the app's own
  // sidebars the page can be 1100px or 2400px, and the chart must keep room.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.phone]);
  const [chatChoice, setChatOpen] = useState<boolean | null>(null);
  const chatOpen = chatChoice ?? (width === 0 || width >= 1260);
  const notes = (
    <>
      {props.reviewing && props.reviewSessionId && <ReviewSessionLink id={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
      {props.reviewEnded && <ReviewEndedLine sessionId={props.reviewSessionId} onOpenSession={props.onOpenSession} />}
      <HealthNote missing={props.healthMissing} error={props.healthError} hasHealth={!!health} onRetry={props.onRetryHealth} />
    </>
  );
  if (props.phone) {
    return (
      <div className="h-full overflow-y-auto px-4 pb-10" data-health-page="phone">
        <WaitingRow items={items} now={now} onAnswer={props.onAnswerDecision} onOpenSession={props.onOpenSession} onPickProposal={props.onPickProposal} onSend={props.onSendToRole} stacked />
        {notes}
        <WeekLine flows={flows} days={days} />
        <div className="mt-3 flex flex-col gap-2">
          {flows.map((f) => (
            <div key={f.role._id} className="rounded-xl border" style={{ borderColor: BORDER, borderTop: `3px solid ${f.color}`, background: "var(--sol-card)" }}>
              <button type="button" className="w-full text-left p-3" onClick={() => props.onFocusRole(open?.role._id === f.role._id ? null : f.role._id)} data-flow-row={f.role._id}>
                <RoleWeekBody f={f} days={days} />
              </button>
              {open?.role._id === f.role._id && <DrawerBody f={f} board={props} days={days} stacked />}
            </div>
          ))}
        </div>
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
        <WaitingRow items={items} now={now} onAnswer={props.onAnswerDecision} onOpenSession={props.onOpenSession} onPickProposal={props.onPickProposal} onSend={props.onSendToRole} />
        <div className="relative flex-1 min-h-0" data-health-map>
          {props.map}
          <div className="absolute left-3 top-3 z-10 max-w-[min(560px,calc(100%-24px))] flex flex-col gap-1.5">
            <WeekLine flows={flows} days={days} overlay />
            {notes}
          </div>
          {open && (
            <section className="absolute inset-x-0 bottom-0 z-20 border-t flex flex-col org-sheet-in" style={{ height: `${HEALTH_DRAWER_FRACTION * 100}%`, borderColor: BORDER, background: "var(--sol-bg)", boxShadow: "0 -12px 40px -16px rgba(0,0,0,0.5)" }} data-health-drawer={open.role.handle}>
              <DrawerHeader f={open} onClose={() => props.onFocusRole(null)} />
              <div className="flex-1 min-h-0 overflow-y-auto"><DrawerBody f={open} board={props} days={days} /></div>
            </section>
          )}
        </div>
      </div>
      <ChiefColumn chief={props.chief} open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} onOpenSession={props.onOpenSession} onResume={props.onResumeChief} />
    </div>
  );
}

// ---------------------------------------------------------------- the week, in one line

/** The company's week over the chart: work in against work closed, and the
 *  roles that need a look. One line, so the chart stays the picture. */
function WeekLine({ flows, days, overlay }: { flows: RoleFlow[]; days: string[]; overlay?: boolean }) {
  const c = companyFlow(flows);
  const inn = flows.reduce((n, f) => n + f.wakesTotal, 0);
  const closed = flows.reduce((n, f) => n + f.doneTotal, 0);
  const atLimit = flows.filter((f) => f.daysAtCap > 0).length;
  return (
    <div className={cn("inline-flex items-center gap-3 rounded-lg text-[12px] tabular-nums", overlay ? "border px-3 h-10 self-start" : "mt-3")} style={overlay ? { borderColor: BORDER, background: "color-mix(in srgb, var(--sol-bg) 88%, transparent)", backdropFilter: "blur(6px)" } : undefined} data-week-line>
      <span className="font-semibold" style={{ color: "var(--sol-text)" }}>This week</span>
      <span><span className="font-semibold" style={{ color: FLOW_TONE.reached }}>{inn.toLocaleString()}</span> <span style={{ color: "var(--sol-text-dim)" }}>in</span></span>
      <span style={{ color: "var(--sol-text-dim)" }}>→</span>
      <span><span className="font-semibold" style={{ color: FLOW_TONE.closed }}>{closed.toLocaleString()}</span> <span style={{ color: "var(--sol-text-dim)" }}>closed</span></span>
      <InOutBars inn={c.wakes} out={c.done} days={days} width={70} height={20} />
      {c.stalls > 0 && <span style={{ color: "var(--sol-yellow)" }}>{c.stalls} stuck</span>}
      {atLimit > 0 && <span style={{ color: FLOW_TONE.limit }}>{atLimit} at their limit</span>}
    </div>
  );
}

// ---------------------------------------------------------------- waiting on you

const ASK_KIND: Record<NeedsYouItem["kind"], { word: string; tone: string; hint: string }> = {
  decision: { word: "Decision", tone: "var(--sol-violet)", hint: "A question only you can answer." },
  blocked: { word: "Blocked on you", tone: "var(--sol-orange)", hint: "The role stopped and is waiting for your word in its thread." },
  proposal: { word: "Org change", tone: "var(--sol-blue)", hint: "Changes to the org chart, proposed for your verdict." },
};

/** What waits on the person, one compact card each, in one row above the
 *  chart: the kind, who asks, the ask on one line, and the one thing to do. */
function WaitingRow({ items, now, onAnswer, onOpenSession, onPickProposal, onSend, stacked }: { items: NeedsYouItem[]; now: number; onAnswer?: (decisionId: string, index: number) => void; onOpenSession: (id: string) => void; onPickProposal: (shortId: string) => void; onSend?: (conversationId: string, text: string) => void; stacked?: boolean }) {
  return (
    <section className={cn("shrink-0", stacked ? "pt-3" : "border-b px-4 sm:px-6 py-2.5")} style={{ borderColor: BORDER }} data-needs-you={items.length || "empty"}>
      <div className={cn("flex gap-2", stacked ? "flex-col" : "items-stretch overflow-x-auto -mx-1 px-1 pb-0.5 snap-x")}>
        <div className="shrink-0 flex flex-col justify-center pr-2">
          <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: items.length ? "var(--sol-text)" : "var(--sol-text-muted)" }}>{items.length === 0 ? "Nothing is waiting on you" : `${items.length} waiting on you`}</span>
        </div>
        {items.map((it) => <WaitingCard key={it.key} it={it} now={now} onAnswer={onAnswer} onOpenSession={onOpenSession} onPickProposal={onPickProposal} onSend={onSend} wide={stacked} />)}
      </div>
    </section>
  );
}

function WaitingCard({ it, now, onAnswer, onOpenSession, onPickProposal, onSend, wide }: { it: NeedsYouItem; now: number; onAnswer?: (decisionId: string, index: number) => void; onOpenSession: (id: string) => void; onPickProposal: (shortId: string) => void; onSend?: (conversationId: string, text: string) => void; wide?: boolean }) {
  const k = ASK_KIND[it.kind];
  const [replying, setReplying] = useState(false);
  const who = it.kind === "proposal" ? (it.proposal.author.name ?? "A proposal") : it.role?.name ?? "A session";
  const at = it.kind === "decision" ? it.item.createdAt : it.kind === "blocked" ? it.role.standing?.state_at ?? null : it.proposal.created_at;
  // A role's pinned line often opens with its own name, which the card already says.
  const ownName = it.kind === "blocked" ? `${it.role.name}:` : "";
  const body = it.kind === "decision" ? it.item.question : it.kind === "blocked" ? (it.line.toLowerCase().startsWith(ownName.toLowerCase()) ? it.line.slice(ownName.length).trim() : it.line) : `${it.proposal.title} (${it.remaining === 1 ? "1 change" : `${it.remaining} changes`} to decide)`;
  const conv = it.kind === "decision" ? it.item.conversationId : it.kind === "blocked" ? it.conversationId : null;
  return (
    <article className={cn("snap-start shrink-0 rounded-lg border px-2.5 py-1.5 flex flex-col gap-1", wide ? "w-full" : "w-[340px]")} style={{ borderColor: `color-mix(in srgb, ${k.tone} 30%, transparent)`, background: "var(--sol-card)", boxShadow: `inset 3px 0 0 ${k.tone}` }} data-needs-you-item={it.kind}>
      <div className="flex items-center gap-1.5 text-[11.5px]">
        {it.kind !== "proposal" && it.role ? <RoleFace role={it.role} size={16} /> : <Sparkles className="w-3.5 h-3.5" style={{ color: k.tone }} />}
        <span className="min-w-0 truncate font-medium" style={{ color: "var(--sol-text-secondary)" }}>{who}</span>
        <span className="shrink-0" style={{ color: k.tone }} title={k.hint}>· {k.word.toLowerCase()}</span>
        {at ? <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{agoOf(now - at).replace(/ ago$/, "")}</span> : null}
      </div>
      <p className="text-[12.5px] leading-snug truncate" style={{ color: "var(--sol-text)" }} title={body}>{body}</p>
      {it.kind === "decision" && it.canAnswerInPlace && onAnswer && (
        <div className="flex flex-wrap gap-1" data-needs-you-options>
          {it.item.options.map((o, i) => <OrgButton key={i} size="sm" primary={it.item.defaultOption === i} onClick={() => onAnswer(it.item.decisionId!, i)} title={o.description}>{o.label}</OrgButton>)}
        </div>
      )}
      {it.kind === "blocked" && replying && <AskRole role={it.role} conversationId={it.conversationId} onSend={onSend} onOpenSession={onOpenSession} />}
      <div className="flex items-center gap-1">
        {it.kind === "proposal" && <OrgButton size="sm" primary onClick={() => onPickProposal(it.proposal.short_id)} data-needs-you-open>Review the changes</OrgButton>}
        {it.kind === "blocked" && !replying && onSend && <OrgButton size="sm" primary onClick={() => setReplying(true)} data-needs-you-reply>Reply</OrgButton>}
        {conv && (
          <button type="button" onClick={() => onOpenSession(conv)} className="inline-flex items-center gap-1 text-[11.5px] h-7 px-1.5 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-needs-you-open>
            Open the thread <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- one role, opened

function DrawerHeader({ f, onClose }: { f: RoleFlow; onClose: () => void }) {
  return (
    <div className="shrink-0 h-12 px-4 sm:px-6 flex items-center gap-2.5 border-b" style={{ borderColor: BORDER }}>
      <RoleFace role={f.role} size={26} />
      <span className="text-[15px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{f.role.name}</span>
      <span className="text-[11.5px] font-semibold" style={{ color: f.color }}>{f.statusWord}</span>
      <Link href={`/org/${f.role.short_id}`} className="text-[11.5px] hover:underline" style={{ color: "var(--sol-violet)" }}>its page</Link>
      <button type="button" onClick={onClose} className="ml-auto h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} aria-label="Close" data-health-drawer-close><X className="w-4 h-4" /></button>
    </div>
  );
}

/** Its week large, its own latest word, what is stuck under it, and the
 *  levers: three columns on a desktop, one under the other on a phone. */
function DrawerBody({ f, board, days, stacked }: { f: RoleFlow; board: HealthBoardProps; days: string[]; stacked?: boolean }) {
  const line = f.area?.standing;
  return (
    <div className={cn("px-4 sm:px-6 py-3 gap-6", stacked ? "flex flex-col" : "grid grid-cols-[minmax(260px,1fr)_minmax(280px,1.2fr)_minmax(300px,1.1fr)]")} data-flow-detail={f.role.handle}>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold mb-2" style={{ color: "var(--sol-text-muted)" }}>Its week</div>
        <InOutBars inn={f.wakes} out={f.done} days={days} width={stacked ? 260 : 280} height={84} limit={f.cap} />
        <div className="mt-1 flex justify-between text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)", width: stacked ? 260 : 280 }}>
          {days.map((d) => <span key={d}>{["S", "M", "T", "W", "T", "F", "S"][new Date(`${d}T00:00:00Z`).getUTCDay()]}</span>)}
        </div>
        <p className="mt-2 text-[12px] tabular-nums" style={{ color: "var(--sol-text-secondary)" }}>
          <span style={{ color: FLOW_TONE.reached }}>{f.wakesTotal} in</span> · <span style={{ color: FLOW_TONE.closed }}>{f.doneTotal} closed</span>{f.decisionsTotal > 0 ? ` · ${f.decisionsTotal} decided for you` : ""} · limit {f.cap} a day
        </p>
        {line && <p className="mt-2 text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }} title={line.project}>“{line.text}”{line.written_on && <span style={{ color: "var(--sol-text-dim)" }}> · {line.written_on.slice(5)}</span>}</p>}
      </div>
      <div className="min-w-0 -mx-2.5">
        <AreaDetail row={f} now={board.now} onOpenSession={board.onOpenSession} onSelectNode={board.onSelectNode} onTrigger={board.onTrigger} onSetEvery={board.onSetTriggerEvery} onSend={board.onSendToRole} />
      </div>
      <div className="min-w-0">
        <WhatIf f={f} flows={board.flows} days={days} board={board} />
      </div>
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
    <div className="rounded-lg border p-2.5" style={{ borderColor: BORDER, background: "var(--sol-card)" }} data-what-if={lever}>
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
