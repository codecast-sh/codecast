"use client";
// What the line did about one problem (line-journeys.md LJ8.3, J5): one row
// per run, newest first, the newest open. Collapsed it says when, how long,
// what the run proposed and how it ended; open it says what it found, what it
// changed, its proof and who answered, each on its own labelled line.
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { dayTimeWords, dayWords, spanShort, type WorkRow } from "../../../../../lib/line/problemPage";

export function ProblemWork({ rows, bandShowsNewest, onRun, onDecision }: {
  rows: ReadonlyArray<WorkRow>;
  /** The band above already shows the newest run's decision, so its Outcome line only points there. */
  bandShowsNewest: boolean;
  onRun: (runId: string) => void;
  onDecision: (ref: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(() => rows[0]?.runId ?? null);
  return (
    <section className="pw" data-line-work={rows.length} aria-label="Work">
      <header className="pp-sec-h"><h3>Work <span className="lw-num">{rows.length}</span></h3></header>
      {!rows.length ? <p className="pp-none">No run has started on it.</p> : (
        <ol className="pw-list">
          {rows.map((r, i) => {
            const isOpen = open === r.runId;
            return (
              <li key={r.runId} className="pw-run" data-open={isOpen ? "" : undefined} data-line-run={r.runId}>
                <button type="button" className="pw-head" onClick={() => setOpen(isOpen ? null : r.runId)} aria-expanded={isOpen}>
                  <span className="lw-chev" aria-hidden />
                  <span className="pw-n">Run {r.n}</span>
                  <time className="pw-at" dateTime={new Date(r.start).toISOString()}>{dayWords(r.start)}</time>
                  <span className="pw-dur">{r.durationMs != null ? spanShort(r.durationMs) : r.live ? "now" : ""}</span>
                  <span className="pw-what">{r.headline}</span>
                  <span className="pw-out" data-tone={r.tone}>{r.outcome}</span>
                </button>
                {isOpen && (
                  <dl className="pw-body">
                    {r.found && r.found !== r.headline && <div><dt>Found</dt><dd>{r.found}</dd></div>}
                    {r.change && (
                      <div><dt>Change</dt><dd>
                        {r.change.files > 0 && <span className="pw-stat">{r.change.files} {r.change.files === 1 ? "file" : "files"} <b data-k="add">+{r.change.added}</b> <b data-k="del">−{r.change.removed}</b></span>}
                        {r.change.branch && <code>{r.change.branch}</code>}
                        {r.change.sha && <code>{r.change.sha.slice(0, 7)}</code>}
                        {r.change.pr && <a className="lw-link pb-out" href={r.change.pr} target="_blank" rel="noreferrer">the pull request<ArrowUpRight className="w-3 h-3" aria-hidden /></a>}
                      </dd></div>
                    )}
                    {r.proof && <div><dt>Proof</dt><dd>{[r.proof.before && "failed before the change", r.proof.after && "passes after"].filter(Boolean).join(" · ")}</dd></div>}
                    {r.answer && (
                      <div><dt>Outcome</dt><dd>
                        {i === 0 && bandShowsNewest ? "above" : <>
                          {r.answer.words}{r.answer.at ? ` · ${dayTimeWords(r.answer.at)}` : ""}
                          {r.answer.ref && <button type="button" className="lw-link" onClick={() => onDecision(r.answer!.ref!)}>the decision</button>}
                        </>}
                      </dd></div>
                    )}
                    {r.opens && <div className="pw-open"><dt /><dd><button type="button" className="lw-link" onClick={() => onRun(r.runId)} data-line-open-run={r.runId}>Open run</button></dd></div>}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
