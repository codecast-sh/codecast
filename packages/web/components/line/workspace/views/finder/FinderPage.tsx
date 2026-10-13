"use client";
// A finder's page (line-journeys.md LJ8.6): Line > Comms judge. Its job is to
// tell whether this finder can be trusted and to correct it. The head says
// what it looks for, its findings this week and how often people marked it
// wrong. Below, this week's findings in three groups (filed to a problem,
// counted as the Find table counts it; marked wrong; not filed), then older,
// each opened in place as the real thing (FindingReader: the conversation a
// judge read with the judged words marked, else the finding's own words and
// its link). "Judge is wrong" sits on an open judge finding; nothing else is
// drawn as an act until its backend exists (LJ9 item 9).
import { Fragment, useMemo, useState } from "react";
import { finderGroups, findingAt, findingsOf, flatSources, groupsByWords, markable, startsWords, wrongRateWords, type FinderGroup } from "../../../../../lib/line/sourcesView";
import { watchesFor } from "../../../../../lib/line/lineSources";
import { FindingReader, useFinderName } from "../../../widgets/FindingReader";
import type { LineViewProps } from "../types";
import { useFinders, type FinderSignal } from "./FindTable";
import "./finder.css";

/** How many findings a group shows before "Show more". */
const PAGE = 30;

export function FinderPage({ workspace, selection, select, href }: LineViewProps) {
  // The drawn process first, so the numbers match the Find table it was opened from; a finder that filed only into
  // another process (a link, a finding's source) still opens, read over every process.
  const here = useFinders(workspace);
  const every = useFinders(workspace, { everyProcess: true });
  const named = (rs: typeof here.sources) => { const flat = flatSources(rs); const k = selection.source?.toLowerCase(); return flat.find((r) => r.key.toLowerCase() === k && findingsOf(here.signals, r).length) ?? null; };
  const { sources, signals, marks, rows, window, windowWords } = named(here.sources) ? here : every;
  const flat = useMemo(() => flatSources(sources), [sources]);
  const row = flat.find((r) => r.key === selection.source) ?? flat.find((r) => r.key.toLowerCase() === selection.source?.toLowerCase()) ?? null;
  const parent = row?.judge != null ? sources.find((s) => s.source === row.source && s.judge == null) ?? null : null;
  const findings = useMemo(() => (row ? findingsOf(signals, row) : []), [signals, row]);
  const groups = useMemo(() => finderGroups(findings, marks, window), [findings, marks, window]);
  const stat = rows.find((r) => r.row.key === row?.key) ?? null;
  const who = useFinderName();
  const tasks = useMemo(() => new Map((workspace.rows.tasks as unknown as Array<{ _id: string; short_id?: string; title: string }>).map((t) => [t._id, t])), [workspace.rows.tasks]);
  const finders = row ? (row.finders.length ? row.finders : parent?.finders ?? []) : [];
  const judged = findings.some((f) => markable(f));

  // The open finding: the address's ("none" when the person shut it), else the newest of the first group.
  const first = groups[0]?.findings[0] ?? null;
  const open = selection.finding ? findings.find((f) => f._id === selection.finding || f.short_id === selection.finding) ?? null : first;
  const toggle = (f: FinderSignal) => select({ finding: open?._id === f._id ? "none" : f.short_id ?? f._id }, undefined, { replace: true });

  const crumb = (
    <nav className="fp-crumb" aria-label="Where this finder is">
      <a className="fp-crumb-link" href={href({ view: "line", source: null, finding: null, step: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "line", source: null, finding: null, step: null }); }}>Line</a>
      <span aria-hidden>›</span>
      <span aria-current="page">{row ? row.name : "Finder"}</span>
    </nav>
  );
  if (!row) {
    // Until the floor's findings have loaded, a named finder is not missing yet.
    if (!workspace.ready) return <div className="lw-skeleton" aria-busy data-line-view="finder">{[40, 92, 70, 54].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
    return (
      <div className="fp" data-line-view="finder" data-line-finder-missing={selection.source ?? ""}>
        <header className="fp-head">{crumb}</header>
        <div className="lw-empty"><b>No finder by that name filed here</b>It may file into another process.</div>
      </div>
    );
  }
  // The Find table's figure for this row, so the number clicked is the number here.
  const week = stat?.week ?? findings.filter((f) => findingAt(f) >= window.from).length;
  const rate = stat ? wrongRateWords(stat) : null;
  const purpose = finders.length
    ? [...new Set(finders.map((f) => `Looks for ${watchesFor(f.kind)}; one problem per ${groupsByWords(f.fingerprint)}${(() => { const s = startsWords(f.runs); return s && /^(on|at|when|after|every|daily|hourly)\b/i.test(s.when) ? `; files ${s.when}` : ""; })()}`))]
    : [];

  return (
    <div className="fp" data-line-view="finder" data-line-finder={row.key}>
      <header className="fp-head">
        {crumb}
        <h1 className="fp-title">{parent ? <span className="fp-parent">{parent.name} · </span> : null}{row.name}</h1>
        {purpose.map((p) => <p key={p} className="fp-purpose">{p}</p>)}
        <dl className="fp-figures">
          <div><dt>{window.cut ? `Findings, last ${windowWords}` : "Findings this week"}</dt><dd className="lw-num">{week}</dd></div>
          {judged && <div data-line-finder-wrong-rate><dt>Wrong rate</dt><dd className="lw-num">{stat?.wrong ? rate : "0%"}</dd></div>}
        </dl>
      </header>

      {!groups.length ? (
        <div className="lw-empty"><b>No findings held</b>Nothing from {row.name} is in the window the line holds.</div>
      ) : (
        <div className="fp-body">
          {groups.map((g) => <Group key={g.key} group={g} open={open?._id ?? null} toggle={toggle} who={who as unknown as (s: FinderSignal) => string} tasks={tasks} onProblem={(id) => select({ view: "problems", case: id, run: null, source: null, finding: null })} problemHref={(id) => href({ view: "problems", case: id, run: null, source: null, finding: null })} />)}
        </div>
      )}
    </div>
  );
}

