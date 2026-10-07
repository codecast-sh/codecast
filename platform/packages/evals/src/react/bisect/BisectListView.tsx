// Past and running bisects (docs/architecture/evals-ui.md 4.5, the list page):
// surface, endpoints, outcome, culprit, spend and duration, newest first, with
// running ones on top. Props only.

import { bisectGlyph, bisectSummaryWord, endpointLabel, EVALS_STALL_MS, isBisectLive, isBisectStalled, shortSha, sortBisects, usd } from "../../client";
import type { BisectSummary } from "../../contract";
import { useEvalsHost, useEvalsPaths } from "../hooks";
import { EvalsLink, VerdictGlyph } from "../shell/parts";
import { StallChip } from "../shell/StallChip";

export function BisectListView({ bisects, now }: { bisects: readonly BisectSummary[]; now: number }) {
  const host = useEvalsHost();
  const navigate = host.useNavigate();
  const href = useEvalsPaths().href;
  const { EmptyState } = host.ui;
  const { duration, timeAgo } = host.format;
  const rows = sortBisects(bisects);
  return (
    <div className="ev-b-page" data-evb-list={rows.length}>
      <header className="ev-b-head">
        <h1 className="ev-page-title">Bisects</h1>
        <span className="ev-b-sub">Each one takes a regression to the change behind it, spending at most its shown bound.</span>
        <span className="ev-grow" />
        <EvalsLink className="ev-btn ev-btn--lg" href={href.bisectNew()}>
          Attribute a regression
        </EvalsLink>
      </header>
      {rows.length === 0 ? (
        <EmptyState title="No bisects yet" description="Open a worse batch on a surface and pick Attribute this, or start from a pair of batches here. The free answer from records comes first; a bisect runs only when it is narrowed but not pinned." action={{ label: "Attribute a regression", href: href.bisectNew() }} />
      ) : (
        <div className="ev-card ev-b-table-card">
          <table className="ev-b-table">
            <thead>
              <tr>
                <th aria-label="Outcome" />
                <th>Bisect</th>
                <th>Surface</th>
                <th>Good to bad</th>
                <th>Outcome</th>
                <th className="ev-b-num">Spend</th>
                <th className="ev-b-num">Duration</th>
                <th className="ev-b-num">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const live = isBisectLive(b.status);
                const stalled = isBisectStalled(b, now, EVALS_STALL_MS);
                const to = href.bisect(b.id);
                return (
                  <tr key={b.id} data-evb-row={b.id} data-evb-live={live || undefined} onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(to, "_blank") : navigate(to))}>
                    <td>{live ? <span className={`ev-b-live-dot ${stalled ? "" : "ev-pulse"}`} aria-label={stalled ? "stalled" : "running"} /> : <VerdictGlyph state={bisectGlyph(b)} title={bisectSummaryWord(b)} size={12} />}</td>
                    <td>
                      <EvalsLink href={to} className="ev-mono ev-small" onClick={(e) => e.stopPropagation()}>
                        {b.id}
                      </EvalsLink>
                    </td>
                    <td>{b.surface}</td>
                    <td className="ev-mono ev-b-fine ev-quiet ev-b-range">
                      {endpointLabel(b.good)} to {endpointLabel(b.bad)}
                    </td>
                    <td>
                      {b.culprit ? <span className="ev-mono">culprit {shortSha(b.culprit)}</span> : bisectSummaryWord(b)}
                      {stalled && (
                        <StallChip since={b.updatedAt} data-evb-stalled />
                      )}
                    </td>
                    <td className="ev-b-num">
                      {usd(b.spentUsd)} <span className="ev-quiet">of {usd(b.budgetUsd)}</span>
                    </td>
                    <td className="ev-b-num">{duration(Date.parse(b.startedAt), b.finishedAt ? Date.parse(b.finishedAt) : now) || "under a minute"}</td>
                    <td className="ev-b-num ev-quiet">{timeAgo(Date.parse(b.startedAt), now)} ago</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
