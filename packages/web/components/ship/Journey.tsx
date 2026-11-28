"use client";
// A session's change on its way to live (lib/ship/journey.ts): one track of
// stages from Check to Live, each saying who acts there and where the change
// is, and under it the one thing happening now with the person's part in it
// right there: an answer at Decide, the session's fix when a stage sent work
// back, the deploy when it has landed. The Ship panel previews a flow with it
// and the run's card in the thread draws the run with it.
import { createContext, memo, useContext, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useInboxStore } from "../../store/inboxStore";
import { roleRowsOf } from "../../lib/roleRows";
import { ArrowRight, Check, ChevronDown, CornerDownLeft, Loader2, Minus, X } from "lucide-react";
import { insideWords, targetsFromLine, withRunDeploys, type InsideRoute, type Journey as JourneyModel, type JourneyStage, type JourneyNow, type JourneyWait, type TargetState } from "../../lib/ship/journey";
import { WHO_WORDS, gateWaitWords, holdWords, outputSummary, plainNote, sentBackWords, stopTitle, waitWords } from "../../lib/ship/journeyWords";
import { approvalWords } from "../../lib/ship/approval";
import { ageShort } from "../../lib/lineFlow";
import { leftWords } from "../../lib/ship/stationResult";
import { resumeWords, type ResumeAt } from "../../lib/ship/resumeAt";
import { useResumeAt } from "../../hooks/useResumeAt";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { resumeAtLedger } from "../consequential/resumeLedger";
import { RunGate } from "../WorkflowContextPanel";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { teamWorkspaceKey } from "../../lib/workspaceScope";
import { sessionTargets, targetNow } from "../../lib/deploys/targets";
import { commitMatches, deploysFocusHref, deploysHref, runFocus, type DeployFocus } from "../../lib/deploys/focus";
import { queueCommits } from "../../lib/deploys/board";
import { openTakes } from "../../lib/deploys/spot";
import { useDeployPress } from "../../hooks/useDeployPress";
import { useJourneyViewer } from "../../hooks/useJourneyViewer";
import type { SessionAsk } from "../../lib/ship/sessionAsk";
import "./ship.css";

/** The session a run's findings come back to, as the place drawing it names it: "this session" inside that session's
 *  thread, "its session" on the run's own page (JourneyView `onRunPage`). */
const SessionWord = createContext("this session");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `insideId`: the element an open segment's inside is drawn in, which its stage's toggle controls. */
/** `task`: the run's task, where a step left for the person was posted: the step opens it. */
export const JourneyTrack = memo(function JourneyTrack({ stages, compact = false, open, onOpen, insideId, task }: { stages: JourneyStage[]; compact?: boolean; open?: string | null; onOpen?: (id: string | null) => void; insideId?: string; task?: string | null }) {
  // A finished journey says only what happened: no one acts any more, and nothing goes back.
  const finished = stages.length > 0 && stages.every((s) => s.state === "done" || s.state === "skipped" || s.state === "nothing") && stages.some((s) => s.state === "done");
  // The stages whose findings come back to the session, as one return line under them.
  const looping = finished ? [] : stages.map((s, i) => (s.loops.length ? i : -1)).filter((i) => i >= 0);
  const back = stages.some((s) => s.state === "back");
  const subject = useContext(SessionWord);
  return (
    <div className="sj-track" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }} data-compact={compact ? "" : undefined}>
      <ol className="sj-stages" aria-label="Stages">
        {stages.map((s, i) => {
          const next = stages[i + 1];
          return (
            <li key={s.id} className="sj-stage" data-state={s.state} data-who={s.who} data-past={next && next.state !== "skipped" && (next.state !== "idle" || s.state === "done" || s.state === "nothing") ? "" : undefined} data-loops={looping.includes(i) ? "" : undefined} data-stage={s.id} title={s.note ?? undefined}>
              {onOpen && (s.steps?.length || s.inside) ? (
                <button type="button" className="sj-stage-btn" aria-expanded={open === s.id} aria-controls={s.inside ? insideId : undefined} onClick={() => onOpen(open === s.id ? null : s.id)} data-journey-stage={s.id}>
                  <StageFace s={s} finished={finished} />
                </button>
              ) : <StageFace s={s} finished={finished} />}
              {s.left ? <LeftStep step={s.left} task={task} className="sj-left" /> : null}
            </li>
          );
        })}
      </ol>
      {looping.length && !compact ? (
        <div className="sj-return" data-active={back ? "" : undefined} data-single={looping.length === 1 ? "" : undefined} style={{ ["--sj-from" as string]: looping[0] + 1, ["--sj-to" as string]: looping[looping.length - 1] + 2, ["--n" as string]: looping[looping.length - 1] - looping[0] + 1 }}
          title={`Back to ${subject} from ${looping.map((i) => stages[i].label).join(", ")}`} data-journey-return>
          <span className="sj-return-line" aria-hidden />
          <span className="sj-return-words"><CornerDownLeft className="w-2.5 h-2.5" aria-hidden />findings come back to {subject}</span>
        </div>
      ) : null}
    </div>
  );
});

