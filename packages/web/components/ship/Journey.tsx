"use client";
// A session's change on its way to live (lib/ship/journey.ts): one track of
// stages from Check to Live, each saying who acts there and where the change
// is, and under it the one thing happening now with the person's part in it
// right there: an answer at Decide, the session's fix when a stage sent work
// back, the deploy when it has landed. The Ship panel previews a flow with it
// and the run's card in the thread draws the run with it.
import { memo, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useInboxStore } from "../../store/inboxStore";
import { ArrowRight, Check, ChevronDown, CornerDownLeft, Loader2, X } from "lucide-react";
import { WHO_WORDS, approvalWords, gateWaitWords, holdWords, insideWords, sentBackWords, stopWords, targetsFromLine, waitWords, type InsideRoute, type Journey as JourneyModel, type JourneyStage, type JourneyNow, type JourneyWait, type TargetState } from "../../lib/ship/journey";
import { ageShort } from "../../lib/lineFlow";
import { RunGate } from "../WorkflowContextPanel";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { sessionTargets, targetNow } from "../../lib/deploys/targets";
import { deploysFocusHref, deploysHref, runFocus, type DeployFocus } from "../../lib/deploys/focus";
import { useDeployPress } from "../../hooks/useDeployPress";
import "./ship.css";

/** `insideId`: the element an open segment's inside is drawn in, which its stage's toggle controls. */
export const JourneyTrack = memo(function JourneyTrack({ stages, compact = false, open, onOpen, insideId }: { stages: JourneyStage[]; compact?: boolean; open?: string | null; onOpen?: (id: string | null) => void; insideId?: string }) {
  // A finished journey says only what happened: no one acts any more, and nothing goes back.
  const finished = stages.length > 0 && stages.every((s) => s.state === "done" || s.state === "skipped") && stages.some((s) => s.state === "done");
  // The stages whose findings come back to the session, as one return line under them.
  const looping = finished ? [] : stages.map((s, i) => (s.loops.length ? i : -1)).filter((i) => i >= 0);
  const back = stages.some((s) => s.state === "back");
  return (
    <div className="sj-track" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }} data-compact={compact ? "" : undefined}>
      <ol className="sj-stages" aria-label="Stages">
        {stages.map((s, i) => {
          const next = stages[i + 1];
          return (
            <li key={s.id} className="sj-stage" data-state={s.state} data-who={s.who} data-past={next && (next.state !== "idle" || s.state === "done") ? "" : undefined} data-stage={s.id}>
              {onOpen && (s.steps?.length || s.inside) ? (
                <button type="button" className="sj-stage-btn" aria-expanded={open === s.id} aria-controls={s.inside ? insideId : undefined} onClick={() => onOpen(open === s.id ? null : s.id)} data-journey-stage={s.id}>
                  <StageFace s={s} finished={finished} />
                </button>
              ) : <StageFace s={s} finished={finished} />}
            </li>
          );
        })}
      </ol>
      {looping.length && !compact ? (
        <div className="sj-return" data-active={back ? "" : undefined} data-single={looping.length === 1 ? "" : undefined} style={{ gridColumn: `${looping[0] + 1} / ${looping[looping.length - 1] + 2}`, ["--n" as string]: looping[looping.length - 1] - looping[0] + 1 }}
          title={`Back to this session from ${looping.map((i) => stages[i].label).join(", ")}`} data-journey-return>
          <span className="sj-return-line" aria-hidden />
          <span className="sj-return-words"><CornerDownLeft className="w-2.5 h-2.5" aria-hidden />findings come back to this session</span>
        </div>
      ) : null}
    </div>
  );
});

