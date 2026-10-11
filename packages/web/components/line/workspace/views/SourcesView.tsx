"use client";
// Sources (line-workspace.md LW1): where problems come from. Every source the
// line hears from (declared finders, a product's judges, people, lessons, a
// source that filed without being declared) as one row of numbers; a judge
// sits under its product. The selected source (`source` in the URL, else the
// busiest) shows how it runs, which process its problems go through, and its
// findings in their own words, each with the problem it opened or joined.
// j and k walk the sources, n and p the findings, Enter opens the finding's
// problem, e its evidence, Esc steps back out.
import { memo, useMemo, useState } from "react";
import { Activity, AppWindow, ArrowRight, ArrowUpRight, BookOpen, Bug, Eye, FlaskConical, GitBranch, MessageSquareWarning, Radio, User, type LucideIcon } from "lucide-react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { useInboxStore } from "../../../../store/inboxStore";
import { DAY, WEEK, ageShort } from "../../../../lib/lineFlow";
import { graphKeyOf, type GraphRun } from "../../../../lib/line/lineGraphs";
import {
  KIND_WORDS, SPARK_DAYS, buildSources, detailLines, evidenceHost, findingsOf, flatSources, heldSince, humanize, severityOf,
  type SourceFinder, type SourceKind, type SourceRow, type SourceSignal, type SourceState, type SourceTask,
} from "../../../../lib/line/sourcesView";
import { MarkdownRenderer } from "../../../tools/MarkdownRenderer";
import type { LineViewProps } from "./types";
import "./sources.css";

const ICON: Record<SourceKind, LucideIcon> = {
  judge: Eye, person: User, lesson: BookOpen, errors: Bug, eval: FlaskConical, check: Activity, agent: MessageSquareWarning, ci: GitBranch, app: AppWindow, other: Radio,
};
const STATE_WORDS: Record<SourceState, string> = { live: "live", quiet: "quiet", never: "never filed", idle: "" };
/** The signals feed holds a workspace's newest findings up to this many (convex signals LINE_SIGNAL_CAP). */
const SIGNAL_CAP = 1000;
const PAGE = 40;

type Finding = SourceSignal & { short_id?: string };

/** The oldest finding the store holds and how many, as one primitive so the view wakes only when either moves. */
const heldSig = (s: unknown) => {
  const rows = (s as { signals?: Record<string, { created_at: number }> }).signals;
  if (!rows) return "0|";
  let n = 0;
  let oldest = Infinity;
  for (const k in rows) { n++; if (rows[k].created_at < oldest) oldest = rows[k].created_at; }
  return `${n}|${n ? oldest : ""}`;
};

/** Every source in view as rows (lib/line/sourcesView), from the workspace's rows and its projects' declared finders. */
function useSourceRows(workspace: LineViewProps["workspace"]) {
  const { rows: scoped, project, projects, now } = workspace;
  const signals = scoped.signals as unknown as Finding[];
  const runs = scoped.runs as unknown as GraphRun[];
  const finders = useMemo<SourceFinder[]>(
    () => (project ? [project] : projects).flatMap((p) => (p.line_profile?.finders ?? []).map((f) => ({ ...f, projectId: p._id, projectTitle: p.title }))),
    [project, projects],
  );
  const graphNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) if (r.workflow_name) m.set(graphKeyOf(r), r.workflow_name);
    return m;
  }, [runs]);
  const sources = useMemo(() => buildSources({ signals, finders, runs, now, graphNames }), [signals, finders, runs, now, graphNames]);
  return { sources, signals };
}