function StageFace({ s, finished = false }: { s: JourneyStage; finished?: boolean }) {
  const subject = capital(useContext(SessionWord));
  const who = s.state === "nothing" ? "Skipped" : finished ? (s.round ? `round ${s.round}` : "") : s.state === "back" ? subject : s.role === "live" || s.state === "skipped" ? "" : s.who === "session" ? subject : WHO_WORDS[s.who];
  return (
    <>
      <span className="sj-node" aria-hidden><Mark state={s.state} /></span>
      {s.branches && s.label === s.branches.map((b) => b.label).join(" + ") ? (
        // A fan-out is one stage under one name ("CI + Review"); a branch that sent work back, stopped or waits says so
        // in a glyph and in words for a screen reader, never in its color alone (a grayscale screen shows no color).
        <span className="sj-label" data-journey-branches>
          {s.branches.map((b, i) => <span key={b.id}>{i ? " + " : null}<span className="sj-branch" data-state={b.state} data-stage={b.id} title={b.note ?? undefined}>{b.label}{BRANCH_FLAG[b.state] ? <><i className="sj-branch-flag" aria-hidden>{BRANCH_FLAG[b.state]!.glyph}</i><span className="sr-only"> ({BRANCH_FLAG[b.state]!.words})</span></> : null}</span></span>)}
          <StateWords state={s.state} />
        </span>
      ) : <span className="sj-label">{s.label}<StateWords state={s.state} /></span>}
      {/* A segment hints at its inside, which a press on it opens in place. */}
      {s.inside ? <span className="sj-hint" data-journey-hint><span>{insideWords(s.inside)}</span><ChevronDown className="sj-hint-caret" aria-hidden /></span> : null}
      <span className="sj-who">
        {who}
        {/* A branch that found nothing to do, beside who acts: never in place of it. */}
        {skippedBranches(s) ? <span className="sj-skip">{who ? " · " : ""}{skippedBranches(s)} skipped</span> : null}
        {!finished && s.round ? <span className="sj-round">· round {s.round}</span> : null}
      </span>
    </>
  );
}

/** A fan-out's branches that ran and found nothing to do, by their last step's name ("Check"). */
const skippedBranches = (s: JourneyStage) => s.branches?.filter((b) => b.state === "nothing").map((b) => b.label.split(" → ").pop()).join(", ") || null;

/** A fan-out branch's state where it needs a reader's notice, as a glyph and as words. */
const BRANCH_FLAG: Partial<Record<JourneyStage["state"], { glyph: string; words: string }>> = {
  stopped: { glyph: "✕", words: "stopped" },
  back: { glyph: "↩", words: "sent back" },
  waiting: { glyph: "…", words: "waiting" },
};

/** A stage's state in words for a screen reader: its node, which shows it, is hidden from one. */
const STATE_WORDS: Partial<Record<JourneyStage["state"], string>> = { done: "done", active: "current", waiting: "waiting", back: "sent back", stopped: "stopped", routed: "went another way", skipped: "skipped", nothing: "ran, skipped", unknown: "not known" };
function StateWords({ state }: { state: JourneyStage["state"] }) {
  return STATE_WORDS[state] ? <span className="sr-only">, {STATE_WORDS[state]}</span> : null;
}

