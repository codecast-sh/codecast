"use client";
// Dispatch (learning-loop.md LL12): what hands problems to runs. The page is
// the dispatcher as its next pass sees it (lineStages.dispatch, a dry pass):
// the places running out of its ten, the run limit, the cap on billed money
// (subscription use is quota, never money, and holds runs only when an
// account nears its window), what holds it now, and its queue in the order
// it starts problems, each with why it is due. Raising the limits goes
// through the confirm flow; a pass runs every 10 minutes on its own.
import { useState } from "react";
import { useInboxStore } from "../../../../store/inboxStore";
import { useLineDispatch, useSyncLineDispatch, type LineDispatchRow, type LineDueRow } from "../../../../hooks/useLineStages";
import { RAISE_PICKS, limitsHit, raiseLimitsLedger, raisedLimits, type TrialLimits } from "../../../../lib/line/trialStopLedgers";
import { SwitchReview } from "../../../consequential/ConsequentialSwitch";
import { agoWords, usd } from "../../../../lib/line/flowStages";
import { problemListName } from "../../../../lib/line/problemTable";
import type { LineViewProps } from "../views/types";
import { Gap, Section, StageHead } from "./parts";

const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString("en-US"));

type Task = { _id: string; short_id?: string; title: string; cause?: { named?: { name?: string } } };

/** Why a problem is due, in a word or two (lineTrial.dueProblems). */
function dueWhy(d: LineDueRow): string {
  if (d.reopened) return `fix set aside at ${d.reopened}`;
  if (!d.last_run) return "never run";
  if (d.regrouped) return "new findings since its run";
  return `last run ${d.last_run}`;
}

