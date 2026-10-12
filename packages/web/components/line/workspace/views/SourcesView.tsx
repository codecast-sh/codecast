"use client";
// Sources (line-workspace.md LW1): where problems come from. Every source the
// line hears from (declared finders, a product's judges, people, lessons, a
// source that filed without being declared) as one row of numbers; a judge
// sits under its product. The selected source (`source` in the URL, else the
// busiest) shows how it runs, which process its problems go through, and its
// findings in their own words, each with the problem it opened or joined.
// j and k walk the sources, n and p the findings, Enter opens the finding's
// problem, e its evidence, Esc steps back out.
import { memo, useCallback, useMemo, useState } from "react";
import { Activity, AppWindow, ArrowRight, ArrowUpRight, ChevronRight, BookOpen, Bug, Eye, FlaskConical, GitBranch, MessageSquareWarning, Radio, User, type LucideIcon } from "lucide-react";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { DAY, WEEK, ageShort } from "../../../../lib/lineFlow";
import { graphKeyOf, type GraphRun } from "../../../../lib/line/lineGraphs";
import {
  KIND_WORDS, SPARK_DAYS, buildSources, findingBreak, findingFacts, readableDetail, evidenceHost, findingProcess, filedSources, findingsOf, flatSources, groupsByWords, heldSince, humanize, severityOf, startsWords,
  type SourceFinder, type SourceKind, type SourceRow, type SourceSignal, type SourceState, type SourceTask,
} from "../../../../lib/line/sourcesView";
import { MarkdownRenderer } from "../../../tools/MarkdownRenderer";
import { MomentView } from "../../widgets/MomentView";
import { lineSettingsHref } from "../../../../lib/lineSettings";
import { setLineOn } from "../../map/useLineAdmission";
import { closeOutcome, closeOutcomeWord } from "../../../../lib/line/scriptReport";

/** A quote's day, as its label: "Oct 10". */
const dayShort = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
import type { LineViewProps } from "./types";
import "./sources.css";

const ICON: Record<SourceKind, LucideIcon> = {
  judge: Eye, person: User, lesson: BookOpen, errors: Bug, eval: FlaskConical, check: Activity, agent: MessageSquareWarning, ci: GitBranch, app: AppWindow, other: Radio,
};
const STATE_WORDS: Record<SourceState, string> = { live: "live", quiet: "quiet", never: "never filed", idle: "" };
/** The signals feed holds a workspace's newest findings up to this many (convex signals LINE_SIGNAL_CAP). */
const SIGNAL_CAP = 1000;
const PAGE = 40;

/** `moment` and `subject` on a codecast judge's finding: the moment it read and the expectation it cites. */
type Finding = SourceSignal & { short_id?: string; moment?: string; subject?: string };

/** Every source in view as rows (lib/line/sourcesView), from the workspace's rows and its projects' declared finders. */
function useSourceRows(workspace: LineViewProps["workspace"]) {
  const { rows: scoped, project, projects, now, graphKey, process } = workspace;
  const runs = scoped.runs as unknown as GraphRun[];
  // The process picked scopes its sources (processIndex): a finding counts when its problem belongs to that process, one
  // with no problem yet by its project; a declared finder, when its project's work runs there.
  const signals = useMemo(() => {
    const all = scoped.signals as unknown as Finding[];
    return graphKey ? all.filter((f) => findingProcess(process, f) === graphKey) : all;
  }, [scoped.signals, process, graphKey]);
  const finders = useMemo<SourceFinder[]>(
    () => (project ? [project] : projects).filter((p) => !graphKey || process.project(p._id) === graphKey).flatMap((p) => (p.line_profile?.finders ?? []).map((f) => ({ ...f, projectId: p._id, projectTitle: p.title }))),
    [project, projects, process, graphKey],
  );
  const graphNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runs) if (r.workflow_name) m.set(graphKeyOf(r), r.workflow_name);
    return m;
  }, [runs]);
  const sources = useMemo(() => buildSources({ signals, finders, runs, now, graphNames }), [signals, finders, runs, now, graphNames]);
  // Those that filed in the window (filedSources, the nav's own count), then the rest, listed apart and quiet.
  const filed = useMemo(() => filedSources(signals, now), [signals, now]);
  const ordered = useMemo(() => [...sources.filter((r) => filed.has(r.source.toLowerCase())), ...sources.filter((r) => !filed.has(r.source.toLowerCase()))], [sources, filed]);
  const hasFiled = useCallback((r: Pick<SourceRow, "source">) => filed.has(r.source.toLowerCase()), [filed]);
  return { sources: ordered, signals, hasFiled };
}