/**
 * A segment opened in place: its passing steps down a spine, each route off a step a branch under it that says where it
 * goes back to, and the segment's end last, so nothing reads as after it. A route a person answers on is dashed and says
 * what makes a run ask: it asks only when a run turns there.
 */
function SegmentInside({ stage, id }: { stage: JourneyStage; id?: string }) {
  const { path, routes, end } = stage.inside!;
  const subject = useContext(SessionWord);
  return (
    <ol id={id} className="sj-in" aria-label={`Inside ${stage.label}`} data-journey-inside={stage.id}>
      {path.map((p) => {
        const off = routes.filter((r) => r.from === p.id);
        return (
          <li key={p.id} className="sj-in-step" data-state={p.state} data-who={p.who} data-stage={p.id}>
            <span className="sj-in-node" aria-hidden><Mark state={p.state} /></span>
            <span className="sj-in-head">
              <b>{p.branches ? p.branches.map((b, i) => <span key={b.id} className="sj-branch" data-state={b.state} data-stage={b.id}>{i ? <i className="sj-in-beside"> beside </i> : null}{b.label}</span>) : p.label}<StateWords state={p.state} /></b>
              <span className="sj-in-who">{p.who === "session" ? capital(subject) : WHO_WORDS[p.who]}</span>
            </span>
            {off.length ? <ul className="sj-in-routes" aria-label={`Off ${p.label}`}>{off.map((r, i) => <Route key={i} r={r} />)}</ul> : null}
          </li>
        );
      })}
      {end ? <li className="sj-in-step sj-in-end"><span className="sj-in-node" aria-hidden /><span className="sj-in-head"><b>{end}</b></span></li> : null}
    </ol>
  );
}

function Route({ r }: { r: InsideRoute }) {
  const subject = useContext(SessionWord);
  return (
    <li className="sj-in-route" data-state={r.state} data-asks={r.asks ? "" : undefined} data-to={r.to.kind}>
      {r.label ? <span className="sj-in-when">{r.label}</span> : null}
      {r.steps.map((s, i) => (
        <span key={s.id} className="sj-in-hops">
          {i || r.label ? <i className="sj-in-arrow" aria-hidden>→</i> : null}
          <span className="sj-in-hop" data-who={s.who} data-state={s.state}>{s.label}<StateWords state={s.state} /></span>
        </span>
      ))}
      <span className="sj-in-to">
        {r.to.kind === "stop" ? <><X className="w-2.5 h-2.5" aria-hidden />stops</> : <><CornerDownLeft className="w-2.5 h-2.5" aria-hidden /><span className="sr-only">back to </span>{r.to.kind === "session" ? subject : r.to.label}</>}
      </span>
      {r.asks ? <span className="sj-in-if">{approvalWords({ kind: "if", when: r.asks.when })}</span> : null}
    </li>
  );
}

/** What one stage did on the run: each of its steps with its words, rounds and the session that did it. */
/** A step a station left to the person: it opens the task it was posted to, where the person does it and says so. */
function LeftStep({ step, task, className }: { step: string; task?: string | null; className: string }) {
  return task
    ? <Link className={className} href={`/tasks/${task}`} title={step} data-journey-left>{leftWords(step)}</Link>
    : <span className={className} title={step} data-journey-left>{leftWords(step)}</span>;
}

/** What a step said. A script's long output (a cut log) reads as how it ended and why; the whole of it opens below. */
function StepSaid({ said, script }: { said: string; script: boolean }) {
  const { head, full } = script ? outputSummary(said) : { head: said, full: null };
  return (
    <>
      <p>{head}</p>
      {full ? (
        <details className="sj-detail-full" data-journey-full-output>
          <summary>Full output</summary>
          <pre>{full}</pre>
        </details>
      ) : null}
    </>
  );
}