export function DispatchStage({ workspace: ws, select, href, projectId }: LineViewProps & { projectId: string | null }) {
  useSyncLineDispatch(projectId);
  const row = useLineDispatch(projectId);
  if (!projectId) return <div className="lw-empty"><b>No project</b>Pick the trial's project to see its dispatcher.</div>;
  if (!row) return <div className="lw-skeleton" aria-busy>{[60, 90, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
  return <Dispatch row={row} ws={ws} select={select} href={href} projectId={projectId} />;
}

function Dispatch({ row, ws, select, href, projectId }: { row: LineDispatchRow; ws: LineViewProps["workspace"]; select: LineViewProps["select"]; href: LineViewProps["href"]; projectId: string }) {
  const { pass, room } = row;
  const now = ws.now;
  const tasks = ws.rows.tasks as unknown as Task[];
  const byRef = new Map(tasks.flatMap((t) => (t.short_id ? [[t.short_id, t] as const] : [])));
  const next = new Set([...pass.resumed, ...pass.started]);
  // How many of the queue the next pass would start: the places, the run limit and the billed money left all bound it.
  const places = row.places - room.running;
  const held = pass.held ?? room.quota_hold;
  const limits: TrialLimits | null = row.on && room.cap_usd != null ? { runs: room.runs, maxRuns: room.max_runs, spent: room.billed.usd, cap: room.cap_usd, perRun: room.per_run_usd ?? 0 } : null;
  const hit = limits ? limitsHit(limits) : null;
  const worst = room.quota.filter((q) => q.percent != null).sort((a, b) => b.percent! - a.percent!)[0] ?? null;
  const problem = (ref: string) => {
    const t = byRef.get(ref);
    return (
      <a className="sd-to" href={t ? href({ view: "problems", case: t._id, run: null, stage: null }) : "#"} onClick={(e) => { if (!t || e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "problems", case: t._id, run: null, stage: null }); }} data-line-due={ref}>
        <span className="lw-mono">{ref}</span> {t ? problemListName({ title: t.title, name: t.cause?.named?.name ?? null }) : ""}
      </a>
    );
  };
  return (
    <div className="sd" data-line-stage="dispatch">
      <StageHead
        title="Dispatch"
        sub={row.on ? `A pass every 10 minutes starts the most-needed due problems${row.last?.at ? ` · last pass ${agoWords(row.last.at, now)} ago` : ""}` : "Off: this trial starts runs only by hand"}
        figures={[
          { label: "Running", n: `${room.running} of ${row.places}`, tone: room.running ? "live" : undefined },
          { label: "Due", n: pass.due.length, tone: pass.due.length ? "you" : "dim" },
          { label: "Runs used", n: room.max_runs != null ? `${room.runs} of ${room.max_runs}` : room.runs, tone: hit?.runs ? "warn" : undefined },
          { label: room.cap_usd != null ? `Billed, cap ${usd(room.cap_usd)}` : "Billed", n: usd(room.billed.usd), tone: hit?.spend ? "warn" : undefined },
          { label: "Billed per run", n: usd(room.per_run_usd) },
          { label: "Quota, worst", n: worst ? `${Math.round(worst.percent!)}%` : "–", tone: room.quota_hold ? "warn" : "dim" },
        ]}
      >
        {held && <p className="sd-alert" data-tone="warn" data-line-dispatch-held><b>Held</b><span>{held}</span></p>}
        <div className="sd-places" role="img" aria-label={`${room.running} of ${row.places} places running`} data-line-places={room.running}>
          {Array.from({ length: row.places }, (_, i) => <i key={i} data-on={i < room.running ? "" : undefined} data-next={i >= room.running && i < room.running + next.size ? "" : undefined} />)}
          <span className="sd-dim">{room.running} running · {Math.max(0, places)} free{next.size ? ` · next pass starts ${next.size}` : ""}</span>
        </div>
        {limits && (hit?.runs || hit?.spend) && <RaiseLimits projectId={projectId} title={ws.projects.find((p) => p._id === projectId)?.title ?? "the trial"} limits={limits} />}
      </StageHead>

      <Section title="Queue" n={pass.due.length} aside={<span className="sd-dim">most live findings first, then severity, then oldest</span>}>
        {pass.due.length ? (
          <div className="sd-scroll"><table className="sd-table" data-line-queue={pass.due.length}>
            <thead><tr><th className="sd-n">#</th><th>Problem</th><th>Route</th><th className="sd-n">Findings</th><th className="sd-n">Severity</th><th>Why due</th><th /></tr></thead>
            <tbody>
              {pass.due.map((d, i) => (
                <tr key={d.task} data-next={next.has(d.task) ? "" : undefined}>
                  <td className="sd-n lw-num sd-dim">{i + 1}</td>
                  <td>{problem(d.task)}</td>
                  <td className="sd-dim">{d.route}</td>
                  <td className="sd-n lw-num">{d.findings}</td>
                  <td className="sd-n lw-num">{d.severity || "–"}</td>
                  <td className="sd-dim">{dueWhy(d)}</td>
                  <td>{next.has(d.task) ? <span className="sd-pill" data-tone="live">next pass</span> : held ? <span className="sd-pill" data-tone="warn">held</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p className="sd-note">Nothing due: every open problem has a run, or no findings</p>}
      </Section>
      {(pass.resumed.length > 0 || pass.gathering.length > 0 || pass.ended.length > 0) && (
        <Section title="Also on the next pass">
          <ul className="sd-list">
            {pass.resumed.map((r) => <li key={`r${r}`} className="sd-row"><span className="sd-pill" data-tone="live">resume at its card</span>{problem(r)}</li>)}
            {pass.gathering.map((c) => <li key={`g${c}`} className="sd-row"><span className="sd-pill" data-tone="judge">sent back to gather</span><span className="lw-mono">{c}</span></li>)}
            {pass.ended.map((r) => <li key={`e${r}`} className="sd-row"><span className="sd-pill" data-tone="dim">ended, problem closed</span>{problem(r)}</li>)}
          </ul>
        </Section>
      )}
      <Section title="Money and quota">
        <div className="sd-split">
          <div data-line-billed>
            <h4>Billed <b className="lw-num">{usd(room.billed.usd)}</b></h4>
            <ul className="sd-kv">
              <li><span>Model calls</span><b className="lw-num">{usd(room.billed.model.usd)}</b></li>
              <li className="sd-sub-kv"><span>judging</span><b className="lw-num">{usd(room.billed.model.by_purpose.judge)}</b></li>
              <li className="sd-sub-kv"><span>grouping</span><b className="lw-num">{usd(room.billed.model.by_purpose.grouping)}</b></li>
              <li className="sd-sub-kv"><span>calls</span><b className="lw-num">{usd(room.billed.model.by_purpose.call)}</b></li>
              {room.billed.keys.map((k) => <li key={k.billed_by}><span>{k.billed_by} · {k.entries} {k.entries === 1 ? "entry" : "entries"}</span><b className="lw-num">{usd(k.usd)}</b></li>)}
              <li><span>Runs on a metered key · {room.billed.run_sessions.sessions} sessions</span><b className="lw-num">{usd(room.billed.run_sessions.usd)}</b></li>
            </ul>
          </div>
          <div data-line-subscription>
            <h4>Subscription <b className="lw-num">{room.subscription.sessions}</b> sessions</h4>
            <ul className="sd-kv">
              <li><span>Tokens</span><b className="lw-num">{tokens(room.subscription.tokens)}</b></li>
              <li><span>At list price (not billed)</span><b className="lw-num sd-dim">{usd(room.subscription.list_usd)}</b></li>
              {room.quota.map((q) => (
                <li key={`${q.device}:${q.account}`}><span>{q.account} · {q.provider}</span><b className="lw-num" data-tone={room.quota_hold && q === worst ? "warn" : undefined}>{q.percent != null ? `${Math.round(q.percent)}%` : "–"}</b></li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
      <Gap what="Run a pass now, lower a limit, turn dispatch off" why="CLI only (cast line trial dispatch)" />
    </div>
  );
}

/** The held trial's one act: lift the run limit and the billed cap together, through the confirm flow. */
function RaiseLimits({ projectId, title, limits }: { projectId: string; title: string; limits: TrialLimits }) {
  const raise = useInboxStore((s) => s.trialRaiseLimits);
  const [pick, setPick] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="lw-act" data-primary="" onClick={() => setPick(RAISE_PICKS[0])} aria-haspopup="dialog" data-line-dispatch-raise>Raise the limits…</button>
      {pick && (
        <SwitchReview
          ledger={raiseLimitsLedger({ project: title, limits, pick })}
          onPick={setPick}
          onClose={() => setPick(null)}
          onConfirm={() => { const next = raisedLimits(limits, Number(pick)); setPick(null); raise(projectId, next.maxRuns, next.cap); }}
        />
      )}
    </>
  );
}
