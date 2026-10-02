// A trigger run as the conversation draws it (org-staffing.md S25): the
// scheduled-task frame an inject run arrives in, the prompt header a spawned
// run opens with, and a role's run with its card, folded to one line.
import { useState } from "react";
import { ChevronDown, ChevronRight, CornerDownLeft, Zap } from "lucide-react";
import { WORKER_SETTLE_WORDS, parseScheduledTask, roleCardInitiativeLine, withoutStashedRunNote, type ScheduledTaskFrame, type WaitingSession } from "@codecast/shared/contracts";
import { AREA_STATUS_WORDS } from "@codecast/shared/contracts/orgAreas";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { fmtDuration } from "../../triggerCadence";
import { CollapsibleBody } from "../../CollapsibleBody";
import { EntityIdPill } from "../../EntityIdPill";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE } from "../../messageMarkdown";
import { parseSpawnedTaskPrompt } from "../../sessionMessage";
import { cleanStickyContent } from "../classify";
import { formatFullTimestamp, formatRelativeTime } from "../../../lib/conversationFormat";
import { MD_COMPONENTS_NO_IMG } from "../../../lib/conversationMarkdown";
import { ReactMarkdown } from "../markdown";

// Renders BOTH scheduled-run delivery formats: the `<scheduled-task>` wrapper an
// inject-type schedule drops into an existing conversation, and the plain-text
// prompt header (taskScheduler.buildPrompt) that opens a spawned run's transcript.
// Same block so the two paths read identically; the spawned format additionally
// carries mode, prior-run outcome, and completion-protocol boilerplate (collapsed —
// it's machine plumbing, not something the user should wade through).
function FoldToggle({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors">
      {open ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
      {label}
    </button>
  );
}

/** Why a session waits, in the reader's words, by the kind the run names. */
const WAITING_WORDS: Record<string, string> = {
  blocked: "is blocked",
  decision: "asks for a decision",
  waiting: "is waiting on an answer",
  awaiting_input: "asked a question",
  permission_blocked: "waits on a permission",
  stopped: "has stopped",
  unresponsive: "is not responding",
};

/** Why a session waits and for how long, in words: "is blocked for 9m". */
function waitingWords(w: WaitingSession, firedAt: number): string {
  const why = WAITING_WORDS[w.why] ?? `is waiting (${w.why.replace(/_/g, " ")})`;
  return w.since > 0 && firedAt > w.since ? `${why} for ${fmtDuration(firedAt - w.since)}` : why;
}

/** The session a trigger fired for (org-staffing.md S28): which one waits,
 *  why, since when, and the first line of what it pinned. */
function WaitingSessionLine({ waiting: w, firedAt, words, wordsClass = "text-sol-text-muted" }: { waiting: WaitingSession; firedAt: number; words?: string; wordsClass?: string }) {
  return (
    <div className="mx-3 mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]" data-waiting-session={w.short_id}>
      <EntityIdPill shortId={w.short_id} compact />
      {w.role && <span className="text-sol-text-dim">@{w.role}</span>}
      <span className={wordsClass} title={w.since ? formatFullTimestamp(w.since) : undefined}>{words ?? waitingWords(w, firedAt)}</span>
      {w.state && <span className="basis-full truncate text-sol-text" title={w.state}>{w.state}</span>}
    </div>
  );
}

/** A role's trigger run (org-staffing.md S25, S28): one line at rest (the
 *  trigger, and the session that woke it when one did), opening inline to the
 *  role card the run reminded the role of, the waiting session's state and
 *  the trigger's prompt. The trigger pill opens the trigger, where the person
 *  edits, pauses or cancels it. */
/** The change the area watch fired for (org-staffing.md S29), in a few words on the closed line. */
function changeWords(c: NonNullable<ScheduledTaskFrame["change"]>): string {
  if (c.kind === "unowned_project") return `"${c.project_title}" has no owner`;
  return `@${c.role_handle} has read ${AREA_STATUS_WORDS[c.to]} at two checks in a row`;
}

function RoleWakeBlock({ frame, timestamp }: { frame: ScheduledTaskFrame; timestamp: number }) {
  const [open, setOpen] = useState(false);
  const role = frame.role!;
  const w = frame.waiting;
  const c = frame.change ?? null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const prompt = withoutStashedRunNote(frame.body);
  return (
    <div className="mb-3 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5" data-role-wake={role.handle} data-open={open || undefined}>
      <div role="button" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }} className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5" title={open ? "Hide what woke it" : "Show what woke it"}>
        <Zap className="w-3.5 h-3.5 shrink-0 text-sol-violet/70" />
        <span className="min-w-0 shrink truncate" onClick={stop}>{frame.trigger ? <EntityIdPill shortId={frame.trigger} /> : <span className="text-xs text-sol-text-muted">{frame.title}</span>}</span>
        {/* What the person focused this run on (orgReview.ts), on the closed line. */}
        {frame.focus && <span className="min-w-0 shrink truncate text-[12px] text-sol-text-muted" data-run-focus={frame.focus}>{frame.focus}</span>}
        {w && (
          <span className="flex min-w-0 shrink items-center gap-1.5 text-[12px]" data-waiting-session={w.short_id}>
            <span className="shrink-0" onClick={stop}><EntityIdPill shortId={w.short_id} compact /></span>
            <span className="truncate text-sol-text-muted">{waitingWords(w, timestamp)}</span>
          </span>
        )}
        {c && <span className="min-w-0 shrink truncate text-[12px] text-sol-text-muted" data-area-change={c.kind}>{changeWords(c)}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        {open ? <ChevronDown className="w-3 h-3 shrink-0 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 shrink-0 text-sol-text-dim" />}
      </div>
      {open && (
        <div className="space-y-2 px-3 pb-2.5 pt-0.5 text-[12px]" data-role-wake-detail>
          {w?.state && <p className="text-sol-text">{w.state}</p>}
          {c && <p className="text-sol-text" data-area-change-line>{c.line}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sol-text-muted" data-role-card>
            <dt className="text-sol-text-dim">Role</dt><dd>{role.name} <span className="text-sol-text-dim">@{role.handle}</span>{role.reports_to && <span className="text-sol-text-dim">, reports to {role.reports_to}</span>}</dd>
            <dt className="text-sol-text-dim">Looks after</dt><dd>{role.scope.length ? role.scope.join(", ") : "no area of its own"}</dd>
            {role.charter && <><dt className="text-sol-text-dim">Charter</dt><dd>{role.charter}</dd></>}
            {role.goals.length > 0 && <><dt className="text-sol-text-dim">Goals</dt><dd>{role.goals.join("; ")}</dd></>}
            {(role.initiatives?.length ?? 0) > 0 && <><dt className="text-sol-text-dim">Serves</dt><dd data-role-card-serves>{role.initiatives!.map((i) => <span key={i.short_id} className="block">{roleCardInitiativeLine(i)}</span>)}</dd></>}
          </dl>
          {prompt && (
            <div className="border-t border-sol-border/30 pt-1.5 text-sol-text-dim prose prose-invert prose-sm max-w-none" data-role-wake-prompt>
              <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_NO_IMG}>{prompt}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The settle word's tone: delivered reads green, a stall red, anything the
 *  parent must answer yellow, a plain turn end stays quiet. */
const WORKER_TONE: Record<string, string> = {
  done: "text-sol-green",
  blocked: "text-sol-yellow",
  permission_blocked: "text-sol-yellow",
  stopped: "text-sol-red",
};

/** One worker's report: who, what it settled on and its pinned line, on one
 *  quiet row that opens in place to the whole line. */
function WorkerReportRow({ worker: w, timestamp, first }: { worker: WaitingSession; timestamp: number; first: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = () => w.state && setOpen(!open);
  return (
    <div data-waiting-session={w.short_id} data-open={open || undefined}>
      <div role="button" tabIndex={w.state ? 0 : -1} onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
        className={`flex min-w-0 items-center gap-1.5 px-2.5 py-1 ${w.state ? "cursor-pointer hover:bg-sol-cyan/5" : ""}`} title={w.state ? (open ? "Hide the report" : "Show the report") : undefined}>
        <CornerDownLeft className={`w-3 h-3 shrink-0 text-sol-cyan/60 ${first ? "" : "invisible"}`} />
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}><EntityIdPill shortId={w.short_id} compact /></span>
        <span className={`shrink-0 ${WORKER_TONE[w.why] ?? "text-sol-text-dim"}`}>{WORKER_SETTLE_WORDS[w.why] ?? w.why.replace(/_/g, " ")}</span>
        {!open && w.state && <span className="min-w-0 flex-1 truncate text-sol-text-dim">{w.state}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{first ? formatRelativeTime(timestamp) : null}</span>
        {w.state && (open ? <ChevronDown className="w-3 h-3 shrink-0 text-sol-text-dim" /> : <ChevronRight className="w-3 h-3 shrink-0 text-sol-text-dim" />)}
      </div>
      {open && <p className="pb-1.5 pl-[30px] pr-2.5 text-sol-text-muted break-words" data-worker-state>{w.state}</p>}
    </div>
  );
}

/** Spawned workers reporting back to the session they nest under
 *  (workerSettle.ts): one row per worker, what it settled on, and the line it
 *  pinned, kept small so it never reads as a message. The frame's body is the
 *  ask to the agent, not shown. */
function WorkerReportBlock({ frame, timestamp }: { frame: ScheduledTaskFrame; timestamp: number }) {
  const workers = frame.workers!;
  return (
    <div className="mb-2 rounded-sm border-l-2 border-sol-cyan/40 bg-sol-cyan/[0.03] py-0.5 text-[12px]" data-worker-report={workers.length}>
      {workers.map((w, i) => <WorkerReportRow key={w.short_id} worker={w} timestamp={timestamp} first={i === 0} />)}
    </div>
  );
}

export function ScheduledTaskBlock({ content: rawContent, timestamp }: { content: string; timestamp: number }) {
  const [showPlumbing, setShowPlumbing] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const spawned = parseSpawnedTaskPrompt(content);
  const frame = spawned ? null : parseScheduledTask(content);
  if (frame?.role) return <RoleWakeBlock frame={frame} timestamp={timestamp} />;
  if (frame?.workers?.length) return <WorkerReportBlock frame={frame} timestamp={timestamp} />;
  const title = spawned?.title || frame?.title || "Trigger Run";
  const prompt = spawned?.prompt ?? (frame?.body || cleanStickyContent(content));
  const prevFailed = !!spawned?.previousRun && /^Failed/i.test(spawned.previousRun.summary);

  return (
    <div className="mb-3 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">{spawned ? "Trigger run" : "Trigger"}</span>
        {/* Apply is the norm and unmarked; read-only runs get the chip. */}
        {spawned && spawned.mode !== "apply" && (
          <ShortcutTooltip label="Read-only run — investigates and reports, changes nothing" hint="file-editing tools are disabled">
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 border-sol-cyan/40 text-sol-cyan/90 bg-sol-cyan/10">
              read-only
            </span>
          </ShortcutTooltip>
        )}
        {/* The trigger's pill carries its title and opens it, where the person
            edits, pauses or cancels it; a run without one names itself. */}
        {frame?.trigger ? <span className="min-w-0 truncate"><EntityIdPill shortId={frame.trigger} /></span> : <span className="text-xs text-sol-text-muted truncate">{title}</span>}
        <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      {frame?.waiting && <WaitingSessionLine waiting={frame.waiting} firedAt={timestamp} />}
      {/* The prompt is authored markdown in both wire formats (spawn header
          and <scheduled-task> inject) — render it as prose either way. A trigger
          briefing is often long, so it starts clipped behind an Expand. */}
      {/* A run that names a waiting session leads with that session; the
          trigger's standing prompt is the same every firing, so it folds. */}
      {frame?.waiting ? (
        <div className="px-3 pb-2">
          <FoldToggle label="trigger prompt" open={showPrompt} onToggle={() => setShowPrompt(!showPrompt)} />
          {showPrompt && (
            <div className="mt-1 text-sm text-sol-text prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_NO_IMG}>{prompt}</ReactMarkdown>
            </div>
          )}
        </div>
      ) : (
        <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
          <div className="text-sm text-sol-text prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_NO_IMG}>{prompt}</ReactMarkdown>
          </div>
        </CollapsibleBody>
      )}
      {spawned?.contextSummary && (
        <div className="mx-3 mb-2 rounded border border-sol-border/30 bg-sol-bg/40 px-2 py-1.5 text-[11px] leading-relaxed text-sol-text-muted">
          <span className="font-medium text-sol-text-dim">Context from originating session: </span>
          {spawned.contextSummary}
        </div>
      )}
      {spawned?.previousRun && (
        <div className={`mx-3 mb-2 rounded border px-2 py-1.5 text-[11px] leading-relaxed ${prevFailed ? "border-sol-red/30 bg-sol-red/5 text-sol-red/90" : "border-sol-border/30 bg-sol-bg/40 text-sol-text-muted"}`}>
          <span className={`font-medium ${prevFailed ? "text-sol-red" : "text-sol-text-dim"}`}>Previous run ({spawned.previousRun.ago}): </span>
          {spawned.previousRun.summary}
        </div>
      )}
      {spawned?.instructions && (
        <div className="px-3 pb-2">
          <FoldToggle label="run instructions" open={showPlumbing} onToggle={() => setShowPlumbing(!showPlumbing)} />
          {showPlumbing && (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-sol-border/30 bg-sol-bg/60 p-2 text-[10px] leading-relaxed text-sol-text-dim font-mono">{spawned.instructions}</pre>
          )}
        </div>
      )}
    </div>
  );
}