function StageDetail({ stage, now_ms, task }: { stage: JourneyStage; now_ms: number; task?: string | null }) {
  return (
    <ul className="sj-detail" data-journey-detail={stage.id}>
      {(stage.steps ?? []).map((st) => (
        <li key={st.id} data-status={st.status}>
          <span className="sj-detail-mark" data-status={st.skipped || st.earlier ? "skipped" : st.status} aria-hidden />
          <b>{st.label}</b>
          {st.skipped ? <span className="sj-skip">Skipped</span> : st.earlier ? <span className="sj-skip">earlier round</span> : null}
          {st.visits && st.visits > 1 ? <span className="sj-round">round {st.visits}</span> : null}
          {st.session ? <Link className="sj-detail-session" href={`/conversation/${st.session.id}`}>{st.session.title ?? "Open session"}</Link> : null}
          {st.at ? <span className="sj-since">{ageShort(now_ms - st.at)}</span> : null}
          {/* The step that posted the step left for the person says it below, where it opens the task. */}
          {st.said && !(stage.left && st.said.startsWith(leftWords(""))) ? <StepSaid said={st.said} script={!st.session} /> : null}
        </li>
      ))}
      {stage.left ? <li><LeftStep step={stage.left} task={task} className="sj-detail-left" /></li> : null}
    </ul>
  );
}

function Mark({ state }: { state: JourneyStage["state"] }) {
  if (state === "done") return <Check className="w-3 h-3" strokeWidth={3} />;
  if (state === "stopped") return <X className="w-3 h-3" strokeWidth={3} />;
  if (state === "back") return <CornerDownLeft className="w-3 h-3" strokeWidth={2.6} />;
  if (state === "routed") return <ArrowRight className="w-3 h-3" strokeWidth={2.6} />;
  if (state === "nothing") return <Minus className="w-3 h-3" strokeWidth={3} />;
  if (state === "unknown") return <b className="sj-unknown" aria-hidden>?</b>;
  if (state === "active") return <i className="sj-pulse" />;
  if (state === "waiting") return <i className="sj-wait" />;
  return null;
}

/** Each thing the run waits on, in a few words; a wait on the station the bar already names leaves its name off. */
function Waits({ waits, named, now_ms, fallback }: { waits: JourneyWait[]; named?: string; now_ms: number; fallback?: string | null }) {
  if (!waits.length) return fallback ? <span className="sj-what">{fallback}</span> : null;
  return (
    <>
      {waits.map((w, i) => {
        // A line that already says what it waits on ("Waiting on CI for #12 …") needs neither the station's name nor the prefix.
        const own = w.on === named || /^waiting\b/i.test(w.line ?? "");
        const words = waitWords({ ...w, on: own ? "" : w.on, line: w.line ?? (own ? fallback ?? null : null) }, now_ms, ageShort);
        return words ? <span key={i} className="sj-what" data-journey-wait={w.on} data-late={w.deadline && w.deadline < now_ms ? "" : undefined}>{own ? words : `Waiting on ${words}`}</span> : null;
      })}
    </>
  );
}

/** The brief a run sent this conversation when it last sent work back: the newest user message from just before the fix
 *  station started until two minutes after. */
function useBriefMessageId(conversationId: string | null, at: number | null): string | null {
  return useInboxStore((s) => {
    if (!conversationId || !at) return null;
    const msgs = (s.messages as Record<string, Array<{ _id: string; role?: string; timestamp?: number }>>)[conversationId] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const t = m.timestamp ?? 0;
      if (m.role === "user" && t >= at - 5_000 && t <= at + 120_000) return String(m._id);
    }
    return null;
  });
}

/** What is happening now, and the person's part in it. `again` draws Ship again, primary when re-running is the fix. */
/** `personal`: a personal Ship's run: its reasons show whole, and its Deploy, which deploys itself, opens Deploys only with targets. */
/** `onRunPage`: drawn on the run's own page, whose head says the state and whose chips link the objects: the bar then
 *  carries only what the person does there, `act` (lib/ship/changePage changeAction), an answer to their own card, and
 *  a stop's resume. */