/** The sources feeding the drawn process, as one row at the head of the Graph: each opens in Sources. */
export function SourcesStrip({ model, workspace, select }: Pick<LineViewProps, "model" | "workspace" | "select">) {
  const { sources } = useSourceRows(workspace);
  const feeding = useMemo(
    () => sources.map((r) => ({ r, n: r.processes.find((p) => p.key === model.graphKey)?.problems ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n),
    [sources, model.graphKey],
  );
  if (!feeding.length) return null;
  // The problems this process ran: an issue's runs are its runs on the drawn graph.
  const total = model.issues.filter((i) => i.runs.length > 0).length;
  return (
    <nav className="lws-strip" aria-label="Sources feeding this process" data-line-sources-strip={feeding.length}>
      <button type="button" className="lws-strip-h" onClick={() => select({ view: "sources", source: null })}>Sources</button>
      {feeding.map(({ r, n }) => {
        const Icon = ICON[r.kind];
        return (
          <button key={r.key} type="button" className="lws-strip-chip" data-state={r.state} onClick={() => select({ view: "sources", source: r.key })} title={`${r.name}: ${n} problems in this process, ${r.week} findings in 7d`} data-line-strip-source={r.key}>
            <Icon className="lws-icon" data-kind={r.kind} aria-hidden />{r.name}<span className="lw-num">{n}</span>
          </button>
        );
      })}
      <ArrowRight className="lws-strip-arrow" aria-hidden />
      <button type="button" className="lws-strip-h" onClick={() => select({ view: "problems", case: null })}><span className="lw-num">{total}</span> problems</button>
    </nav>
  );
}

export function SourcesView({ workspace, selection, select, href, drawerOpen }: LineViewProps) {
  const { rows: scoped, project, projects, now } = workspace;
  const { sources, signals } = useSourceRows(workspace);
  const flat = useMemo(() => flatSources(sources), [sources]);
  const tasks = useMemo(() => new Map((scoped.tasks as unknown as SourceTask[]).map((t) => [t._id, t])), [scoped.tasks]);
  const titles = useMemo(() => new Map(projects.map((p) => [p._id, p.title])), [projects]);

  const held = useInboxStore(heldSig);
  const since = useMemo(() => {
    const [n, oldest] = held.split("|");
    return heldSince(oldest ? Number(oldest) : null, Number(n), SIGNAL_CAP);
  }, [held]);

  const current = flat.find((r) => r.key === selection.source) ?? flat[0] ?? null;
  const findings = useMemo(() => (current ? findingsOf(signals, current) : []), [signals, current]);
  const active = useTabActive();

  const pick = (row: SourceRow) => select({ source: row.key });
  const openProblem = (f: Finding) => f.task_id && select({ view: "problems", case: f.task_id, run: null });

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || drawerOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const si = current ? flat.indexOf(current) : -1;
    const fi = findings.findIndex((f) => f._id === selection.finding);
    const cur = fi >= 0 ? findings[fi] : null;
    if (e.key === "j" && flat.length) { e.preventDefault(); pick(flat[Math.min(flat.length - 1, si + 1)]); }
    else if (e.key === "k" && flat.length) { e.preventDefault(); pick(flat[Math.max(0, si - 1)]); }
    else if (e.key === "n" && findings.length) { e.preventDefault(); select({ source: current?.key ?? null, finding: findings[Math.min(findings.length - 1, fi + 1)]._id }); }
    else if (e.key === "p" && findings.length) { e.preventDefault(); select({ source: current?.key ?? null, finding: findings[Math.max(0, fi - 1)]._id }); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); openProblem(cur); }
    else if (e.key === "e" && cur?.evidence_url) { e.preventDefault(); window.open(cur.evidence_url, "_blank", "noopener"); }
    else if (e.key === "Escape" && (selection.finding || selection.source)) { e.preventDefault(); select(selection.finding ? { finding: null } : { source: null }); }
  });

  if (!flat.length) return <div className="lw-empty" data-line-sources="empty"><b>No sources yet</b>{project ? project.title : "Every project"}</div>;

  return (
    <div className="lws" data-line-sources={sources.length}>
      <div className="lws-list" role="grid" aria-label="Sources">
        <div className="lws-row lws-head" role="row">
          <span role="columnheader">Source</span>
          <span role="columnheader" title={`Findings a day, last ${SPARK_DAYS} days`}>{SPARK_DAYS}d</span>
          <span role="columnheader" className="lws-n">24h</span>
          <span role="columnheader" className="lws-n">7d</span>
          <span role="columnheader" className="lws-n">Last</span>
          <span role="columnheader" className="lws-n" title="New problems its findings opened">New</span>
          <span role="columnheader" className="lws-n" title="Existing problems it added findings to">Added to</span>
          <span role="columnheader">Goes to</span>
        </div>
        {sources.map((r) => (
          <div key={r.key} role="rowgroup">
            <SourceLine row={r} selected={current?.key === r.key} since={since} now={now} onPick={pick} />
            {r.children.map((c) => <SourceLine key={c.key} row={c} child selected={current?.key === c.key} since={since} now={now} onPick={pick} />)}
          </div>
        ))}
      </div>
      {current && (
        <SourceDetail
          row={current}
          parent={current.judge != null ? sources.find((s) => s.source === current.source) ?? null : null}
          findings={findings}
          tasks={tasks}
          titles={project ? null : titles}
          since={since}
          now={now}
          selection={selection}
          select={select}
          href={href}
        />
      )}
    </div>
  );
}

