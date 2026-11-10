// The Multiplayer sim catalog (docs/architecture/evals-ui.md 4.6): every
// scenario by mode with its latest result and its history over sessions, the
// invariants with what each caught, the store keys deliberately left out, the
// sessions in time order, and a sweep launcher. Props only; the page
// (pages/SimCatalogPage.tsx) loads and starts the sweep.

import { useMemo, useState } from "react";
import { GitBranch, Waves } from "lucide-react";
import type { SimCatalogResponse, SimGridCell, SimSessionSummary } from "@codecast/shared/contracts/evalsApi";
import { MiniTrace } from "../resources/HealthStrip";
import { evalsHref } from "./evalsPaths";
import { EvalsLink, LogTail, StallChip, useEvalsHost, VerdictGlyph } from "@platform/evals/react";
import "./sim.css";
import { isJobStalled, type JobState } from "./simJobState";
import { shortSha } from "@platform/evals/client";
import { type GridRow, gridRows, markersFor, cellFailure, rowTouches, ago, simExitedBad, simOutcome, simSessionOpen, SIM_OPEN_WORDS } from "./simModel";
import { Button } from "../ui/button";

export type SweepState = JobState;

export interface SimCatalogViewProps {
  catalog: SimCatalogResponse;
  sessions: SimSessionSummary[];
  sweep: SweepState;
  onSweep: (filter: string, seeds: number) => void;
  now?: number;
}