export function JourneyNowBar({ now, run, now_ms, children, again, personal = false, onRunPage = false, act }: { now: JourneyNow; run: any; now_ms: number; children?: React.ReactNode; again?: (primary: boolean) => React.ReactNode; personal?: boolean; onRunPage?: boolean; act?: React.ReactNode }) {
  const since = (at: number | null | undefined) => (at ? <span className="sj-since">{ageShort(now_ms - at)}</span> : null);
  // The conversation on screen: opening the run's session from inside it goes nowhere, so the brief it sent is the press.
  const here = useInboxStore((s) => (s.currentSessionId ? String(s.currentSessionId) : null));
  // A deploy a role sends names the role by its title (the Release Captain for @release); read only while one waits.
  const roles = useInboxStore((s) => (now.kind === "landed" && now.hold.kind === "press" ? roleRowsOf(s as any).roles : undefined));
  const stop = now.kind === "stopped" || now.kind === "failed" ? now : null;
  const subject = useContext(SessionWord);
  const inSession = !!stop && stop.fix === "session" && !!stop.session && stop.session === here;
  const briefId = useBriefMessageId(inSession ? here : null, stop?.briefAt ?? null);
  // A stop that says to resume the run leads with that press (ResumeAtPress); opening the run follows it.
  const resume = stop?.resume && run?._id ? stop.resume : null;
  const openRun = run?._id && !onRunPage ? <Link className="sj-act" data-primary={resume ? undefined : ""} href={`/workflows/runs/${run._id}`} data-journey-open-run>Open run</Link> : null;
  if (onRunPage) {
    const answer = now.kind === "gate" && now.mine && run?.gate_decision_id ? <div className="sj-gate"><RunGate run={run} className="w-full" /></div>
      : now.kind === "session" && now.blocked && now.ask?.mine ? <div className="sj-gate"><RunGate run={{ gate_decision_id: now.ask.id, gate_decision_short_id: now.ask.short_id ?? undefined }} className="w-full" /></div>
      : null;
    if (!answer && !resume && !act) return null;
    return <div className="sj-now" data-kind="act" data-journey-acts>{resume ? <ResumeAtPress runId={String(run._id)} resume={resume} /> : null}{act}{children}{answer}</div>;
  }
  switch (now.kind) {
    case "idle": return null;
    case "starting":
      return <div className="sj-now" data-kind="working"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /><b>Starting</b>{children}</div>;
    case "working":
      return (
        <div className="sj-now" data-kind="working" data-who={now.who}>
          <i className="sj-pulse" aria-hidden />
          <b>{now.stage}</b>
          <Waits waits={now.waits} named={now.stage} now_ms={now_ms} fallback={now.who === "agent" ? "an agent is on it" : "running"} />
          {now.session ? <Link className="sj-act" href={`/conversation/${now.session.id}`} data-journey-open-session>Open {now.who === "agent" ? "agent" : "session"}</Link> : null}
          {children}
        </div>
      );
    case "session":
      if (now.blocked) return <AskBar ask={now.ask} note={now.note} since={now.since} conversation={now.conversation} now_ms={now_ms}>{children}</AskBar>;
      return (
        <div className="sj-now" data-kind="session">
          <CornerDownLeft className="w-3.5 h-3.5" aria-hidden />
          <b>{sentBackWords(now)}</b>
          <span className="sj-what">{subject} is fixing it{now.round && now.max ? ` · round ${now.round} of ${now.max}` : ""}</span>
          {since(now.since)}
          {children}
          {now.note ? <p className="sj-note" data-journey-note>{plainNote(now.note)}</p> : null}
        </div>
      );
    case "gate":
      return (
        <div className="sj-now" data-kind={now.mine ? "you" : "gate"}>
          <i className="sj-wait" aria-hidden />
          <b>{now.mine ? "Your call" : gateWaitWords(now.holder, now.who)}</b>
          {/* The decision under the bar carries the question; the bar says only where the run waits. */}
          <span className="sj-what">{now.mine && run?.gate_decision_id ? `at ${now.stage}` : now.prompt ?? now.stage}</span>
          {since(now.since)}
          {!now.mine && now.decisionId ? <Link className="sj-act" href={`/decisions/${run?.gate_decision_short_id ?? now.decisionId}`} data-journey-open-card>Open card</Link> : null}
          {children}
          {now.mine && run?.gate_decision_id ? <div className="sj-gate"><RunGate run={run} className="w-full" embedded /></div> : null}
        </div>
      );
    case "landed":
      return (
        <div className="sj-now" data-kind="landed">
          <Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>Merged</b>
          <code className="sj-sha">{now.sha.slice(0, 7)}</code>
          <span className="sj-what" data-journey-hold={now.hold.kind}>{holdWords(now.hold, roles).words}</span>
          <Waits waits={now.waits} named="Deploy" now_ms={now_ms} fallback={now.line} />
          <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link>
          {children}
        </div>
      );
    case "merged":
      return <div className="sj-now" data-kind="landed"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>{now.end ?? "Merged"}</b><code className="sj-sha">{now.sha.slice(0, 7)}</code>{since(now.at)}{now.why ? <span className="sj-what">{now.why}</span> : null}{children}</div>;
    case "passed":
      return <div className="sj-now" data-kind="live"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>Done</b>{children}</div>;
    case "unlanded":
      return (
        <div className="sj-now" data-kind="stopped" data-journey-unlanded>
          <X className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>Not merged</b>
          <span className="sj-what">{now.why}</span>
          {openRun}
          {children}
          {now.waits.length ? <p className="sj-note"><Waits waits={now.waits} now_ms={now_ms} /></p> : null}
        </div>
      );
    case "deploying":
      return (
        <div className="sj-now" data-kind="working">
          <i className="sj-pulse" aria-hidden />
          <b>Deploying</b>
          <Waits waits={now.waits} named="Deploy" now_ms={now_ms} fallback={now.line ?? now.targets.join(", ")} />
          {/* Only a run going out to deploy targets has a place on the Deploys page; one whose Deploy deploys itself has none. */}
          {!personal || now.targets.length || targetsFromLine(now.line).length ? <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link> : null}
          {children}
        </div>
      );
    case "live":
      return <div className="sj-now" data-kind="live"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>Live</b><span className="sj-what">{(now.line ?? now.targets.join(", ")).replace(/^Live:\s*/, "")}</span>{children}</div>;
    case "stopped":
    case "failed":
      return (
        <div className="sj-now" data-kind="stopped" data-journey-fix={now.fix}>
          <X className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>{stopTitle(now)}</b>
          {resume ? <ResumeAtPress runId={String(run._id)} resume={resume} /> : null}
          {/* The action that can work for this stop leads: re-running a refusal, or a session out of rounds, repeats it. */}
          {now.fix === "deploy" ? <Link className="sj-act" data-primary href={deploysHref(run, now.why)} data-journey-deploys>Open Deploys</Link>
            : now.fix === "session" && !inSession && now.session ? <Link className="sj-act" data-primary href={`/conversation/${now.session}`} data-journey-open-session>Open session</Link>
            : now.fix === "session" && briefId ? <button type="button" className="sj-act" data-primary onClick={() => useInboxStore.getState().requestNavigate(here!, { scrollToMessageId: briefId })} data-journey-open-brief>Open the brief</button>
            : now.fix === "run" ? <>{openRun}{now.session && now.session !== here && !now.landed ? <Link className="sj-act" href={`/conversation/${now.session}`} data-journey-open-session>Open session</Link> : null}</>
            : null}
          {/* Ship again, never for a deploy (it would land the change again); it leads when re-running is the fix, or when nothing else here can. */}
          {/* A deliberate stop (fix "run") stops the same way if run again: its words name the step first, done in the session (ct-102100). */}
          {/* A change already on main lands nothing if shipped again: the run is the way on. */}
          {/* A change that may be on main (Landing unknown) could land twice: resuming the run at Land is the way on. */}
          {/* A stop that names its resume (the change is ready; one station goes again) offers only that; one whose words
              name its one restart (a worktree something moved: `whole`) offers none, its words say it. */}
          {now.fix !== "deploy" && now.fix !== "run" && again && !now.landed && !now.mayHaveLanded && !resume && !now.whole ? again(now.fix === "again" || (inSession && !briefId)) : null}
          {children}
          {/* A stop's reason is whole: its last words are what the person does next. */}
          {now.why ? <p className="sj-note" data-whole={personal || now.whole || undefined} data-journey-why>{now.why}</p> : null}
        </div>
      );
  }
}

