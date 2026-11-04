"use client";
// A session's change on its way to live (lib/ship/journey.ts): one track of
// stages from Check to Live, each saying who acts there and where the change
// is, and under it the one thing happening now with the person's part in it
// right there: an answer at Decide, the session's fix when a stage sent work
// back, the deploy when it has landed. The Ship panel previews a flow with it
// and the run's card in the thread draws the run with it.
import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { Check, CornerDownLeft, Loader2, X } from "lucide-react";
import { WHO_WORDS, targetsFromLine, type Journey as JourneyModel, type JourneyStage, type JourneyNow } from "../../lib/ship/journey";
import { ageShort } from "../../lib/lineFlow";
import { RunGate } from "../WorkflowContextPanel";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { sessionTargets, targetNow } from "../../lib/deploys/targets";
import { useDeployPress } from "../deploys/DeployPress";
import "./ship.css";

export const JourneyTrack = memo(function JourneyTrack({ stages, compact = false, open, onOpen }: { stages: JourneyStage[]; compact?: boolean; open?: string | null; onOpen?: (id: string | null) => void }) {
  // A finished journey says only what happened: no one acts any more, and nothing goes back.
  const finished = stages.length > 0 && stages.every((s) => s.state === "done");
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
              {onOpen && s.steps?.length ? (
                <button type="button" className="sj-stage-btn" aria-expanded={open === s.id} onClick={() => onOpen(open === s.id ? null : s.id)} data-journey-stage={s.id}>
                  <StageFace s={s} finished={finished} />
                </button>
              ) : <StageFace s={s} finished={finished} />}
            </li>
          );
        })}
      </ol>
      {looping.length && !compact ? (
        <div className="sj-return" data-active={back ? "" : undefined} style={{ gridColumn: `${looping[0] + 1} / ${looping[looping.length - 1] + 2}`, ["--n" as string]: looping[looping.length - 1] - looping[0] + 1 }}
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
      <span className="sj-label">{s.label}</span>
      <span className="sj-who">
        {finished ? (s.round ? `round ${s.round}` : "") : s.state === "back" ? "This session" : s.id === "live" ? "" : WHO_WORDS[s.who]}
        {!finished && s.round ? <span className="sj-round">· round {s.round}</span> : null}
      </span>
    </>
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
  if (state === "active") return <i className="sj-pulse" />;
  if (state === "waiting") return <i className="sj-wait" />;
  return null;
}

/** The Deploys page for the run's team, at one target when the words name one ("web dp-12"). */
export function deploysHref(run: any, words?: string | null): string {
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  const target = words?.match(/\b([a-z][a-z0-9-]{0,31}) dp-\d+/)?.[1] ?? null;
  const q = [team ? `team=${team}` : null, target ? `target=${encodeURIComponent(target)}` : null].filter(Boolean).join("&");
  return `/deploys${q ? `?${q}` : ""}`;
}

/** What is happening now, and the person's part in it. */
export function JourneyNowBar({ now, run, now_ms, children }: { now: JourneyNow; run: any; now_ms: number; children?: React.ReactNode }) {
  const since = (at: number | null | undefined) => (at ? <span className="sj-since">{ageShort(now_ms - at)}</span> : null);
  switch (now.kind) {
    case "idle": return null;
    case "starting":
      return <div className="sj-now" data-kind="working"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /><b>Starting</b>{children}</div>;
    case "working":
      return (
        <div className="sj-now" data-kind="working" data-who={now.who}>
          <i className="sj-pulse" aria-hidden />
          <b>{now.stage}</b>
          <span className="sj-what">{now.activity ?? (now.who === "agent" ? "an agent is on it" : "running")}</span>
          {since(now.since)}
          {now.session ? <Link className="sj-act" href={`/conversation/${now.session.id}`} data-journey-open-session>Open {now.who === "agent" ? "agent" : "session"}</Link> : null}
          {children}
        </div>
      );
    case "session":
      return (
        <div className="sj-now" data-kind="session">
          <CornerDownLeft className="w-3.5 h-3.5" aria-hidden />
          <b>{now.stage} sent it back</b>
          <span className="sj-what">this session is fixing it{now.round && now.max ? ` · round ${now.round} of ${now.max}` : ""}</span>
          {since(now.since)}
          {children}
          {now.note ? <p className="sj-note" data-journey-note>{now.note}</p> : null}
        </div>
      );
    case "you":
      return (
        <div className="sj-now" data-kind="you">
          <i className="sj-wait" aria-hidden />
          <b>Your call</b>
          <span className="sj-what">{now.prompt ?? now.stage}</span>
          {children}
          {run?.gate_decision_id ? <div className="sj-gate"><RunGate run={run} className="w-full" /></div> : null}
        </div>
      );
    case "landed":
      return (
        <div className="sj-now" data-kind="landed">
          <Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>Landed</b>
          {now.line ? <span className="sj-what">{now.line}</span> : <>{now.sha ? <code className="sj-sha">{now.sha.slice(0, 7)}</code> : null}<span className="sj-what">waiting to deploy</span></>}
          {since(now.at)}
          <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link>
          {children}
        </div>
      );
    case "deploying":
      return (
        <div className="sj-now" data-kind="working">
          <i className="sj-pulse" aria-hidden />
          <b>Deploying</b>
          <span className="sj-what">{now.line ?? now.targets.join(", ")}</span>
          <Link className="sj-act" href={deploysHref(run, now.line)} data-journey-deploys>Deploys</Link>
          {children}
        </div>
      );
    case "live":
      return <div className="sj-now" data-kind="live"><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden /><b>Live</b><span className="sj-what">{(now.line ?? now.targets.join(", ")).replace(/^Live:\s*/, "")}</span>{children}</div>;
    case "stopped":
    case "failed":
      return (
        <div className="sj-now" data-kind="stopped">
          <X className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
          <b>{now.kind === "stopped" ? "Stopped" : "Failed"}{now.stage ? ` at ${now.stage}` : ""}</b>
          {now.stage === "Deploy" ? <Link className="sj-act" href={deploysHref(run, now.why)} data-journey-deploys>Open {now.why?.match(/\b([a-z][a-z0-9-]{0,31}) dp-\d+/)?.[1] ?? "Deploys"}</Link> : null}
          {children}
          {now.why ? <p className="sj-note">{now.why}</p> : null}
        </div>
      );
  }
}

export function JourneyView({ journey, run, now_ms, compact, actions }: { journey: JourneyModel; run?: any; now_ms: number; compact?: boolean; actions?: React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const opened = open ? journey.stages.find((s) => s.id === open) ?? null : null;
  const landed = journey.now.kind === "landed" || journey.now.kind === "deploying" || journey.now.kind === "live";
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  return (
    <div className="sj" data-journey={journey.now.kind}>
      <JourneyTrack stages={journey.stages} compact={compact} open={open} onOpen={run ? setOpen : undefined} />
      {opened ? <StageDetail stage={opened} now_ms={now_ms} /> : null}
      {run ? <JourneyNowBar now={journey.now} run={run} now_ms={now_ms}>{actions}</JourneyNowBar> : null}
      {run && landed && team && run.spawner_conversation_id ? <SessionTargets teamId={team} conversationId={String(run.spawner_conversation_id)} line={"line" in journey.now ? journey.now.line : null} /> : null}
    </div>
  );
}

/** Where the session's landed change is on each target, each a step from its place on the Deploys page, with the press
 *  that sends it where it waits on a person. */
export function SessionTargets({ teamId, conversationId, line }: { teamId: string; conversationId: string; line?: string | null }) {
  const { targets, deploys } = useDeployTargets(teamId);
  // What the store knows about the session's commits, then whatever else the Deploy stage's own line names.
  const mine = useMemo(() => {
    const known = sessionTargets(conversationId, targets, deploys);
    const all = [...known, ...targetsFromLine(line).filter((t) => !known.some((k) => k.name === t.name))];
    // A deploy going out sends main's head, which holds the landed change whatever its commits link to.
    return all.map((t) => {
      const row = targets.find((x) => x.name === t.name);
      const open = t.state === "waiting" && row ? targetNow(row, deploys).open : null;
      return open ? { ...t, state: "deploying" as const, deploy: open.short_id || null, at: open.created_at } : t;
    });
  }, [conversationId, targets, deploys, line]);
  const press = useDeployPress(teamId, deploys);
  if (!mine.length) return null;
  return (
    <ul className="sj-targets" data-session-targets>
      {mine.map((t) => {
        const row = targets.find((x) => x.name === t.name);
        const canPress = t.state === "waiting" && !!row && row.runs === "here" && row.can_deploy && !targetNow(row, deploys).open;
        return (
          <li key={t.name} className="sj-target-item">
            <Link className="sj-target" data-state={t.state} href={`/deploys?team=${teamId}&target=${encodeURIComponent(t.name)}`} data-session-target={t.name}>
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
