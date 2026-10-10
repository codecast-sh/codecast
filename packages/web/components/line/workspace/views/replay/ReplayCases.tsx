"use client";
// Replay's case list (line-workspace.md LW1), ported from the prototype's
// left pane: every real problem that ran this line, each with its runs and how
// each ended, narrowed by how runs ended or by words. Picking a run plays it.
// A 1000-run line stays light: the groups are built once per model, and a
// group off screen is not laid out (content-visibility).
import { memo, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cameBackByRun, type LineModel, type LineRunModel } from "../../../../../lib/line/lineModel";
import { RUN_END_FILTERS, runEndKind, runEndWords, type RunEndKind } from "../../../../../lib/line/replay";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { GroupBackTag, RunTrail, dayWords } from "../../../widgets";

type Group = { key: string; caseId: string | null; ref: string | null; title: string; findings: number | null; runs: LineRunModel[]; text: string };

/** The runs grouped by their case, newest activity first (the runs come newest first). */
function groupsOf(runs: LineModel["runs"], issues: LineModel["issues"]): Group[] {
  const findings = new Map(issues.map((i) => [i.id, i.findings]));
  const by = new Map<string, Group>();
  for (const r of runs) {
    const key = r.caseId ?? `run:${r.id}`;
    let g = by.get(key);
    if (!g) {
      g = { key, caseId: r.caseId, ref: r.caseRef, title: r.caseTitle, findings: r.caseId ? findings.get(r.caseId) ?? null : null, runs: [], text: `${r.caseTitle} ${r.caseRef ?? ""}`.toLowerCase() };
      by.set(key, g);
    }
    g.runs.push(r);
  }
  return [...by.values()];
}

export type ReplayCasesProps = {
  model: LineModel;
  runId: string | null;
  onRun: (run: LineRunModel) => void;
};

export const ReplayCases = memo(function ReplayCases({ model, runId, onRun }: ReplayCasesProps) {
  const [filter, setFilter] = useState<RunEndKind | null>(null);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupsOf(model.runs, model.issues), [model.runs, model.issues]);
  // The runs whose close did not hold: the case's header counts them, each run row says so.
  const back = useMemo(() => cameBackByRun(model.issues), [model.issues]);
  const counts = useMemo(() => {
    const m = new Map<RunEndKind, number>();
    for (const r of model.runs) m.set(runEndKind(r), (m.get(runEndKind(r)) ?? 0) + 1);
    return m;
  }, [model.runs]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => groups
    .filter((g) => !q || g.text.includes(q))
    .map((g) => ({ ...g, runs: filter ? g.runs.filter((r) => runEndKind(r) === filter) : g.runs }))
    .filter((g) => g.runs.length > 0), [groups, q, filter]);

  // Bring the case being played into view when it changes from elsewhere.
  const list = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("[data-sel]");
    el?.scrollIntoView({ block: "nearest" });
  }, [runId]);

  return (
    <aside className="rp-cases" aria-label="Cases">
      {/* The head stays put while the cases scroll, so the filters are never cut under the pane's edge. */}
      <div className="rp-cases-head">
      <div className="rp-pane-title">Cases</div>
      <div className="rp-pane-sub">Real problems that ran this line. Pick a run to play it.</div>
      <label className="rp-search">
        <Search className="w-3.5 h-3.5" aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a case" aria-label="Find a case" spellCheck={false} />
      </label>
      <div className="lw-filters rp-filters" role="group" aria-label="Narrow by how runs ended">
        <button type="button" className="lw-filter" aria-pressed={!filter} onClick={() => setFilter(null)}>All<span>{model.runs.length}</span></button>
        {RUN_END_FILTERS.filter((f) => counts.get(f.key)).map((f) => (
          <button key={f.key} type="button" className="lw-filter" aria-pressed={filter === f.key} onClick={() => setFilter(filter === f.key ? null : f.key)}>
            {f.label}<span>{counts.get(f.key)}</span>
          </button>
        ))}
      </div>
      </div>
      <div ref={list} className="rp-case-list">
        {shown.map((g) => {
          const sel = g.runs.some((r) => r.id === runId);
          const groupBack = g.runs.filter((r) => back.has(r.id));
          return (
            <div key={g.key} className="rp-case" data-sel={sel ? "" : undefined} data-replay-case={g.caseId ?? undefined}>
              <div className="rp-case-title" title={g.title}>{g.title}</div>
              <div className="rp-case-meta">
                {g.ref && <span>{g.ref}</span>}
                {g.findings != null && g.findings > 0 && <span data-tone="find">{g.findings} {g.findings === 1 ? "finding" : "findings"}</span>}
                {g.runs.length > 1 && <span>{g.runs.length} runs</span>}
                <GroupBackTag n={groupBack.length} most={groupBack.reduce((m, r) => Math.max(m, back.get(r.id)!.count), 0)} />
              </div>
              {g.runs.map((r) => (
                <button key={r.id} type="button" className="rp-runrow" aria-current={r.id === runId ? "true" : undefined} onClick={() => onRun(r)} title={r.outcome.text} data-replay-run={r.id}>
                  <span className="rp-endtag" data-end={runEndKind(r)} data-came-back={back.has(r.id) ? "" : undefined} title={back.get(r.id)?.words ?? undefined}>
                    {runEndWords(r)}{back.has(r.id) && <>, came back {back.get(r.id)!.count}×</>}
                  </span>
                  <span className="rp-runrow-trail"><RunTrail run={r} /></span>
                  <span className="rp-runrow-day">{dayWords(r.at)}</span>
                </button>
              ))}
            </div>
          );
        })}
        {!shown.length && <div className="rp-none">{q ? `No case matches "${query.trim()}".` : "No runs ended this way."}</div>}
      </div>
    </aside>
  );
});