/** Resume a stopped run at the station its reason names (lib/ship/resumeAt.ts), after its review (resumeLedger): pending while the server takes it, then
 *  the run moves on and this bar with it; a refusal says the server's own words. */
function ResumeAtPress({ runId, resume }: { runId: string; resume: ResumeAt }) {
  const { state, press } = useResumeAt(runId, resume.at);
  const [reviewing, setReviewing] = useState(false);
  const pending = state.kind === "pending";
  return (
    <>
      <button type="button" className="sj-act" data-primary disabled={pending} aria-busy={pending || undefined} onClick={() => setReviewing(true)} data-journey-resume={resume.at}>{pending ? "Resuming…" : resumeWords(resume)}</button>
      {reviewing ? <SwitchReview ledger={resumeAtLedger(resume)} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void press(); }} /> : null}
      {state.kind === "refused" ? <p className="sj-note" role="alert" data-journey-resume-refused>Could not resume: {state.why}</p> : null}
    </>
  );
}

/**
 * The run waits on its session, which asks a person (it pinned blocked): whom it waits on and the question. The viewer's
 * own card is answered right here, a card for someone else opens, and an ask in words only opens the session.
 */
function AskBar({ ask, note, since, conversation, now_ms, children }: { ask: SessionAsk | null; note: string; since: number | null; conversation: string | null; now_ms: number; children?: React.ReactNode }) {
  const here = useInboxStore((s) => (s.currentSessionId ? String(s.currentSessionId) : null));
  const subject = useContext(SessionWord);
  return (
    <div className="sj-now" data-kind={ask?.mine ? "you" : "gate"} data-journey-ask={ask ? (ask.mine ? "mine" : "card") : "words"}>
      <i className="sj-wait" aria-hidden />
      <b>{sentBackWords({ stage: "", by: null, blocked: true, ask })}</b>
      <span className="sj-what">{ask?.question ?? `${subject} asks; the run goes on when it next ends a turn`}</span>
      {since ? <span className="sj-since">{ageShort(now_ms - since)}</span> : null}
      {ask && !ask.mine ? <Link className="sj-act" href={`/decisions/${ask.short_id ?? ask.id}`} data-journey-open-card>Open card</Link>
        : !ask && conversation && conversation !== here ? <Link className="sj-act" href={`/conversation/${conversation}`} data-journey-open-session>Open session</Link>
        : null}
      {children}
      {/* The session's own words on what it waits for: a card can be about something else. */}
      {note ? <p className="sj-note" data-journey-note>{plainNote(note)}</p> : null}
      {ask?.mine ? <div className="sj-gate"><RunGate run={{ gate_decision_id: ask.id, gate_decision_short_id: ask.short_id ?? undefined }} className="w-full" /></div> : null}
    </div>
  );
}

