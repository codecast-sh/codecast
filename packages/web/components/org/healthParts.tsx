"use client";
// The week's small parts (cohesive build spec D12): the note for a health
// read that could not happen, a role's fix loop and its two levers (its
// daily limit, and handing part of its work to another role), and the lines
// for a review session. The map's This week, the role sheet's This week
// section and the org screen's no-head column mount from here; a role's
// week itself is RoleWeekBody (orgFlowViz), which the map's cards share.

import { useState } from "react";
import { ArrowRightLeft, ExternalLink, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { OrgButton } from "./OrgButton";
import { RoleFace } from "./RoleFace";
import { moveAsk, projectCap, projectMove, type RoleFlow } from "./orgFlow";
import { DayBars, FLOW_TONE } from "./orgFlowViz";
import type { OrgRoleHealth } from "./orgStaffingTypes";
import type { OrgRole } from "./orgTypes";

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

/** What the health read could not do: a server without it, a failed read
 *  with nothing cached, or a stale copy. Never painted as a clean company. */
export function HealthNote({ missing, error, hasHealth, onRetry }: { missing?: boolean; error?: string; hasHealth: boolean; onRetry?: () => void }) {
  const retry = onRetry ? <button type="button" onClick={onRetry} className="ml-1.5 underline underline-offset-2" style={{ color: "var(--sol-blue)" }}>Retry</button> : null;
  if (missing) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>This server does not read the company's health yet.</p>;
  if (error && !hasHealth) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-red)" }} data-health-error>Health could not be read: {error}{retry}</p>;
  if (error) return <p className="mt-2 text-[11px] px-1" style={{ color: "var(--sol-yellow)" }} data-health-stale>Showing the last copy; the latest read failed: {error}{retry}</p>;
  return null;
}

/** The fix loop under a role's week: defects its runs introduced, the
 *  promises it owns and how many are late, and hands that finished with a
 *  concern. Silent while every count is zero. */
export function FixLoopLine({ flow }: { flow: OrgRoleHealth["flow"] | undefined }) {
  if (!flow) return null;
  const bugs = flow.bugs_introduced_30d ?? 0, open = flow.promises_open ?? 0, late = flow.promises_overdue ?? 0, concerns = flow.done_with_concerns_7d ?? 0;
  if (bugs + open + concerns === 0) return null;
  return (
    <p className="mt-1 text-[12px] tabular-nums" style={{ color: "var(--sol-text-secondary)" }} data-fix-loop>
      <span style={{ color: bugs > 0 ? "var(--sol-red)" : undefined }}>{bugs} {bugs === 1 ? "bug" : "bugs"} introduced</span> <span style={{ color: "var(--sol-text-dim)" }}>30d</span>
      {" · "}<span style={{ color: late > 0 ? "var(--sol-yellow)" : undefined }}>{open} {open === 1 ? "promise" : "promises"}{late > 0 ? `, ${late} late` : ""}</span>
      {" · "}{concerns} with concerns
    </p>
  );
}

export type RoleLeversProps = {
  /** The role's week, and every role's, for the hand-over. */
  f: RoleFlow;
  flows: readonly RoleFlow[];
  days: string[];
  /** Set its daily limit in place; absent when the viewer may not edit the role. */
  onSetLimit?: (perDay: number) => void;
  /** The Head of People, whose proposal is how work moves between roles. */
  head: OrgRole | null;
  /** Send the hand-over ask into the Head of People's thread; absent when it has none. */
  onAskHead?: (text: string) => void;
};

/**
 * The two levers a person has over a role's week, replayed over this week:
 * its daily limit (applied in place, when they may edit it), and handing
 * part of its work to another role (sent to the Head of People, whose
 * proposal is how the org changes). The projection says what it cannot know.
 * Pause, resume and run now are the role's Triggers tab.
 */