export function SimCatalogView({ catalog, sessions, sweep, onSweep, now = Date.now() }: SimCatalogViewProps) {
  const { rows, modes } = useMemo(() => gridRows(catalog), [catalog]);
  const [invariant, setInvariant] = useState<string | null>(null);
  const [failingOnly, setFailingOnly] = useState(false);
  const [openSessions, setOpenSessions] = useState<ReadonlySet<string>>(new Set());
  // A deleted scenario keeps its history as a row, but its last red run says nothing about the tree now.
  const failingCells = (r: GridRow) => (r.scenario ? [...r.cells.values()].filter((c) => c.latest && !c.latest.passed) : []);
  const failingNow = (r: GridRow) => failingCells(r).length > 0;
  const shown = rows.filter((r) => (!invariant || rowTouches(r, invariant)) && (!failingOnly || failingNow(r)));
  const failing = rows.reduce((n, r) => n + failingCells(r).length, 0);
  const toggleSession = (id: string) => setOpenSessions((open) => (open.has(id) ? new Set([...open].filter((x) => x !== id)) : new Set([...open, id])));
  const lastSession = sessions.find((s) => !s.unsessioned) ?? null;
  const maxCaught = Math.max(1, ...Object.values(catalog.caught));

  return (
    <div className="ev-page evs-page" data-evals-page="sim">
      <header className="evs-head">
        <div className="flex flex-col gap-1.5">
          <h1 className="ev-page-title">
            <Waves className="w-4 h-4" style={{ color: "var(--sol-magenta)" }} />
            Multiplayer sim
          </h1>
          <span className="evs-note">
            The store simulator: scripted and interleaved delivery orders over the real store and Convex functions, checked against {catalog.invariants.length} invariants.
          </span>
        </div>
        <div className="evs-head-stats">
          <div className="evs-stat">
            <b>{rows.filter((r) => r.scenario && !r.scenario.selftest).length}</b>
            <span>scenarios</span>
          </div>
          {failing > 0 ? (
            <button type="button" className="evs-stat evs-stat--button" aria-pressed={failingOnly} onClick={() => setFailingOnly((f) => !f)} title={failingOnly ? "Show every scenario" : "Show only the scenarios whose latest run failed"} data-evs-failing-filter>
              <b className="ev-fail">{failing}</b>
              <span>failing now</span>
            </button>
          ) : (
            <div className="evs-stat">
              <b>0</b>
              <span>failing now</span>
            </div>
          )}
          <div className="evs-stat">
            <b>{sessions.length}</b>
            <span>sessions</span>
          </div>
        </div>
      </header>

      <SweepBar scenarios={rows.map((r) => r.name)} sweep={sweep} onSweep={onSweep} />

      <div className="evs-catalog">
        <section className="ev-card" data-evs-grid={shown.length}>
          <div className="flex items-center gap-2 px-3 pt-3">
            <span className="evs-section-title" style={{ margin: 0 }}>
              <VerdictGlyph state={failing ? "mixed" : "pass"} size={11} />
              Scenarios by mode
            </span>
            {catalog.gitHead && (
              <span className="ev-chip" title={`The suite as of ${catalog.gitHead}`}>
                <GitBranch /> {shortSha(catalog.gitHead)}
              </span>
            )}
            <span className="flex-1" />
            {failingOnly && (
              <button type="button" className="ev-chip" onClick={() => setFailingOnly(false)} data-evs-filter="failing">
                failing now: {shown.length} of {rows.length} rows, clear
              </button>
            )}
            {invariant && (
              <button type="button" className="ev-chip" onClick={() => setInvariant(null)} data-evs-filter={invariant}>
                {invariant}: {shown.length} of {rows.length} rows, clear
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="evs-grid">
              <thead>
                <tr>
                  <th>Scenario</th>
                  {modes.map((m) => (
                    <th key={m}>{m}</th>
                  ))}
                  <th>Newest run</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.name} data-evs-row={r.name} data-evs-selftest={r.scenario?.selftest || undefined}>
                    <td>
                      <div className="evs-scn">
                        <b>{r.name}</b>
                        <span>{r.scenario ? r.scenario.file : "no longer in the suite"}</span>
                      </div>
                    </td>
                    {modes.map((m) => (
                      <td key={m}>
                        <GridCellView cell={r.cells.get(m) ?? null} supported={!r.scenario || r.scenario.modes.includes(m)} markers={markersFor(r.scenario, m)} />
                      </td>
                    ))}
                    <td>
                      <span className="evs-newest">
                        {/* The suite's head is in the grid header; a row names its head only when its newest run was elsewhere. */}
                        {r.gitHead && r.gitHead !== catalog.gitHead && (
                          <span className="ev-chip" title={`Newest run on ${r.gitHead}, not the suite's head`} data-evs-row-head>
                            <GitBranch /> {shortSha(r.gitHead)}
                          </span>
                        )}
                        <span className="ev-tabular evs-note">{r.lastRunAt ? ago(r.lastRunAt, now) : "never run"}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="ev-card" data-evs-invariants={catalog.invariants.length}>
          <div className="evs-section-title px-3 pt-3">
            Invariants
            <span className="evs-note">click one to filter the grid</span>
          </div>
          <div className="evs-inv">
            {catalog.invariants.map((inv) => {
              const caught = catalog.caught[inv.id] ?? 0;
              return (
                <button key={inv.id} type="button" className="evs-inv-row" aria-pressed={invariant === inv.id} onClick={() => setInvariant(invariant === inv.id ? null : inv.id)} title={inv.keys.length ? `Compares ${inv.keys.join(", ")}` : undefined}>
                  <span className="evs-inv-id">{inv.id}</span>
                  <span className="evs-inv-caught" data-evs-caught={caught ? "yes" : "no"}>
                    {caught > 0 && <span className="evs-inv-bar" style={{ width: Math.max(4, (caught / maxCaught) * 44) }} />}
                    {caught ? `caught ${caught}` : "caught none"}
                  </span>
                  <span className="evs-inv-meaning">{inv.meaning}</span>
                </button>
              );
            })}
          </div>
          {catalog.notCompared.length > 0 && (
            <div className="evs-nc" data-evs-not-compared={catalog.notCompared.length}>
              <div className="evs-section-title" style={{ margin: 0 }}>
                Not compared, on purpose
              </div>
              {catalog.notCompared.map((k) => (
                <div key={k.key} className="evs-nc-row">
                  <code>{k.key}</code>
                  <span>{k.reason}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      <section className="ev-card" data-evs-sessions={sessions.length}>
        <div className="evs-section-title px-3 pt-3">
          Sessions
          <span className="evs-note">
            every <code className="ev-mono">bun run sim</code> that ran tests, newest first{lastSession ? `; the last one ${ago(lastSession.startedAt, now)}` : ""}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="evs-sessions">
            <thead>
              <tr>
                <th>Started</th>
                <th>Command</th>
                <th>Head</th>
                <th>Took</th>
                <th>Runs</th>
                <th>Failed</th>
                <th>Exit</th>
              </tr>
            </thead>
            <tbody>
              {sessions.flatMap((s) => [
                <tr key={s.id} data-evs-session={s.id} data-evs-legacy={s.unsessioned || undefined}>
                  <td className="ev-tabular">{ago(s.startedAt, now)}</td>
                  <td className="evs-argv">{s.unsessioned ? `${s.id} (unsessioned, read-only)` : `bun run sim${s.argv.length ? ` ${s.argv.join(" ")}` : ""}`}</td>
                  <td>
                    <span className="ev-chips">
                      {s.gitHead ? (
                        <span className="ev-chip" title={s.gitHead}>
                          <GitBranch /> {shortSha(s.gitHead)}
                        </span>
                      ) : (
                        <span className="evs-note">none</span>
                      )}
                      {s.dirty &&
                        (s.treePatch ? (
                          <EvalsLink className="ev-chip ev-chip--dirty" href={evalsHref.patch(s.treePatch)} title={`Uncommitted edits, kept as trees/${s.treePatch}.patch.gz: open them`}>
                            dirty
                          </EvalsLink>
                        ) : (
                          <span className="ev-chip ev-chip--dirty" title="Uncommitted edits, no patch kept">
                            dirty
                          </span>
                        ))}
                    </span>
                  </td>
                  <td className="ev-tabular">{s.finishedAt ? took(Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : simSessionOpen(s) ? SIM_OPEN_WORDS : ""}</td>
                  <td className="ev-tabular">
                    {s.runs} <span className="evs-note">in {s.scenarios}</span>
                  </td>
                  <td className={`ev-tabular ${s.failed ? "evs-count-fail" : "evs-note"}`}>
                    {s.failed > 0 ? (
                      <button type="button" className="evs-count-btn" aria-expanded={openSessions.has(s.id)} onClick={() => toggleSession(s.id)} title="Show this session's failing runs" data-evs-failed-toggle={s.id}>
                        {s.failed}
                      </button>
                    ) : (
                      s.failed
                    )}
                  </td>
                  <td className={`ev-tabular ${simExitedBad(s) ? "evs-count-fail" : "evs-note"}`} title={simOutcome(s).words} data-evs-exit={simExitedBad(s) ? "bad" : undefined}>
                    {s.exit ?? ""}
                  </td>
                </tr>,
                openSessions.has(s.id) && (
                  <tr key={`${s.id}:failing`} className="evs-failing-row" data-evs-failing={s.id}>
                    <td />
                    <td colSpan={6}>
                      <span className="evs-failing">
                        {(s.failing ?? []).map((f) => {
                          const label = `${f.scenario} ${f.mode} seed ${f.seed}`;
                          return f.dir ? (
                            <EvalsLink key={f.dir} className="ev-chip evs-failing-run" href={evalsHref.simRun(s.id, f.dir)}>
                              <VerdictGlyph state="fail" size={9} />
                              {label}
                            </EvalsLink>
                          ) : (
                            <span key={label} className="ev-chip evs-failing-run" title="This run left no artifact folder (a sweep keeps only failures it was told to)">
                              <VerdictGlyph state="fail" size={9} />
                              {label}, no artifacts
                            </span>
                          );
                        })}
                      </span>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const took = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

function GridCellView({ cell, supported, markers }: { cell: SimGridCell | null; supported: boolean; markers: ReturnType<typeof markersFor> }) {
  if (!supported) return <span className="evs-cell" data-evs-cell="none">not in this mode</span>;
  if (!cell?.latest) return <span className="evs-cell" data-evs-cell="none">never run</span>;
  const { latest } = cell;
  const points = cell.history.map((h, at) => ({ at, seeds: h.seeds, failed: h.failed }));
  const max = Math.max(1, ...points.map((p) => p.seeds));
  const fail = cellFailure(cell);
  const tip = [
    `${latest.passed ? "passed" : "failed"} in the latest session (seed ${latest.seed})`,
    `${cell.history.length} sessions: ${cell.history.reduce((n, h) => n + h.seeds, 0)} seeds run, ${cell.history.reduce((n, h) => n + h.failed, 0)} failed`,
    fail ? `newest failure: seed ${fail.seed}${fail.invariant ? `, ${fail.invariant}` : ""}` : "no failure with artifacts",
    ...markers.map((m) => `${m.kind} marker: ${m.invariant} (${m.task})`),
  ].join("\n");
  const body = (
    <>
      <span className="evs-cell-glyph" data-evs-marked={markers.length ? "yes" : undefined}>
        <VerdictGlyph state={latest.passed ? "pass" : "fail"} size={12} />
      </span>
      <span className="evs-spark" aria-hidden>
        <MiniTrace points={points} f={(p) => p.seeds} max={max} className="evs-spark-run" />
        {points.some((p) => p.failed) && <MiniTrace points={points} f={(p) => p.failed} max={max} className="evs-spark-fail" />}
      </span>
      <span className="evs-cell-seed">{latest.passed ? (fail ? `fail s${fail.seed}` : "") : `seed ${latest.seed}`}</span>
    </>
  );
  return (
    <span className="evs-cellwrap">
      {fail ? (
        <EvalsLink href={evalsHref.simRun(fail.session, fail.run)} className="evs-cell" title={tip} data-evs-cell={latest.passed ? "pass" : "fail"}>
          {body}
        </EvalsLink>
      ) : (
        <span className="evs-cell" title={tip} data-evs-cell={latest.passed ? "pass" : "fail"}>
          {body}
        </span>
      )}
      {markers.length > 0 && (
        <span className="evs-markers">
          {markers.map((m) => (
            <EvalsLink key={`${m.kind}:${m.task}`} href={`/tasks/${m.task}`} className="evs-marker" title={`${m.kind === "red" ? "Red: expected to fail" : "Known failure"} on ${m.invariant}`}>
              {m.kind} {m.task}
            </EvalsLink>
          ))}
        </span>
      )}
    </span>
  );
}

function SweepBar({ scenarios, sweep, onSweep }: { scenarios: string[]; sweep: SweepState; onSweep: (filter: string, seeds: number) => void }) {
  const [filter, setFilter] = useState("");
  const [seeds, setSeeds] = useState(20);
  const busy = sweep.state === "starting" || sweep.state === "running";
  const job = sweep.state === "running" || sweep.state === "done" ? sweep.job : null;
  const pct = job?.progress.total ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100)) : null;
  const now = useEvalsHost().useNow(30_000);
  const stalled = sweep.state === "running" && !!job && isJobStalled(job, now);
  return (
    <section className="ev-card evs-sweep" data-evs-sweep={sweep.state}>
      <span className="evs-section-title" style={{ margin: 0 }}>
        Sweep
      </span>
      <label>
        scenarios
        <input className="evs-input" list="evs-scenarios" placeholder="every scenario" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={busy} aria-label="Scenario filter" style={{ width: 220 }} />
        <datalist id="evs-scenarios">
          {scenarios.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <label>
        seeds
        <input className="evs-input" type="number" min={1} max={2000} value={seeds} onChange={(e) => setSeeds(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} disabled={busy} aria-label="Seeds" style={{ width: 80 }} />
      </label>
      <Button type="button" variant="cyan" size="sm" disabled={busy} onClick={() => onSweep(filter.trim(), seeds)} data-evs-sweep-start>
        Run {seeds} seeds
      </Button>
      <code className="ev-mono evs-note">
        bun run sim{filter.trim() ? ` ${filter.trim()}` : ""} --sweep {seeds}
      </code>
      <span className="flex-1" />
      {(sweep.state === "running" || sweep.state === "done") && (
        <span className="evs-job" role="status">
          <span className="evs-job-track">
            <span className="evs-job-fill" style={{ width: `${sweep.state === "done" ? 100 : pct ?? 8}%` }} />
          </span>
          {job ? job.progress.text || `${job.progress.done}${job.progress.total ? ` of ${job.progress.total}` : ""} seeds` : "Starting..."}
          {job?.tmux && <code className="ev-mono">tmux {job.tmux}</code>}
          {stalled && <StallChip since={job!.updatedAt} data-evs-stalled />}
        </span>
      )}
      {sweep.state === "starting" && <span className="evs-job">Starting the sweep...</span>}
      {sweep.state === "failed" && <span className="ev-fail text-[11.5px]">{sweep.error}</span>}
      {sweep.state === "failed" && <LogTail lines={sweep.logTail ?? []} label="What the sweep printed before it ended" data-evs-sweep-log />}
    </section>
  );
}