/** A run page's word on a run whose session asks a person: the run card's bar, while the run waits on that answer. */
export function RunSessionAsk({ run, now_ms }: { run: any; now_ms: number }) {
  const viewer = useJourneyViewer(run);
  const w = run?.waiting_on_session;
  const live = run?.status === "running" || run?.status === "paused";
  if (!live || !w?.blocked || viewer.ask?.open === false) return null;
  return <div className="sj"><AskBar ask={viewer.ask ?? null} note={w.note ?? ""} since={w.since ?? null} conversation={w.conversation_id ?? null} now_ms={now_ms} /></div>;
}

/** `targets`, when the caller knows them from the landed commit's deploy reach, are where the change is: never guessed from the session's commits. */
/** `onRunPage`: the run's own page, whose head links each deploy already and where opening the run goes nowhere. */
/** `act` and `stages`: the run page's one action for the bar, and the track as the run ended (changePage endedStages). */
export function JourneyView({ journey, run, now_ms, compact, actions, again, targets, onRunPage = false, act, stages }: { journey: JourneyModel; run?: any; now_ms: number; compact?: boolean; actions?: React.ReactNode; again?: (primary: boolean) => React.ReactNode; targets?: ReadonlyArray<TargetState>; onRunPage?: boolean; act?: React.ReactNode; stages?: JourneyStage[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const insideId = useId();
  const opened = open ? journey.stages.find((s) => s.id === open) ?? null : null;
  const landed = journey.now.kind === "landed" || journey.now.kind === "deploying" || journey.now.kind === "live";
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  return (
    <SessionWord.Provider value={onRunPage ? "its session" : "this session"}>
    <div className="sj" data-journey={journey.now.kind}>
      <JourneyTrack stages={stages ?? journey.stages} compact={compact} open={open} onOpen={setOpen} insideId={insideId} task={run?.task_short_id ?? null} />
      {opened?.inside ? <SegmentInside stage={opened} id={insideId} /> : null}
      {opened?.steps?.length ? <StageDetail stage={opened} now_ms={now_ms} task={run?.task_short_id ?? null} /> : null}
      {run ? <JourneyNowBar now={journey.now} run={run} now_ms={now_ms} again={again} personal={!!journey.personal} onRunPage={onRunPage} act={act}>{actions}</JourneyNowBar> : null}
      {run && landed && team && run.spawner_conversation_id && !onRunPage ? <SessionTargets teamId={team} conversationId={String(run.spawner_conversation_id)} line={"line" in journey.now ? journey.now.line : null} known={targets} focus={runFocus(run)} /> : null}
    </div>
    </SessionWord.Provider>
  );
}

/** Where the session's landed change is on each target, each a step from its place on the Deploys page (`focus`, the
 *  landed commit when the caller knows it, else the session, highlighted there), with the press that sends it where it
 *  waits on a person. */
export function SessionTargets({ teamId, conversationId, line, known: reached, focus }: { teamId: string; conversationId: string; line?: string | null; known?: ReadonlyArray<TargetState>; focus?: DeployFocus | null }) {
  const { targets, deploys, productions } = useDeployTargets(teamWorkspaceKey(teamId));
  // What the store knows about the session's commits, then whatever else the Deploy stage's own line names.
  const mine = useMemo(() => {
    // The landed commit's own reach is the answer: an open deploy is not proof it carries the change.
    if (reached) return withRunDeploys(reached, line);
    const known = sessionTargets(conversationId, targets, deploys);
    const all = [...known, ...targetsFromLine(line).filter((t) => !known.some((k) => k.name === t.name))];
    // A deploy going out takes the change only when it was cut at or after the change's commits: an open request with
    // no commit, or one older than the change, is not carrying it (a stale requested deploy once read "going out" forever).
    return all.map((t) => {
      const row = targets.find((x) => x.name === t.name);
      const open = t.state === "waiting" && row ? targetNow(row, deploys).open : null;
      const queue = row ? queueCommits(row.queue.groups) : [];
      const change = queue.filter((c) => (focus ? commitMatches(c, focus) : c.session?.conversation_id === conversationId));
      return open && openTakes(open, queue, change) ? { ...t, state: "deploying" as const, deploy: open.short_id || null, at: open.created_at } : t;
    });
  }, [conversationId, targets, deploys, line, reached, focus]);
  const press = useDeployPress(teamId, deploys, productions);
  if (!mine.length) return null;
  return (
    <ul className="sj-targets" data-session-targets>
      {mine.map((t) => {
        const row = targets.find((x) => x.name === t.name);
        // Red CI on what a deploy would send is never offered as the press here; the target's link opens the Deploys page.
        const canPress = t.state === "waiting" && !!row && row.runs === "here" && row.can_deploy && row.queue.head_ci !== "failed" && !row.queue.reading && !targetNow(row, deploys).open;
        return (
          <li key={t.name} className="sj-target-item">
            <Link className="sj-target" data-state={t.state} href={deploysFocusHref({ team: teamId, target: t.name, focus: focus ?? { kind: "session", id: conversationId }, open: t.deploy })} data-session-target={t.name}>
              <i aria-hidden />{t.name}<span>{t.state === "live" ? t.deploy ?? "live" : t.state === "deploying" ? `going out${t.deploy ? ` · ${t.deploy}` : ""}` : t.state === "failed" ? "failed" : "waiting"}</span>
            </Link>
            {canPress ? <button type="button" className="sj-btn" data-primary onClick={() => press.open({ target: row!, action: "deploy", of: null })} data-session-deploy={t.name}>Deploy</button> : null}
          </li>
        );
      })}
      {press.review}
    </ul>
  );
}