/** The sources feeding the drawn process, as one row at the head of the Graph: each opens in Sources. */
export function SourcesStrip({ model, workspace, select }: Pick<LineViewProps, "model" | "workspace" | "select">) {
  const { sources } = useSourceRows(workspace);
  const feeding = useMemo(
    () => sources.map((r) => ({ r, n: r.processes.find((p) => p.key === model.graphKey)?.problems ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n),
    [sources, model.graphKey],
  );
  if (!feeding.length) return null;
  // The same count the nav's Problems shows: every problem of this process not closed.
  const total = workspace.open;
  return (
    <nav className="lws-strip" aria-label="Sources feeding this process" data-line-sources-strip={feeding.length}>
      <button type="button" className="lws-strip-h" onClick={() => select({ view: "sources", source: null })} title="Findings in the last 7 days">Sources <small className="lws-strip-k">7d</small></button>
      {feeding.map(({ r, n }) => {
        const Icon = ICON[r.kind];
        return (
          <button key={r.key} type="button" className="lws-strip-chip" data-state={r.state} onClick={() => select({ view: "sources", source: r.key })} title={`${r.name}: ${r.week} findings in 7d, ${n} problems in this process`} data-line-strip-source={r.key}>
            <Icon className="lws-icon" data-kind={r.kind} aria-hidden />{r.name}<span className="lw-num">{r.week}</span>
          </button>
        );
      })}
      <ArrowRight className="lws-strip-arrow" aria-hidden />
      <button type="button" className="lws-strip-h" onClick={() => select({ view: "problems", case: null })}><span className="lw-num">{total}</span> active problems</button>
    </nav>
  );
}

export function SourcesView({ model, workspace, selection, select, href, drawerOpen }: LineViewProps) {
  const { rows: scoped, project, projects, now } = workspace;
  const { sources, signals, hasFiled } = useSourceRows(workspace);
  const flat = useMemo(() => flatSources(sources), [sources]);
  // Problems a run closed as the judge's own mistake, counted per source and judge: a judge that is often wrong shows red.
  const wrongBy = useMemo(() => {
    const wrongCases = new Set(model.runs.filter((r) => r.caseId && (closeOutcome(r.visits)?.word === "judge wrong" || r.visits.some((v) => !v.inferred && v.decided.outcome && closeOutcomeWord(v.decided.outcome) === "judge wrong"))).map((r) => r.caseId!));
    const out = new Map<string, number>();
    if (!wrongCases.size) return out;
    for (const row of flat) out.set(row.key, new Set(findingsOf(signals, row).map((f) => f.task_id).filter((t): t is string => !!t && wrongCases.has(t))).size);
    return out;
  }, [model.runs, flat, signals]);
  const tasks = useMemo(() => new Map((scoped.tasks as unknown as SourceTask[]).map((t) => [t._id, t])), [scoped.tasks]);
  const titles = useMemo(() => new Map(projects.map((p) => [p._id, p.title])), [projects]);

  // Where the held window starts, when the feed's cap cut it short: read off the rows in view, never the whole store.
  const since = useMemo(() => {
    let oldest = Infinity;
    for (const f of scoped.signals) if (f.created_at < oldest) oldest = f.created_at;
    return heldSince(scoped.signals.length ? oldest : null, scoped.signals.length, SIGNAL_CAP);
  }, [scoped.signals]);
  const firstQuiet = sources.findIndex((r) => !hasFiled(r));
  // Declared sources that never filed sit folded under one header: the table's rows are the ones the nav counts.
  const [showQuiet, setShowQuiet] = useState(false);

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
          <span role="columnheader" className="lws-n" title="Existing problems it added findings to">Joined</span>
          <span role="columnheader" className="lws-n" title="Its problems a run closed as the judge's own mistake">Wrong</span>
        </div>
        {sources.map((r, i) => (firstQuiet >= 0 && i > firstQuiet && !showQuiet && current?.key !== r.key) ? null : (
          <div key={r.key} role="rowgroup" data-quiet={hasFiled(r) ? undefined : ""}>
            {i === firstQuiet && (
              <button type="button" className="lws-group-h" aria-expanded={showQuiet} onClick={() => setShowQuiet(!showQuiet)} data-line-sources-quiet>
                <ChevronRight className="lws-group-chev" aria-hidden /><span>Quiet 14d</span><span className="lw-num">{sources.length - firstQuiet}</span>
              </button>
            )}
            {(i !== firstQuiet || showQuiet || current?.key === r.key) && <SourceLine row={r} selected={current?.key === r.key} since={since} now={now} onPick={pick} wrong={wrongBy.get(r.key) ?? 0} />}
            {(hasFiled(r) || showQuiet) && r.children.map((c) => <SourceLine key={c.key} row={c} child selected={current?.key === c.key} since={since} now={now} onPick={pick} wrong={wrongBy.get(c.key) ?? 0} />)}
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
          admissions={workspace.admissions}
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

const SourceLine = memo(function SourceLine({ row: r, child, selected, since, now, onPick, wrong }: { row: SourceRow; child?: boolean; selected: boolean; since: number | null; now: number; onPick: (r: SourceRow) => void; wrong: number }) {
  const Icon = ICON[r.kind];
  const partialWeek = since != null && since > now - WEEK;
  return (
    <button type="button" role="row" className="lws-row" data-child={child ? "" : undefined} data-state={r.state} aria-selected={selected} onClick={() => onPick(r)} data-line-source={r.key}>
      <span className="lws-name" role="cell">
        {child ? <span className="lws-tree" aria-hidden /> : <Icon className="lws-icon" data-kind={r.kind} aria-label={KIND_WORDS[r.kind]} />}
        <b>{r.name}</b>
        {!child && <code>{r.source}</code>}
      </span>
      <span role="cell"><Spark days={r.spark} since={since} now={now} /></span>
      <span role="cell" className="lws-n" data-zero={r.day ? undefined : ""}>{r.day}</span>
      <span role="cell" className="lws-n" data-zero={r.week ? undefined : ""} title={partialWeek && r.week ? `Held back to ${ageShort(now - (since ?? now))} ago` : undefined}>{r.week}</span>
      <span role="cell" className="lws-n lws-last" data-state={r.state}>
        {r.newest ? ageShort(now - r.newest) : "never"}
      </span>
      <span role="cell" className="lws-n" data-zero={r.opened ? undefined : ""}>{r.opened}</span>
      <span role="cell" className="lws-n" data-zero={r.joined ? undefined : ""}>{r.joined}</span>
      <span role="cell" className="lws-n" data-zero={wrong ? undefined : ""} data-tone={wrong ? "bad" : undefined} title={wrong ? `${wrong} of its problems closed as the judge's mistake` : undefined} data-line-source-wrong={wrong}>{wrong}</span>
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
  /** Each project's auto-start (useLineAdmissions): whether the line would start this source's waiting problems. */
  admissions: LineViewProps["workspace"]["admissions"];
  since: number | null;
  now: number;
};

function SourceDetail({ row: r, parent, findings, tasks, titles, admissions, since, now, selection, select, href }: DetailProps) {
  const [shown, setShown] = useState(PAGE);
  // Findings narrowed to new or joined, or to the problem they joined: the chips count each, the busiest problems first.
  const [fil, setFil] = useState<{ attach?: "new" | "joined"; task?: string }>({});
  useWatchEffect(() => { setShown(PAGE); setFil({}); }, [r.key]);
  const byAttach = useMemo(() => ({ new: findings.filter((f) => f.attach === "new").length, joined: findings.filter((f) => f.task_id && f.attach !== "new").length }), [findings]);
  const byTask = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of findings) if (f.task_id) n.set(f.task_id, (n.get(f.task_id) ?? 0) + 1);
    return [...n].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [findings]);
  const shownFindings = useMemo(() => findings.filter((f) => (!fil.task || f.task_id === fil.task) && (!fil.attach || (fil.attach === "new" ? f.attach === "new" : !!f.task_id && f.attach !== "new"))), [findings, fil]);
  // A finding picked past the page (n, p, a link) is drawn: the page grows to hold it, and it scrolls into view.
  const picked = shownFindings.findIndex((f) => f._id === selection.finding);
  const limit = Math.max(shown, picked + 1);
  useWatchEffect(() => {
    if (!selection.finding) return;
    const el = [...document.querySelectorAll<HTMLElement>("[data-line-finding]")].find((x) => x.dataset.lineFinding === selection.finding);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selection.finding]);
  const Icon = ICON[r.kind];
  const finders = r.finders.length ? r.finders : parent?.finders ?? [];
  const judges = r.children.length ? r.children : parent?.children ?? [];
  // The line off where this source files: its waiting problems start only when someone turns it on.
  const off = r.projects.map((p) => admissions.get(p)).filter((a): a is NonNullable<typeof a> => !!a?.role && !a.on);
  const lineOff = r.notRun > 0 && !r.projects.some((p) => admissions.get(p)?.on);
  // What every finding here shares (one judge, one kind) is said once, in the header, never on each card.
  const sameJudge = findings.length > 0 && findings.every((f) => (f.judge ?? null) === (findings[0].judge ?? null));
  const sameKind = findings.length > 0 && findings.every((f) => f.kind === findings[0].kind);
  return (
    <section className="lws-detail" aria-label={r.name} data-line-source-detail={r.key}>
      <header className="lws-d-head">
        <Icon className="lws-icon" data-kind={r.kind} aria-hidden />
        <h2>{parent ? <><button type="button" className="lws-crumb" onClick={() => select({ source: parent.key })}>{parent.name}</button><span className="lws-crumb-sep">/</span></> : null}{r.name}</h2>
        <span className="lws-tag">{KIND_WORDS[r.kind]}</span>
        {STATE_WORDS[r.state] && <span className="lws-tag" data-state={r.state}>{STATE_WORDS[r.state]}</span>}
        {r.undeclared && <a className="lws-tag" data-tone="plum" href={lineSettingsHref({})} title="Filed into a project whose line profile does not declare it: declare it in settings">not in profile</a>}
        <code className="lws-d-src">{r.source}{r.judge ? ` · judge ${r.judge}` : ""}</code>
      </header>

      <div className="lws-stats">
        <Stat n={r.day} label="24h" />
        <Stat n={r.week} label="7d" />
        <Stat n={r.newest ? ageShort(now - r.newest) : "never"} label="last" tone={r.state === "quiet" ? "warn" : undefined} />
        <Stat n={r.opened} label="new problems" />
        <Stat n={r.joined} label="added to" />
        {lineOff && (
          <div className="lws-stat lws-off" data-tone="warn" data-line-source-off>
            <b className="lw-num">{r.notRun}</b><span>queued · line off</span>
            {off.length > 0
              ? <button type="button" className="lw-act" data-primary="" onClick={() => { for (const a of off) setLineOn(a.role!.id, true); }} data-line-source-turn-on>Turn on</button>
              : <a className="lw-act" href={lineSettingsHref(r.projects.length === 1 ? { project: r.projects[0] } : {})} title="No role starts this project's line" data-line-source-no-lead>No lead</a>}
          </div>
        )}
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
            {r.notRun > 0 && !lineOff && <span className="lws-chip" data-quiet="" title="Problems from this source no run has taken yet">waiting to start<span className="lw-num">{r.notRun}</span></span>}
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
          {finders.map((f) => {
            const starts = startsWords(f.runs);
            return (
              <dl key={`${f.projectId}:${f.id}`} className="lws-decl-row" title={`${f.id}: ${f.fingerprint}${f.runs ? `\n${f.runs}` : ""}`}>
                <div><dt>Finder</dt><dd>{humanize(f.id)}{titles && <small>{f.projectTitle}</small>}</dd></div>
                <div><dt>Files</dt><dd>{f.kind === "any" ? "anything" : f.kind.map(humanize).join(", ").toLowerCase()}</dd></div>
                <div><dt>Groups by</dt><dd>{groupsByWords(f.fingerprint)}</dd></div>
                {starts && <div><dt>Starts</dt><dd>{starts.when}</dd></div>}
              </dl>
            );
          })}
        </div>
      )}

      <div className="lws-f-head">
        <b>Findings</b>
        <div className="lws-chips" role="group" aria-label="Filter findings">
          <button type="button" className="lws-chip" aria-pressed={!fil.attach && !fil.task} onClick={() => setFil({})}>All<span className="lw-num">{findings.length}</span></button>
          <button type="button" className="lws-chip" aria-pressed={fil.attach === "new"} disabled={!byAttach.new} onClick={() => setFil(fil.attach === "new" ? {} : { attach: "new" })}>New<span className="lw-num">{byAttach.new}</span></button>
          <button type="button" className="lws-chip" aria-pressed={fil.attach === "joined"} disabled={!byAttach.joined} onClick={() => setFil(fil.attach === "joined" ? {} : { attach: "joined" })}>Joined<span className="lw-num">{byAttach.joined}</span></button>
          {byTask.map(([id, n]) => (
            <button key={id} type="button" className="lws-chip" aria-pressed={fil.task === id} onClick={() => setFil(fil.task === id ? {} : { task: id })} title={tasks.get(id)?.title} data-line-findings-problem={id}>
              <span className="lw-mono">{tasks.get(id)?.short_id ?? "problem"}</span><span className="lw-num">{n}</span>
            </button>
          ))}
        </div>
      </div>
      <ol className="lws-findings" data-line-findings={shownFindings.length}>
        {shownFindings.slice(0, limit).map((f) => (
          <FindingItem
            key={f._id}
            f={f}
            task={f.task_id ? tasks.get(f.task_id) ?? null : null}
            project={titles && f.project_id ? titles.get(f.project_id) ?? null : null}
            showJudge={r.judge == null && !sameJudge}
            showKind={!sameKind}
            open={selection.finding === f._id}
            now={now}
            onToggle={() => select({ source: r.key, finding: selection.finding === f._id ? null : f._id })}
            problemHref={f.task_id ? href({ view: "problems", case: f.task_id, run: null }) : null}
            onProblem={() => f.task_id && select({ view: "problems", case: f.task_id, run: null })}
          />
        ))}
      </ol>
      {shownFindings.length > limit && <button type="button" className="lws-more" onClick={() => setShown(limit + PAGE * 2)}>{Math.min(PAGE * 2, shownFindings.length - limit)} more of {shownFindings.length - limit}</button>}
    </section>
  );
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: "warn" }) {
  return <div className="lws-stat" data-tone={tone}><b className="lw-num">{n}</b><span>{label}</span></div>;
}

type FindingProps = {
  f: Finding; task: SourceTask | null; project: string | null; showJudge: boolean; showKind: boolean; open: boolean; now: number;
  onToggle: () => void; problemHref: string | null; onProblem: () => void;
};

const FindingItem = memo(function FindingItem({ f, task, project, showJudge, showKind, open, now, onToggle, problemHref, onProblem }: FindingProps) {
  const sev = severityOf(f);
  const { facts, said, notes } = useMemo(() => findingFacts(f.detail_md ? readableDetail(f.detail_md, now) : f.detail_md, f.title), [f.detail_md, f.title, now]);
  const [more, setMore] = useState(false);
  const host = evidenceHost(f.evidence_url);
  const opened = f.attach === "new";
  // The reporter's own words, else the finder's note: the one prose a card carries, whole once opened.
  const prose = said ?? (notes.length ? notes.join(" ") : null);
  // The row leads with what broke (the judge's note); the setup its title tells sits under it, dim.
  const broke = findingBreak(notes);
  return (
    <li className="lws-f" aria-current={open ? "true" : undefined} data-line-finding={f._id} title={[f.short_id, f.moment].filter(Boolean).join(" · ") || undefined}>
      <button type="button" className="lws-f-main" onClick={onToggle} aria-expanded={open}>
        <span className="lws-f-top">
          {sev != null && <span className="lws-sev" data-tone={sev >= 7 ? "hi" : sev >= 4 ? "mid" : "lo"} title={`Severity ${sev} of 10: higher is worse`}><span className="lws-sev-bar"><i style={{ width: `${Math.min(100, sev * 10)}%` }} /></span><span className="lw-num">{sev}</span></span>}
          {showJudge && f.judge && <span className="lws-tag">{humanize(f.judge)}</span>}
          {showKind && <span className="lws-tag" data-quiet="">{humanize(f.kind).toLowerCase()}</span>}
          <b className="lws-f-title" title={broke ? f.title : undefined}>{broke ?? f.title}</b>
          <span className="lws-f-age lw-num" title={new Date(f.created_at).toLocaleString()}>{ageShort(now - f.created_at)}</span>
        </span>
        {broke && <span className="lws-f-setup">{f.title}</span>}
        {facts.length > 0 && (
          <span className="lws-f-facts">
            {facts.map((x, i) => <span key={i} className="lws-fact" title={x.title}>{x.k && <span className="lws-fact-k">{x.k}</span>}<span className="lws-fact-v">{x.v}</span></span>)}
          </span>
        )}
        {prose && !open && <span className="lws-f-said" data-quote={said ? "" : undefined}>{said && <span className="lws-f-said-k">{dayShort(f.observed_at ?? f.created_at)}</span>}{prose}</span>}
      </button>
      {open && f.moment && <div className="lws-f-moment"><MomentView moment={f.moment} cited={f.subject} /></div>}
      {open && !f.moment && (prose || f.detail_md) && (
        <div className="lws-f-full">
          {prose ? <p className="lws-f-said-full" data-quote={said ? "" : undefined}>{prose}</p> : null}
          {f.detail_md && (more
            ? <MarkdownRenderer content={readableDetail(f.detail_md, now)} />
            : <button type="button" className="lws-more" onClick={() => setMore(true)}>Whole text</button>)}
        </div>
      )}
      <span className="lws-f-foot">
        {problemHref && (
          <a className="lws-f-problem" href={problemHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onProblem(); }} data-line-finding-problem={f.task_id}>
            <span className="lws-f-verb" data-opened={opened ? "" : undefined}>{opened ? "opened" : "joined"}</span>
            <span className="lws-f-ref">{task?.short_id ?? "problem"}</span>
            <span className="lws-f-ptitle">{task?.title ?? ""}</span>
            {task && <span className="lws-f-status">{task.status.replace(/_/g, " ")}</span>}
          </a>
        )}
        {!problemHref && <span className="lws-f-problem" data-held="" title="No problem holds this finding yet: it joins one when its group opens, or a person files it">waiting to group</span>}
        {project && <span className="lws-f-proj">{project}</span>}
        {open && f.short_id && <span className="lws-f-id">{f.short_id}</span>}
        {open && f.moment && <span className="lws-f-id" title="The moment the judge read">{f.moment}</span>}
        {host && f.evidence_url && <a className="lws-f-ev" href={f.evidence_url} target="_blank" rel="noreferrer" title={f.evidence_url}>{host}<ArrowUpRight aria-hidden /></a>}
      </span>
    </li>
  );
});