export function RoleLevers({ f, flows, days, onSetLimit, head, onAskHead }: RoleLeversProps) {
  const [lever, setLever] = useState<"limit" | "move">(f.daysAtCap > 0 ? "limit" : "move");
  const [cap, setCap] = useState(f.cap);
  const others = flows.filter((o) => o.role._id !== f.role._id && o.role.status !== "paused");
  const [toId, setToId] = useState<string>(() => [...others].sort((a, b) => a.loadRatio - b.loadRatio)[0]?.role._id ?? "");
  const [share, setShare] = useState(0.3);
  const [sent, setSent] = useState(false);
  const to = others.find((o) => o.role._id === toId) ?? null;
  const capP = projectCap(f, cap);
  const moveP = to ? projectMove(f, to, share) : null;
  const top = Math.max(f.cap * 2, 80, ...f.wakes);
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: BORDER, background: "var(--sol-card)" }} data-what-if={lever}>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        <span className="text-[11.5px] font-semibold mr-1" style={{ color: "var(--sol-text)" }}>What if</span>
        {(["limit", "move"] as const).map((l) => (
          <button key={l} type="button" onClick={() => setLever(l)} aria-pressed={lever === l} className={cn("h-6 px-2 rounded-md text-[11.5px]", lever === l ? "font-medium" : "hover:bg-sol-bg-highlight")} style={lever === l ? { background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)", color: "var(--sol-violet)" } : { color: "var(--sol-text-muted)" }} data-what-if-pick={l}>
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
              {onSetLimit ? (
                <OrgButton size="sm" primary onClick={() => onSetLimit(cap)} data-what-if-apply>Set its limit to {cap} a day</OrgButton>
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
            <input type="range" min={0.1} max={0.9} step={0.05} value={share} onChange={(e) => { setShare(Number(e.target.value)); setSent(false); }} className="min-w-0 flex-1 accent-[var(--sol-violet)]" aria-label="Share of its work to move" data-what-if-share />
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
          {head && onAskHead && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <OrgButton size="sm" primary disabled={sent} onClick={() => { onAskHead(moveAsk(f, to, moveP)); setSent(true); }} data-what-if-ask>
                <Sparkles className="w-3 h-3" /> Ask {head.name} to propose it
              </OrgButton>
              {sent && <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-what-if-sent>Sent. The proposal waits for you above the conversation.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MoveSide({ f, after, days, atCap }: { f: RoleFlow; after: number[]; days: string[]; atCap: number }) {
  return (
    <div className="min-w-0 rounded-md px-2 py-1.5" style={{ background: "color-mix(in srgb, var(--sol-border) 14%, transparent)" }}>
      <div className="flex items-center gap-1.5 text-[11px] truncate" style={{ color: "var(--sol-text-secondary)" }}><RoleFace role={f.role} size={14} />{f.role.name}</div>
      <div className="mt-1 flex items-end justify-between gap-1">
        <DayBars values={after} ghost={f.wakes} days={days} tone={FLOW_TONE.reached} width={96} height={32} limit={f.cap} />
        <span className="text-[10.5px] tabular-nums text-right" style={{ color: atCap > 0 ? FLOW_TONE.limit : "var(--sol-text-dim)" }}>{atCap}/7 days<br />at limit</span>
      </div>
    </div>
  );
}

/** A review that stopped with nothing posted: said plainly, with the way in
 *  to see why, above the buttons that start another. */
export function ReviewEndedLine({ sessionId, onOpenSession }: { sessionId?: string | null; onOpenSession: (id: string) => void }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2 flex-wrap" data-review-ended style={{ borderColor: "color-mix(in srgb, var(--sol-orange) 45%, transparent)", background: "color-mix(in srgb, var(--sol-orange) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
      <span className="min-w-0 flex-1">The review stopped without making a proposal.</span>
      {sessionId && <button type="button" onClick={() => onOpenSession(sessionId)} className="shrink-0 inline-flex items-center gap-1 hover:underline" style={{ color: "var(--sol-violet)" }}>See why <ExternalLink className="w-3 h-3" /></button>}
    </div>
  );
}

/** The session "Propose an org now" started: a way in while it works, and
 *  the way to see why nothing landed if the review ends without a proposal. */
export function ReviewSessionLink({ id, onOpenSession }: { id: string; onOpenSession: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpenSession(id)} className="mt-2 inline-flex items-center gap-1 text-[11.5px] px-1.5 h-6 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-review-session>
      Open the review <ExternalLink className="w-3 h-3" />
    </button>
  );
}
