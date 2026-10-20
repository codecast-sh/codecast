// The Line app's Deploys view (docs/architecture/deploys.md DP7): the shipped
// fixes waiting to go out with the press that sends them together, every
// deploy with what it carried and what happened after, findings per day with
// each deploy marked on them, and one deploy whole beside the list.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Rocket } from "lucide-react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { ageShort } from "../../../../../lib/lineFlow";
import { SwitchReview, type SwitchLedger } from "../../../../consequential/ConsequentialSwitch";
import { activityChart, carriedRows, carriesOf, isOpenDeploy, waitingToGoOut, type ActivityChart, type WaitingGroup } from "../../../../../lib/line/deploysView";
import { deployState, deployTitle, deployTone } from "../../../../../lib/line/deployWords";
import { lineRefHref } from "../../../../../lib/line/lineWorkspaceUrl";
import type { LineDeploy } from "../../../../../hooks/useLineWorkspace";
import type { LineViewProps } from "../types";
import "./deploys.css";

const keyOf = (d: LineDeploy) => d.deploy_id ?? d._id;
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function DeploysView({ workspace, selection, select, href }: LineViewProps) {
  const { deploys, model, now } = workspace;
  const issues = model?.issues ?? [];
  const projectOf = useMemo(() => {
    const m = new Map(workspace.rows.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ?? null]));
    return (id: string) => m.get(id) ?? null;
  }, [workspace.rows.tasks]);
  const projects = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p])), [workspace.projects]);
  // Filtered to one project, its stage always shows, empty or not; over every project, only the lines with something waiting.
  const waiting = useMemo(() => {
    const groups = waitingToGoOut(issues, deploys, projectOf);
    const p = workspace.project;
    if (!p) return groups;
    return [groups.find((g) => g.projectId === p._id) ?? { projectId: p._id, fixes: [], open: null }];
  }, [issues, deploys, projectOf, workspace.project]);
  const done = deploys.filter((d) => !isOpenDeploy(d));
  // One target in view: the rows name the version alone; several: each names its target too.
  const oneTarget = new Set(deploys.map((d) => d.target)).size <= 1;
  const rowName = (d: LineDeploy) => (oneTarget ? (d.sha ? d.sha.slice(0, 7) : d.version ?? d.target) : deployTitle(d));
  const picked = (selection.deploy ? deploys.find((d) => d.short_id === selection.deploy || keyOf(d) === selection.deploy) : null) ?? done[0] ?? deploys[0] ?? null;
  const marked = useMemo(() => deploys.map((d) => ({ ...d, tone: deployTone(d), label: d.short_id || "dp" })), [deploys]);
  const chart = useMemo(() => activityChart(issues, marked, picked, now), [issues, marked, picked, now]);
  const open = (d: LineDeploy) => d.short_id && select({ deploy: d.short_id });

  return (
    <div className="dpv" data-line-deploys>
      <div className="dpv-list" role="navigation" aria-label="Deploys">
        {waiting.map((g) => <WaitingBlock key={g.projectId} group={g} projectTitle={projects.get(g.projectId)?.title ?? null} profileDeploy={projects.get(g.projectId)?.line_profile?.deploy ?? null} showProject={!workspace.project} now={now} onOpen={open} />)}
        <h2 className="dpv-h"><span>Deploys</span><span className="lw-num">{done.length}</span>{oneTarget && done[0] && <span className="dpv-proj">to {done[0].target}</span>}</h2>
        {done.length === 0 && <p className="dpv-none">None recorded</p>}
        <ul className="dpv-rows">
          {done.map((d) => {
            const carried = carriesOf(d, issues).length;
            const tone = deployTone({ ...d, carries: carriesOf(d, issues) });
            return (
              <li key={keyOf(d)}>
                <button type="button" className="dpv-row" aria-current={picked && keyOf(picked) === keyOf(d) ? "true" : undefined} onClick={() => open(d)} data-deploy-row={d.short_id} data-tone={tone}>
                  <span className="dpv-dot" data-tone={tone} aria-hidden />
                  <span className="dpv-id lw-num">{d.short_id}</span>
                  <span className="dpv-target" data-mono={oneTarget ? "" : undefined}>{rowName(d)}</span>
                  <span className="dpv-state" data-tone={tone}>{deployState(d)}</span>
                  <span className="dpv-carried lw-num" title={`${carried} fixes carried`}>{carried ? `${carried} fix${carried === 1 ? "" : "es"}` : ""}</span>
                  <span className="dpv-age lw-num" title={when(d.at)}>{ageShort(now - d.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="dpv-reader">
        <ActivityPlot chart={chart} onPick={(sid) => select({ deploy: sid })} />
        {picked ? <DeployDetail d={picked} issues={issues} now={now} problemHref={(taskId) => href({ view: "problems", case: taskId, run: null })} /> : <p className="dpv-none">No deploy of this line is recorded yet</p>}
      </div>
    </div>
  );
}

/** What waits to go out on one project's line, and the press that sends it. */
function WaitingBlock({ group, projectTitle, profileDeploy, showProject, now, onOpen }: {
  group: WaitingGroup; projectTitle: string | null; profileDeploy: { command: string | null; target: string | null } | null; showProject: boolean; now: number; onOpen: (d: LineDeploy) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useInboxStore((s) => (s.currentUser as { name?: string; _id?: unknown } | null) ?? null);
  const target = profileDeploy?.target ?? "deploy";
  const fixes = group.fixes;
  const ledger: SwitchLedger = {
    name: `Deploy to ${target}`,
    subject: projectTitle ?? "This line",
    shift: null,
    figures: [{ value: String(fixes.length), label: fixes.length === 1 ? "fix goes out" : "fixes go out together", tone: "warn" }],
    rows: [
      { k: "Fixes", v: `${fixes.length}`, list: fixes.map((f) => `${f.ref ?? ""} ${f.title}`.trim()) },
      { k: "Target", v: target, tone: "warn" },
      { k: "Runs", v: profileDeploy?.command ?? "No deploy path" },
      { k: "On", v: "The machine that publishes this line" },
      { k: "To undo", v: "Deploy the previous version" },
    ],
    confirm: `Deploy ${fixes.length} fix${fixes.length === 1 ? "" : "es"}`,
    keep: "Not now",
    ...(profileDeploy?.command ? {} : { blocked: "This line has no deploy path" }),
  };
  const go = async () => {
    setReviewing(false);
    setError(null);
    const key = `deploy:${crypto.randomUUID()}`;
    try {
      await useInboxStore.getState().deployLine(key, group.projectId, {
        target,
        started_by: { kind: "person", name: me?.name ?? "You", ...(me?._id ? { user_id: String(me._id) } : {}) },
        carries: fixes.map((f) => ({ task_id: f.taskId, run_id: f.runId, how: "sent" as const, merge_sha: f.sha, merged_at: f.mergedAt })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="dpv-wait" data-line-deploy-waiting={group.projectId}>
      <h2 className="dpv-h">
        <span>Waiting to go out</span><span className="lw-num" data-tone={fixes.length ? "warn" : undefined}>{fixes.length}</span>
        {showProject && projectTitle && <span className="dpv-proj">{projectTitle}</span>}
      </h2>
      {group.open && (
        <button type="button" className="dpv-row dpv-going" onClick={() => onOpen(group.open!)} data-deploy-row={group.open.short_id} data-tone="live">
          <span className="dpv-dot" data-tone="live" aria-hidden />
          <span className="dpv-id lw-num">{group.open.short_id || "dp"}</span>
          <span className="dpv-target">{deployTitle(group.open)}</span>
          <span className="dpv-state" data-tone="live">{deployState(group.open)}</span>
          <span className="dpv-carried lw-num">{group.open.carries.length} fix{group.open.carries.length === 1 ? "" : "es"}</span>
          <span className="dpv-age lw-num">{ageShort(now - group.open.created_at)}</span>
        </button>
      )}
      {fixes.length > 0 && (
        <ul className="dpv-fixes">
          {fixes.map((f) => (
            <li key={f.runId} className="dpv-fix">
              <Link href={lineRefHref(f.ref ?? f.taskId)} className="dpv-fix-ref lw-num">{f.ref}</Link>
              <span className="dpv-fix-title">{f.title}</span>
              <code className="dpv-sha">{f.sha.slice(0, 7)}</code>
              <span className="dpv-age lw-num" title={`Merged ${when(f.mergedAt)}`}>{ageShort(now - f.mergedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {fixes.length === 0 && !group.open && <p className="dpv-none" data-line-deploy-none>Every shipped fix is live{profileDeploy?.command ? "" : " · no deploy path"}</p>}
      {fixes.length > 0 && !group.open && (
        <div className="dpv-go-row">
          <button type="button" className="dpv-go" onClick={() => setReviewing(true)} disabled={!profileDeploy?.command} data-line-deploy-go>
            <Rocket className="w-3.5 h-3.5" aria-hidden />Deploy to {target}
          </button>
          {!profileDeploy?.command && <span className="dpv-nopath" data-line-deploy-nopath>No deploy path</span>}
        </div>
      )}
      {error && <p className="dpv-error" role="alert">{error}</p>}
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => void go()} />}
    </section>
  );
}

const W = 720;
const H = 132;
const PAD = { l: 28, r: 8, t: 22, b: 18 };

/** Findings per day with every deploy as a marker; the picked deploy's carried problems drawn on their own. */
function ActivityPlot({ chart, onPick }: { chart: ActivityChart; onPick: (shortId: string) => void }) {
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const n = chart.all.length;
  const bw = iw / n;
  const x = (t: number) => PAD.l + ((t - chart.from) / (chart.to - chart.from)) * iw;
  const y = (v: number) => PAD.t + ih - (v / chart.max) * ih;
  const days = Math.round((chart.to - chart.from) / 86_400_000);
  const ticks = Array.from({ length: 5 }, (_, i) => chart.from + ((chart.to - chart.from) * i) / 4);
  return (
    <figure className="dpv-plot" data-line-deploy-chart>
      <figcaption className="dpv-plot-h">
        <span>Findings a day, last {days} days</span>
        <span className="dpv-key"><i data-k="all" />all problems</span>
        {chart.carried && <span className="dpv-key"><i data-k="carried" />what the picked deploy carried</span>}
        <span className="dpv-key"><i data-k="deploy" />deploy</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Findings per day with deploys marked">
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} className="dpv-axis" />
        <text x={PAD.l - 4} y={PAD.t + 4} className="dpv-tick" textAnchor="end">{chart.max}</text>
        {ticks.map((t, i) => <text key={t} x={x(t)} y={H - 4} className="dpv-tick" textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>{new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>)}
        {chart.all.map((v, i) => v > 0 && <rect key={i} x={PAD.l + i * bw + 0.5} y={y(v)} width={Math.max(1, bw - 1)} height={PAD.t + ih - y(v)} className="dpv-bar" />)}
        {chart.carried?.map((v, i) => v > 0 && <rect key={`c${i}`} x={PAD.l + i * bw + 0.5} y={y(v)} width={Math.max(1, bw - 1)} height={PAD.t + ih - y(v)} className="dpv-bar" data-k="carried" />)}
        {chart.deploys.map((d) => (
          <g key={d.id} className="dpv-mark" data-tone={d.tone} data-picked={d.picked ? "" : undefined} onClick={() => d.short_id && onPick(d.short_id)} role="button" aria-label={`${d.short_id}, ${when(d.at)}`}>
            <title>{`${d.short_id} · ${when(d.at)}`}</title>
            <line x1={x(d.at)} x2={x(d.at)} y1={PAD.t - 6} y2={PAD.t + ih} />
            <rect x={x(d.at) - 6} y={0} width={12} height={PAD.t + ih} className="dpv-mark-hit" />
            {d.picked && <text x={Math.min(x(d.at) + 3, W - PAD.r - 30)} y={PAD.t - 9} className="dpv-mark-label">{d.short_id}</text>}
          </g>
        ))}
      </svg>
    </figure>
  );
}

/** One deploy whole: what went out, who started it, and what happened after. */
function DeployDetail({ d, issues, now, problemHref }: { d: LineDeploy; issues: LineViewProps["model"]["issues"]; now: number; problemHref: (taskId: string) => string }) {
  const rows = carriedRows(d, issues);
  const tone = deployTone(d);
  const a = d.after;
  return (
    <article className="dpv-detail" data-line-deploy={d.short_id}>
      <header className="dpv-detail-h">
        <span className="dpv-dot" data-tone={tone} aria-hidden />
        <span className="dpv-detail-id lw-num">{d.short_id}</span>
        <span className="dpv-detail-title">{deployTitle(d)}</span>
        <span className="dpv-state" data-tone={tone}>{deployState(d)}</span>
        {d.url && <a className="dpv-out" href={d.url} target="_blank" rel="noreferrer">Run<ArrowUpRight className="w-3.5 h-3.5" aria-hidden /></a>}
      </header>
      <dl className="dpv-facts">
        <div><dt>When</dt><dd className="lw-num">{when(d.at)}</dd></div>
        <div><dt>Started by</dt><dd>{d.started_by && d.started_by.kind !== "source" ? d.started_by.name : "The team's deploy path"}{d.trigger === "outside" ? <span className="dpv-dim"> · outside the line</span> : d.trigger === "person" ? <span className="dpv-dim"> · from the line</span> : null}</dd></div>
        <div><dt>Reported by</dt><dd>{d.source}</dd></div>
        {d.sha && <div><dt>Commit</dt><dd><code className="dpv-sha">{d.sha.slice(0, 10)}</code>{d.previous_sha && <span className="dpv-dim"> from <code className="dpv-sha">{d.previous_sha.slice(0, 7)}</code></span>}</dd></div>}
        {a && <div><dt>Watched</dt><dd className="lw-num">{ageShort(a.to - a.from)}{a.open ? " so far" : ", to the next deploy"}</dd></div>}
      </dl>
      {d.note && d.status === "failed" && <pre className="dpv-note">{d.note}</pre>}

      <section className="dpv-sec">
        <h3 className="dpv-sec-h">Carried<span className="lw-num">{rows.length}</span></h3>
        {rows.length === 0 ? <p className="dpv-none">No line fix went out in it</p> : (
          <table className="dpv-table">
            <thead><tr><th>Problem</th><th>Shipped by</th><th className="dpv-n">Week before</th><th className="dpv-n">Week after</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.taskId} data-tone={r.findings ? "bad" : "good"}>
                  <td><Link href={problemHref(r.taskId)} className="dpv-link"><span className="lw-num dpv-ref">{r.ref}</span> {r.title}</Link></td>
                  <td>{r.decisionRef ? <Link href={`/decisions/${r.decisionRef}`} className="dpv-link lw-num">{r.decisionRef}</Link> : <span className="dpv-dim">{r.how === "sent" ? "sent" : "merged"}</span>}</td>
                  <td className="dpv-n lw-num">{r.before}</td>
                  <td className="dpv-n lw-num" data-tone={r.findings ? "bad" : "good"}>{r.findings}{r.reopened ? " · reopened" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {a && a.errors.length > 0 && (
        <section className="dpv-sec">
          <h3 className="dpv-sec-h">Errors in its window<span className="lw-num">{a.errors.length}</span></h3>
          <ul className="dpv-errors">
            {a.errors.map((e) => (
              <li key={e.group_id} data-kind={e.kind}>
                <span className="dpv-err-kind">{e.kind === "new" ? "new" : "back"}</span>
                <Link href={`/ops/issues/${e.short_id}`} className="dpv-link"><span className="lw-num dpv-ref">{e.short_id}</span> {e.title}</Link>
                <span className="dpv-age lw-num">{ageShort(Math.max(0, e.at - d.at))} after</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.commits.length > 0 && (
        <section className="dpv-sec">
          <h3 className="dpv-sec-h">Commits<span className="lw-num">{d.commits.length}</span></h3>
          <ul className="dpv-commits">
            {d.commits.slice(0, 40).map((c) => <li key={c.sha}><code className="dpv-sha">{c.sha.slice(0, 7)}</code><span>{c.subject}</span>{c.author && <span className="dpv-dim">{c.author}</span>}</li>)}
          </ul>
        </section>
      )}
      {isOpenDeploy(d) && <p className="dpv-dim dpv-since lw-num">Asked for {ageShort(now - d.created_at)} ago</p>}
    </article>
  );
}