function Group({ group: g, open, toggle, who, tasks, onProblem, problemHref }: {
  group: FinderGroup<FinderSignal>; open: string | null; toggle: (f: FinderSignal) => void; who: (s: FinderSignal) => string;
  tasks: ReadonlyMap<string, { _id: string; short_id?: string; title: string }>; onProblem: (id: string) => void; problemHref: (id: string) => string;
}) {
  const [all, setAll] = useStateLimit(g.findings.length, open ? g.findings.findIndex((f) => f._id === open) + 1 : 0);
  const shown = g.findings.slice(0, all);
  return (
    <section className="fp-group" data-line-finder-group={g.key}>
      {/* Each group's count is the one figure for its label, over the Find table's window, so the table's
          Not filed is the count here. */}
      <h2 className="fp-h">{g.label}<span className="lw-num fp-h-n">{g.findings.length}</span></h2>
      <ul className="fp-list">
        {shown.map((f) => {
          const t = f.task_id ? tasks.get(f.task_id) : null;
          return (
            <Fragment key={f._id}>
              <FindingReader signal={f as never} who={who(f)} open={open === f._id} onToggle={() => toggle(f)} />
              {open === f._id && t && (
                <li className="fp-problem-row"><a className="fp-problem" href={problemHref(t._id)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onProblem(t._id); }} data-line-finding-problem={t.short_id ?? t._id}>
                  <span className="fp-problem-k">Filed to</span><span className="lw-mono">{t.short_id ?? "Problem"}</span><span>{t.title}</span>
                </a></li>
              )}
            </Fragment>
          );
        })}
      </ul>
      {g.findings.length > shown.length && <button type="button" className="lw-link fp-more" onClick={() => setAll(Math.min(g.findings.length, shown.length + PAGE * 2))}>Show {Math.min(PAGE * 2, g.findings.length - shown.length)} more of {g.findings.length - shown.length}</button>}
    </section>
  );
}

/** A page size that grows to hold the open row. */
function useStateLimit(total: number, mustHold: number): [number, (n: number) => void] {
  const [n, setN] = useState(PAGE);
  return [Math.min(total, Math.max(n, mustHold)), setN];
}