function StageFace({ s, finished = false }: { s: JourneyStage; finished?: boolean }) {
  return (
    <>
      <span className="sj-node" aria-hidden><Mark state={s.state} /></span>
      {s.branches && s.label === s.branches.map((b) => b.label).join(" + ") ? (
        // A fan-out is one stage under one name ("CI + Review"); a branch that sent work back, stopped or waits says so
        // in a glyph and in words for a screen reader, never in its color alone (a grayscale screen shows no color).
        <span className="sj-label" data-journey-branches>
          {s.branches.map((b, i) => <span key={b.id}>{i ? " + " : null}<span className="sj-branch" data-state={b.state} data-stage={b.id}>{b.label}{BRANCH_FLAG[b.state] ? <><i className="sj-branch-flag" aria-hidden>{BRANCH_FLAG[b.state]!.glyph}</i><span className="sr-only"> ({BRANCH_FLAG[b.state]!.words})</span></> : null}</span></span>)}
          <StateWords state={s.state} />
        </span>
      ) : <span className="sj-label">{s.label}<StateWords state={s.state} /></span>}
      {/* A segment hints at its inside, which a press on it opens in place. */}
      {s.inside ? <span className="sj-hint" data-journey-hint><span>{insideWords(s.inside)}</span><ChevronDown className="sj-hint-caret" aria-hidden /></span> : null}
      <span className="sj-who">
        {finished ? (s.round ? `round ${s.round}` : "") : s.state === "back" ? "This session" : s.role === "live" || s.state === "skipped" ? "" : WHO_WORDS[s.who]}
        {!finished && s.round ? <span className="sj-round">· round {s.round}</span> : null}
      </span>
    </>
  );
}

/** A fan-out branch's state where it needs a reader's notice, as a glyph and as words. */
const BRANCH_FLAG: Partial<Record<JourneyStage["state"], { glyph: string; words: string }>> = {
  stopped: { glyph: "✕", words: "stopped" },
  back: { glyph: "↩", words: "sent back" },
  waiting: { glyph: "…", words: "waiting" },
};