const SourceLine = memo(function SourceLine({ row: r, child, selected, since, now, onPick }: { row: SourceRow; child?: boolean; selected: boolean; since: number | null; now: number; onPick: (r: SourceRow) => void }) {
  const Icon = ICON[r.kind];
  const partialWeek = since != null && since > now - WEEK;
  const top = r.processes[0];
  return (
    <button type="button" role="row" className="lws-row" data-child={child ? "" : undefined} data-state={r.state} aria-selected={selected} onClick={() => onPick(r)} data-line-source={r.key}>
      <span className="lws-name" role="cell">
        {child ? <span className="lws-tree" aria-hidden /> : <Icon className="lws-icon" data-kind={r.kind} aria-label={KIND_WORDS[r.kind]} />}
        <b>{r.name}</b>
        {!child && <code>{r.source}</code>}
        {r.undeclared && <span className="lws-tag" data-tone="plum" title="Filed into a project whose profile does not declare it">undeclared</span>}
      </span>
      <span role="cell"><Spark days={r.spark} since={since} now={now} /></span>
      <span role="cell" className="lws-n" data-zero={r.day ? undefined : ""}>{r.day}</span>
      <span role="cell" className="lws-n" data-zero={r.week ? undefined : ""} title={partialWeek ? `The line holds findings back to ${ageShort(now - (since ?? now))} ago` : undefined}>{partialWeek && r.week ? "≥" : ""}{r.week}</span>
      <span role="cell" className="lws-n lws-last" data-state={r.state}>
        {r.newest ? ageShort(now - r.newest) : "never"}
      </span>
      <span role="cell" className="lws-n" data-zero={r.opened ? undefined : ""}>{r.opened}</span>
      <span role="cell" className="lws-n" data-zero={r.joined ? undefined : ""}>{r.joined}</span>
      <span role="cell" className="lws-goes" title={r.processes.map((p) => `${p.title} ${p.problems}`).concat(r.notRun ? [`no process ${r.notRun}`] : []).join(", ")}>
        {top ? <><span className="lws-goes-t">{top.title}</span><span className="lws-goes-n">{top.problems}</span></> : r.notRun ? <span className="lws-goes-none" title={`${r.notRun} problems no process has run`}>No process</span> : null}
        {r.processes.length > 1 && <span className="lws-goes-more">+{r.processes.length - 1}</span>}
      </span>
    </button>
  );
});

