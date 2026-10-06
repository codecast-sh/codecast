"use client";
// The health surface's small parts (org-staffing.md S29): the note for a
// health read that could not happen, a role's check line, the ask into a
// role's thread, an opened area row, and the lines for a review session.
// HealthBoard and the org screen's no-head column mount from here.

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Pause, Play, RefreshCw, Send } from "lucide-react";
import { agoOf } from "../../lib/threadState";
import { MetricReadingLine } from "../initiatives/InitiativeAtoms";
import { OrgButton } from "./OrgButton";
import { SEVERITY_META } from "./orgMeta";
import { reachedBreakdown, reachedTotal, type AreaCheck } from "@codecast/shared/contracts/orgAreas";
import type { OrgRole } from "./orgTypes";
import { CHECK_CADENCES, cadenceLabel, type AreaRow } from "./staffingModel";
export { StatusPill } from "./ghostChrome";

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

function IconButton({ label, tone, onClick, children }: { label: string; tone?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: tone ?? "var(--sol-text-dim)" }}>
      {children}
    </button>
  );
}

/** What the health read could not do: a server without it, a failed read
 *  with nothing cached, or a stale copy. Never painted as a clean company. */
export function HealthNote({ missing, error, hasHealth, onRetry }: { missing?: boolean; error?: string; hasHealth: boolean; onRetry?: () => void }) {
  const retry = onRetry ? <button type="button" onClick={onRetry} className="ml-1.5 underline underline-offset-2" style={{ color: "var(--sol-blue)" }}>Retry</button> : null;
  if (missing) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-text-dim)" }}>This server does not read the company's health yet.</p>;
  if (error && !hasHealth) return <p className="mt-2 text-[12px] px-1" style={{ color: "var(--sol-red)" }} data-health-error>Health could not be read: {error}{retry}</p>;
  if (error) return <p className="mt-2 text-[11px] px-1" style={{ color: "var(--sol-yellow)" }} data-health-stale>Showing the last copy; the latest read failed: {error}{retry}</p>;
  return null;
}

const ago = (now: number, at: number | null | undefined): string => (at ? agoOf(now - at) : "");

/** The role's check (or the company review) as a person controls it: when
 *  it last looked, when it looks next, pause and run now, and the cadence. */
export function CheckLine({ check, checkedAt, now, word, onTrigger, onSetEvery }: { check: AreaCheck | null; checkedAt: number | null; now: number; word: "check" | "review"; onTrigger?: (id: string, verb: "pause" | "resume" | "runNow") => void; onSetEvery?: (id: string, ms: number) => void }) {
  const paused = check?.status === "paused";
  const live = !!check && (check.status === "scheduled" || check.status === "running" || paused);
  const last = checkedAt ?? check?.last_run_at ?? null;
  const cadences = check?.interval_ms && !CHECK_CADENCES.some((c) => c.ms === check.interval_ms) ? [{ ms: check.interval_ms, label: cadenceLabel(check.interval_ms) }, ...CHECK_CADENCES] : CHECK_CADENCES;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" data-area-check={check?.status ?? "none"} style={{ color: "var(--sol-text-muted)" }}>
      <span>{last ? `Last ${word} ${ago(now, last)}` : `No ${word} yet`}</span>
      {live && !paused && check.run_at && <span style={{ color: "var(--sol-text-dim)" }}>· next {check.run_at > now ? `in ${agoOf(check.run_at - now).replace(/ ago$/, "")}` : "any moment"}</span>}
      {paused && <span style={{ color: "var(--sol-yellow)" }}>· paused</span>}
      {!live && check && <span style={{ color: "var(--sol-text-dim)" }}>· {check.status}</span>}
      {live && onSetEvery && (
        <select value={check.interval_ms ?? ""} onChange={(e) => onSetEvery(check.trigger_id, Number(e.target.value))} className="h-5 rounded border bg-transparent px-1 text-[11px] outline-none" style={{ borderColor: BORDER, color: "var(--sol-text-secondary)" }} aria-label={`How often it ${word === "check" ? "checks" : "reviews"}`} data-area-cadence>
          {cadences.map((c) => <option key={c.ms} value={c.ms}>{c.label}</option>)}
        </select>
      )}
      {live && onTrigger && (
        <span className="ml-auto inline-flex items-center gap-0.5">
          <IconButton label={paused ? "Resume" : "Pause"} onClick={() => onTrigger(check.trigger_id, paused ? "resume" : "pause")}>{paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}</IconButton>
          {!paused && <IconButton label={word === "check" ? "Check now" : "Review now"} tone="var(--sol-violet)" onClick={() => onTrigger(check.trigger_id, "runNow")}><RefreshCw className="w-3 h-3" /></IconButton>}
        </span>
      )}
      {check?.short_id && <Link href={`/triggers/${check.short_id}`} className="text-[10.5px] hover:underline" style={{ color: "var(--sol-text-dim)" }} data-area-check-link>change</Link>}
    </div>
  );
}