/** A stage's state in words for a screen reader: its node, which shows it, is hidden from one. */
const STATE_WORDS: Partial<Record<JourneyStage["state"], string>> = { done: "done", active: "current", waiting: "waiting", back: "sent back", stopped: "stopped", routed: "went another way", skipped: "skipped" };
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
  return (
    <ol id={id} className="sj-in" aria-label={`Inside ${stage.label}`} data-journey-inside={stage.id}>
      {path.map((p) => {
        const off = routes.filter((r) => r.from === p.id);
        return (
          <li key={p.id} className="sj-in-step" data-state={p.state} data-who={p.who} data-stage={p.id}>
            <span className="sj-in-node" aria-hidden><Mark state={p.state} /></span>
            <span className="sj-in-head">
              <b>{p.branches ? p.branches.map((b, i) => <span key={b.id} className="sj-branch" data-state={b.state} data-stage={b.id}>{i ? <i className="sj-in-beside"> beside </i> : null}{b.label}</span>) : p.label}<StateWords state={p.state} /></b>
              <span className="sj-in-who">{WHO_WORDS[p.who]}</span>
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
  return (
    <li className="sj-in-route" data-state={r.state} data-asks={r.asks ? "" : undefined} data-to={r.to.kind}>
      {r.label ? <span className="sj-in-when">{r.label}</span> : null}
      {r.steps.map((s) => <span key={s.id} className="sj-in-hop" data-who={s.who} data-state={s.state}>{s.label}<StateWords state={s.state} /></span>)}
      <span className="sj-in-to">
        {r.to.kind === "stop" ? <><X className="w-2.5 h-2.5" aria-hidden />stops</> : <><CornerDownLeft className="w-2.5 h-2.5" aria-hidden /><span className="sr-only">back to </span>{r.to.kind === "session" ? "this session" : r.to.label}</>}
      </span>
      {r.asks ? <span className="sj-in-if">{approvalWords({ kind: "if", when: r.asks.when })}</span> : null}
    </li>
  );
}

/** What one stage did on the run: each of its steps with its words, rounds and the session that did it. */
function StageDetail({ stage, now_ms }: { stage: JourneyStage; now_ms: number }) {
  return (
    <ul className="sj-detail" data-journey-detail={stage.id}>
      {(stage.steps ?? []).map((st) => (
        <li key={st.id} data-status={st.status}>
          <span className="sj-detail-mark" data-status={st.status} aria-hidden />
          <b>{st.label}</b>
          {st.visits && st.visits > 1 ? <span className="sj-round">round {st.visits}</span> : null}
          {st.session ? <Link className="sj-detail-session" href={`/conversation/${st.session.id}`}>{st.session.title ?? "Open session"}</Link> : null}
          {st.at ? <span className="sj-since">{ageShort(now_ms - st.at)}</span> : null}
          {st.said ? <p>{st.said}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Mark({ state }: { state: JourneyStage["state"] }) {
  if (state === "done") return <Check className="w-3 h-3" strokeWidth={3} />;
  if (state === "stopped") return <X className="w-3 h-3" strokeWidth={3} />;
  if (state === "back") return <CornerDownLeft className="w-3 h-3" strokeWidth={2.6} />;
  if (state === "routed") return <ArrowRight className="w-3 h-3" strokeWidth={2.6} />;
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
export function JourneyNowBar({ now, run, now_ms, children, again }: { now: JourneyNow; run: any; now_ms: number; children?: React.ReactNode; again?: (primary: boolean) => React.ReactNode }) {
  const since = (at: number | null | undefined) => (at ? <span className="sj-since">{ageShort(now_ms - at)}</span> : null);
  // The conversation on screen: opening the run's session from inside it goes nowhere, so the brief it sent is the press.
  const here = useInboxStore((s) => (s.currentSessionId ? String(s.currentSessionId) : null));
  const stop = now.kind === "stopped" || now.kind === "failed" ? now : null;
  const inSession = !!stop && stop.fix === "session" && !!stop.session && stop.session === here;
  const briefId = useBriefMessageId(inSession ? here : null, stop?.briefAt ?? null);
  const openRun = run?._id ? <Link className="sj-act" data-primary href={`/workflows/runs/${run._id}`} data-journey-open-run>Open run</Link> : null;
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
      return (
        <div className="sj-now" data-kind="session">
          <CornerDownLeft className="w-3.5 h-3.5" aria-hidden />
          <b>{sentBackWords(now)}</b>
          <span className="sj-what">this session is fixing it{now.round && now.max ? ` · round ${now.round} of ${now.max}` : ""}</span>
          {since(now.since)}
          {children}
          {now.note ? <p className="sj-note" data-journey-note>{now.note}</p> : null}
        </div>
      );
    case "gate":
      return (
        <div className="sj-now" data-kind={now.mine ? "you" : "gate"}>
          <i className="sj-wait" aria-hidden />
          <b>{now.mine ? "Your call" : gateWaitWords(now.holder)}</b>
          <span className="sj-what">{now.prompt ?? now.stage}</span>
          {since(now.since)}
          {!now.mine && now.decisionId ? <Link className="sj-act" href={`/decisions/${run?.gate_decision_short_id ?? now.decisionId}`} data-journey-open-card>Open card</Link> : null}
          {children}
          {now.mine && run?.gate_decision_id ? <div className="sj-gate"><RunGate run={run} className="w-full" /></div> : null}
        </div>
      );
    case "landed":
      return (
        <div className="sj-now" data-kind="landed">
          <Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>Landed</b>
          <code className="sj-sha">{now.sha.slice(0, 7)}</code>
          <span className="sj-what" data-journey-hold={now.hold.kind}>{holdWords(now.hold).words}</span>
          <Waits waits={now.waits} named="Deploy" now_ms={now_ms} fallback={now.line} />
          <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link>
          {children}
        </div>
      );
    case "merged":
      return <div className="sj-now" data-kind="landed"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>Landed</b><code className="sj-sha">{now.sha.slice(0, 7)}</code>{since(now.at)}{children}</div>;
    case "passed":
      return <div className="sj-now" data-kind="live"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>Done</b>{children}</div>;
    case "unlanded":
      return (
        <div className="sj-now" data-kind="stopped" data-journey-unlanded>
          <X className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>Not landed</b>
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
          <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link>
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
          <b>{now.kind === "failed" && !now.end ? `Failed${now.stage ? ` at ${now.stage}` : ""}` : stopWords(now)}</b>
          {/* The action that can work for this stop leads: re-running a refusal, or a session out of rounds, repeats it. */}
          {now.fix === "deploy" ? <Link className="sj-act" data-primary href={deploysHref(run, now.why)} data-journey-deploys>Open {now.why?.match(/\b([a-z][a-z0-9-]{0,31}) dp-\d+/)?.[1] ?? "Deploys"}</Link>
            : now.fix === "session" && !inSession && now.session ? <Link className="sj-act" data-primary href={`/conversation/${now.session}`} data-journey-open-session>Open session</Link>
            : now.fix === "session" && briefId ? <button type="button" className="sj-act" data-primary onClick={() => useInboxStore.getState().requestNavigate(here!, { scrollToMessageId: briefId })} data-journey-open-brief>Open the brief</button>
            : now.fix === "run" ? openRun
            : null}
          {/* Ship again, never for a deploy (it would land the change again); it leads when re-running is the fix, or when nothing else here can. */}
          {now.fix !== "deploy" && again ? again(now.fix === "again" || (inSession && !briefId)) : null}
          {children}
          {now.why ? <p className="sj-note">{now.why}</p> : null}
        </div>
      );
  }
}

/** `targets`, when the caller knows them from the landed commit's deploy reach, are where the change is: never guessed from the session's commits. */
export function JourneyView({ journey, run, now_ms, compact, actions, again, targets }: { journey: JourneyModel; run?: any; now_ms: number; compact?: boolean; actions?: React.ReactNode; again?: (primary: boolean) => React.ReactNode; targets?: ReadonlyArray<TargetState> }) {
  const [open, setOpen] = useState<string | null>(null);
  const insideId = useId();
  const opened = open ? journey.stages.find((s) => s.id === open) ?? null : null;
  const landed = journey.now.kind === "landed" || journey.now.kind === "deploying" || journey.now.kind === "live";
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  return (
    <div className="sj" data-journey={journey.now.kind}>
      <JourneyTrack stages={journey.stages} compact={compact} open={open} onOpen={setOpen} insideId={insideId} />
      {opened?.inside ? <SegmentInside stage={opened} id={insideId} /> : null}
      {opened?.steps?.length ? <StageDetail stage={opened} now_ms={now_ms} /> : null}
      {run ? <JourneyNowBar now={journey.now} run={run} now_ms={now_ms} again={again}>{actions}</JourneyNowBar> : null}
      {run && landed && team && run.spawner_conversation_id ? <SessionTargets teamId={team} conversationId={String(run.spawner_conversation_id)} line={"line" in journey.now ? journey.now.line : null} known={targets} focus={runFocus(run)} /> : null}
    </div>
  );
}

/** Where the session's landed change is on each target, each a step from its place on the Deploys page (`focus`, the
 *  landed commit when the caller knows it, else the session, highlighted there), with the press that sends it where it
 *  waits on a person. */
export function SessionTargets({ teamId, conversationId, line, known: reached, focus }: { teamId: string; conversationId: string; line?: string | null; known?: ReadonlyArray<TargetState>; focus?: DeployFocus | null }) {
  const { targets, deploys } = useDeployTargets(teamId);
  // What the store knows about the session's commits, then whatever else the Deploy stage's own line names.
  const mine = useMemo(() => {
    // The landed commit's own reach is the answer: an open deploy is not proof it carries the change.
    if (reached) return [...reached];
    const known = sessionTargets(conversationId, targets, deploys);
    const all = [...known, ...targetsFromLine(line).filter((t) => !known.some((k) => k.name === t.name))];
    // A deploy going out sends main's head, which holds the landed change whatever its commits link to.
    return all.map((t) => {
      const row = targets.find((x) => x.name === t.name);
      const open = t.state === "waiting" && row ? targetNow(row, deploys).open : null;
      return open ? { ...t, state: "deploying" as const, deploy: open.short_id || null, at: open.created_at } : t;
    });
  }, [conversationId, targets, deploys, line, reached]);
  const press = useDeployPress(teamId, deploys);
  if (!mine.length) return null;
  return (
    <ul className="sj-targets" data-session-targets>
      {mine.map((t) => {
        const row = targets.find((x) => x.name === t.name);
        const canPress = t.state === "waiting" && !!row && row.runs === "here" && row.can_deploy && !targetNow(row, deploys).open;
        return (
          <li key={t.name} className="sj-target-item">
            <Link className="sj-target" data-state={t.state} href={deploysFocusHref({ team: teamId, target: t.name, focus: focus ?? { kind: "session", id: conversationId } })} data-session-target={t.name}>
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