/** Findings a day as bars; the days before the line's held window are hatched, not zero. */
function Spark({ days, since, now, big }: { days: number[]; since: number | null; now: number; big?: boolean }) {
  const W = big ? 280 : 84;
  const H = big ? 40 : 18;
  const bw = W / days.length;
  const max = Math.max(1, ...days);
  const t0 = now - days.length * DAY;
  const cut = since != null && since > t0 ? Math.min(W, ((since - t0) / (days.length * DAY)) * W) : 0;
  return (
    <svg className="lws-spark" data-big={big ? "" : undefined} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${days.reduce((a, b) => a + b, 0)} in ${days.length} days`}>
      {cut > 0 && <rect x={0} y={0} width={cut} height={H} className="lws-spark-unheld"><title>Older findings are not held here</title></rect>}
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="lws-spark-base" />
      {days.map((n, i) => n > 0 && (
        <rect key={i} x={i * bw + 0.5} width={Math.max(1, bw - 1.5)} y={H - 1 - (n / max) * (H - 3)} height={(n / max) * (H - 3)} rx={1} className="lws-spark-bar" data-today={i === days.length - 1 ? "" : undefined}>
          {big && <title>{n} on {new Date(t0 + (i + 1) * DAY - 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</title>}
        </rect>
      ))}
    </svg>
  );
}

type DetailProps = Pick<LineViewProps, "selection" | "select" | "href"> & {
  row: SourceRow;
  parent: SourceRow | null;
  findings: Finding[];
  tasks: Map<string, SourceTask>;
  /** Project titles, when the line shows every project (a finding names its project). */
  titles: Map<string, string> | null;
  since: number | null;
  now: number;
};

function SourceDetail({ row: r, parent, findings, tasks, titles, since, now, selection, select, href }: DetailProps) {
  const [shown, setShown] = useState(PAGE);
  useWatchEffect(() => setShown(PAGE), [r.key]);
  const Icon = ICON[r.kind];
  const finders = r.finders.length ? r.finders : parent?.finders ?? [];
  const judges = r.children.length ? r.children : parent?.children ?? [];
  const partialWeek = since != null && since > now - WEEK;
  return (
    <section className="lws-detail" aria-label={r.name} data-line-source-detail={r.key}>
      <header className="lws-d-head">
        <Icon className="lws-icon" data-kind={r.kind} aria-hidden />
        <h2>{parent ? <><button type="button" className="lws-crumb" onClick={() => select({ source: parent.key })}>{parent.name}</button><span className="lws-crumb-sep">/</span></> : null}{r.name}</h2>
        <span className="lws-tag">{KIND_WORDS[r.kind]}</span>
        {STATE_WORDS[r.state] && <span className="lws-tag" data-state={r.state}>{STATE_WORDS[r.state]}</span>}
        {r.undeclared && <span className="lws-tag" data-tone="plum">undeclared</span>}
        <code className="lws-d-src">{r.source}{r.judge ? ` · judge ${r.judge}` : ""}</code>
      </header>

      <div className="lws-stats">
        <Stat n={r.day} label="24h" />
        <Stat n={r.week} label="7d" plus={partialWeek && r.week > 0} />
        <Stat n={r.newest ? ageShort(now - r.newest) : "never"} label="last" tone={r.state === "quiet" || r.state === "never" ? "warn" : undefined} />
        <Stat n={r.opened} label="new problems" />
        <Stat n={r.joined} label="added to" />
      </div>

      {(r.processes.length > 0 || r.notRun > 0) && (
        <div className="lws-d-row">
          <span className="lws-d-k">Goes to</span>
          <div className="lws-chips">
            {r.processes.map((p) => (
              <a key={p.key} className="lws-chip" href={href({ view: "process", graph: p.key })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "process", graph: p.key }); }} data-line-source-process={p.key}>
                {p.title}<span className="lw-num">{p.problems}</span>
              </a>
            ))}
            {r.notRun > 0 && <span className="lws-chip" data-quiet="" title="Problems no process has run">No process<span className="lw-num">{r.notRun}</span></span>}
          </div>
        </div>
      )}

      {judges.length > 0 && (
        <div className="lws-d-row">
          <span className="lws-d-k">Judges</span>
          <div className="lws-chips">
            {judges.map((j) => (
              <button key={j.key} type="button" className="lws-chip" aria-pressed={j.key === r.key} onClick={() => select({ source: j.key })} data-state={j.state}>
                {j.name}<span className="lw-num">{j.week}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {finders.length > 0 && (
        <div className="lws-decl" data-line-source-finders={finders.length}>
          {finders.map((f) => (
            <div key={`${f.projectId}:${f.id}`} className="lws-decl-row">
              <span className="lws-decl-id">{f.id}</span>
              {titles && <span className="lws-decl-proj">{f.projectTitle}</span>}
              <span className="lws-decl-k">files</span><span className="lws-decl-v">{f.kind === "any" ? "anything" : f.kind.map(humanize).join(", ").toLowerCase()}</span>
              <span className="lws-decl-k">groups by</span><code className="lws-decl-v">{f.fingerprint}</code>
              {f.runs && <><span className="lws-decl-k">runs</span><span className="lws-decl-v lws-decl-runs" title={f.runs}>{f.runs}</span></>}
            </div>
          ))}
        </div>
      )}

      <div className="lws-f-head"><b>Findings</b><span className="lw-num">{findings.length}</span></div>
      <ol className="lws-findings" data-line-findings={findings.length}>
        {findings.slice(0, shown).map((f) => (
          <FindingItem
            key={f._id}
            f={f}
            task={f.task_id ? tasks.get(f.task_id) ?? null : null}
            project={titles && f.project_id ? titles.get(f.project_id) ?? null : null}
            showJudge={r.judge == null}
            open={selection.finding === f._id}
            now={now}
            onToggle={() => select({ source: r.key, finding: selection.finding === f._id ? null : f._id })}
            problemHref={f.task_id ? href({ view: "problems", case: f.task_id, run: null }) : null}
            onProblem={() => f.task_id && select({ view: "problems", case: f.task_id, run: null })}
          />
        ))}
      </ol>
      {findings.length > shown && <button type="button" className="lws-more" onClick={() => setShown((n) => n + PAGE * 2)}>{Math.min(PAGE * 2, findings.length - shown)} more of {findings.length - shown}</button>}
    </section>
  );
}

function Stat({ n, label, plus, tone }: { n: number | string; label: string; plus?: boolean; tone?: "warn" }) {
  return <div className="lws-stat" data-tone={tone}><b className="lw-num">{plus ? "≥" : ""}{n}</b><span>{label}</span></div>;
}

type FindingProps = {
  f: Finding; task: SourceTask | null; project: string | null; showJudge: boolean; open: boolean; now: number;
  onToggle: () => void; problemHref: string | null; onProblem: () => void;
};

const FindingItem = memo(function FindingItem({ f, task, project, showJudge, open, now, onToggle, problemHref, onProblem }: FindingProps) {
  const sev = severityOf(f);
  const lines = useMemo(() => (open ? [] : detailLines(f.detail_md, f.title)), [open, f.detail_md, f.title]);
  const host = evidenceHost(f.evidence_url);
  const opened = f.attach === "new";
  return (
    <li className="lws-f" aria-current={open ? "true" : undefined} data-line-finding={f._id}>
      <button type="button" className="lws-f-main" onClick={onToggle} aria-expanded={open}>
        <span className="lws-f-top">
          {sev != null && <span className="lws-sev" data-high={sev >= 7 ? "" : undefined} title="Severity the judge rated, out of 10">{sev}<small>/10</small></span>}
          {showJudge && f.judge && <span className="lws-tag">{humanize(f.judge)}</span>}
          <span className="lws-tag" data-quiet="">{humanize(f.kind).toLowerCase()}</span>
          <b className="lws-f-title">{f.title}</b>
          <span className="lws-f-age lw-num" title={new Date(f.created_at).toLocaleString()}>{ageShort(now - f.created_at)}</span>
        </span>
        {lines.length > 0 && <span className="lws-f-text">{lines.map((l, i) => <span key={i}>{l}</span>)}</span>}
      </button>
      {open && f.detail_md && <div className="lws-f-full"><MarkdownRenderer content={f.detail_md} /></div>}
      <span className="lws-f-foot">
        {problemHref && (
          <a className="lws-f-problem" href={problemHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onProblem(); }} data-line-finding-problem={f.task_id}>
            <span className="lws-f-verb" data-opened={opened ? "" : undefined}>{opened ? "opened" : "joined"}</span>
            <span className="lws-f-ref">{task?.short_id ?? "problem"}</span>
            <span className="lws-f-ptitle">{task?.title ?? ""}</span>
            {task && <span className="lws-f-status">{task.status.replace(/_/g, " ")}</span>}
          </a>
        )}
        {project && <span className="lws-f-proj">{project}</span>}
        {f.short_id && <span className="lws-f-id">{f.short_id}</span>}
        {host && f.evidence_url && <a className="lws-f-ev" href={f.evidence_url} target="_blank" rel="noreferrer" title={f.evidence_url}>{host}<ArrowUpRight aria-hidden /></a>}
      </span>
    </li>
  );
});