/** "Ask @growth": one line into the role's own thread; the answer lands there. */
export function AskRole({ role, conversationId, onSend, onOpenSession }: { role: OrgRole; conversationId: string | null; onSend?: (conversationId: string, text: string) => void; onOpenSession: (id: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  if (!conversationId) return <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>It has no session yet, so there is nobody to ask.</p>;
  const submit = () => {
    const body = text.trim();
    if (!body || !onSend) return;
    onSend(conversationId, body);
    setText("");
    setSent(true);
  };
  return (
    <form className="flex flex-col gap-1" data-ask-role={role.handle} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="flex items-center gap-1.5">
        <input value={text} onChange={(e) => { setText(e.target.value); setSent(false); }} placeholder={`Ask @${role.handle}…`} className="min-w-0 flex-1 h-7 rounded-md px-2 border outline-none text-[12px] bg-sol-bg-alt" style={{ borderColor: BORDER, color: "var(--sol-text)" }} aria-label={`Ask @${role.handle}`} />
        <OrgButton size="sm" primary type="submit" disabled={!text.trim() || !onSend} aria-label="Send"><Send className="w-3 h-3" /></OrgButton>
      </div>
      {sent && (
        <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-ask-role-sent>
          Sent. Its answer lands in <button type="button" onClick={() => onOpenSession(conversationId)} className="hover:underline" style={{ color: "var(--sol-violet)" }}>its thread</button>.
        </span>
      )}
    </form>
  );
}

const DETAIL_LABEL = "text-[10px] font-semibold uppercase tracking-[0.08em]";

/** A row opened: the area's goals and progress, the sessions waiting under
 *  it, at most three signals, its check, and a line to the role. */
export function AreaDetail({ row, now, onOpenSession, onSelectNode, onTrigger, onSetEvery, onSend }: { row: AreaRow; now: number; onOpenSession: (id: string) => void; onSelectNode: (nodeId: string) => void; onTrigger?: (id: string, verb: "pause" | "resume" | "runNow") => void; onSetEvery?: (id: string, ms: number) => void; onSend?: (conversationId: string, text: string) => void }) {
  const a = row.area;
  const conv = a?.standing_conversation_id ?? row.role.standing?.conversation_id ?? null;
  const goals = a?.goals ?? [];
  const scopeProjects = row.role.scope_names.projects;
  return (
    <div className="px-2.5 pb-2.5 pt-1 flex flex-col gap-2.5 org-pop-in" data-area-detail={row.role.handle}>
      {a && row.status !== "on_track" && <p className="text-[12px] leading-snug" style={{ color: row.color }} data-area-status-line>{a.status_line}</p>}
      {a?.reached && reachedTotal(a.reached) > 0 && (
        <p className="text-[11px] leading-snug" style={{ color: "var(--sol-text-dim)" }} data-area-reached={reachedTotal(a.reached)}>
          {reachedTotal(a.reached)} session{reachedTotal(a.reached) === 1 ? "" : "s"} under it: {reachedBreakdown(a.reached)}.
        </p>
      )}

      <div data-area-goals>
        <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Goals</div>
        {goals.length === 0 && scopeProjects.length === 0 && <p className="text-[12px] mt-0.5" style={{ color: "var(--sol-text-dim)" }}>{row.role.handle === "head-of-people" ? "Everything no other role looks after." : "No area of its own: it runs its check and answers what it is asked."}</p>}
        {goals.length === 0 && scopeProjects.length > 0 && <p className="text-[12px] mt-0.5" style={{ color: "var(--sol-text-secondary)" }}>{scopeProjects.map((p) => p.title).join(", ")}</p>}
        {goals.map((g) => (
          <div key={g.project.id} className="mt-0.5 text-[12px] leading-snug" data-area-goal={g.project.id}>
            <Link href={`/projects/${g.project.short_id ?? g.project.id}`} className="font-medium no-underline hover:underline" style={{ color: "var(--sol-text)" }}>{g.project.title}</Link>
            {g.goal && <span style={{ color: "var(--sol-text-secondary)" }}>: {g.goal}</span>}
            <span className="block text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{g.done_7d} done this week · {g.in_progress} in progress · {g.open} open</span>
          </div>
        ))}
      </div>

      {a && (a.initiatives?.length ?? 0) > 0 && (
        <div data-area-initiatives={a.initiatives!.length}>
          <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Serves</div>
          {a.initiatives!.map((i) => (
            <div key={i.id} className="mt-0.5 text-[12px] leading-snug" data-area-initiative={i.short_id} data-area-initiative-owned={i.owned || undefined}>
              <Link href={`/goals/${i.short_id}`} className="font-medium no-underline hover:underline" style={{ color: "var(--sol-text)" }}>{i.title}</Link>
              {i.chain.length > 0 && <span style={{ color: "var(--sol-text-dim)" }}> under {i.chain.map((c) => c.title).join(", under ")}</span>}
              {i.metrics.map((m) => <MetricReadingLine key={m.key} reading={m} now={now} className="block mt-0.5 text-[11px]" />)}
            </div>
          ))}
        </div>
      )}

      {a && a.waiting.length > 0 && (
        <div data-area-waiting={a.waiting.length}>
          <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Waiting under it</div>
          {a.waiting.map((w) => (
            <button key={w.id} type="button" onClick={() => onOpenSession(w.id)} className="mt-0.5 w-full text-left rounded-md px-1 -mx-1 py-0.5 hover:bg-sol-bg-highlight/70" data-area-waiting-session={w.short_id}>
              <span className="block text-[12px] leading-snug truncate" style={{ color: "var(--sol-text)" }}>{w.title || w.short_id}</span>
              <span className="block text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }}>{w.why === "blocked" ? "blocked" : "waiting"} for {agoOf(now - w.since).replace(/ ago$/, "")}{w.state ? ` · ${w.state}` : ""}</span>
            </button>
          ))}
        </div>
      )}

      {a && a.signals.length > 0 && (
        <div data-area-signals={a.signals.length}>
          <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Signals</div>
          {a.signals.map((sg, i) => {
            const m = SEVERITY_META[sg.severity];
            return (
              <p key={i} className="mt-0.5 flex items-start gap-1.5 text-[12px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-area-signal={sg.code}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-[6px]" aria-hidden style={m.dot === "none" ? { border: `1px solid ${m.color}` } : m.dot === "filled" ? { background: m.color } : { border: `1.5px solid ${m.color}` }} />
                <span>{sg.text}</span>
              </p>
            );
          })}
        </div>
      )}

      <div>
        <div className={DETAIL_LABEL} style={{ color: "var(--sol-text-dim)" }}>Check</div>
        <div className="mt-0.5"><CheckLine check={a?.check ?? null} checkedAt={a?.checked_at ?? null} now={now} word="check" onTrigger={onTrigger} onSetEvery={onSetEvery} /></div>
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><AskRole role={row.role} conversationId={conv} onSend={onSend} onOpenSession={onOpenSession} /></div>
        <button type="button" onClick={() => onSelectNode(row.nodeId)} className="shrink-0 text-[11px] h-7 px-1.5 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} data-area-open-node>On the chart</button>
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
