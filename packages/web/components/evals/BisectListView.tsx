// Past and running bisects (docs/architecture/evals-ui.md 4.5, the list page):
// surface, endpoints, outcome, culprit, spend and duration, newest first, with
// running ones on top. Props only.

import { useRouter } from "next/navigation";
import type { BisectSummary } from "@codecast/shared/contracts/evalsApi";
import { formatDuration } from "../../lib/conversationFormat";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { EmptyState } from "../EmptyState";
import { EvalsLink, StallChip, VerdictGlyph } from "./parts";
import { EVALS_STALL_MS } from "../../lib/evals/hooks";
import { bisectGlyph, bisectSummaryWord, endpointLabel, isBisectLive, isBisectStalled, sortBisects } from "./bisectModel";
import { evalsHref } from "./evalsPaths";
import "./bisect.css";
import { shortSha, usd } from "./format";

export function BisectListView({ bisects, now }: { bisects: readonly BisectSummary[]; now: number }) {
  const router = useRouter();
  const rows = sortBisects(bisects);
  return (
    <div className="evb-page" data-evb-list={rows.length}>
      <header className="evb-head">
        <h1>Bisects</h1>
        <span className="evb-sub">Each one takes a regression to the change behind it, spending at most its shown bound.</span>
        <span className="flex-1" />
        <EvalsLink className="evb-btn" href={evalsHref.bisectNew()}>
          Attribute a regression
        </EvalsLink>
      </header>
      {rows.length === 0 ? (
        <EmptyState title="No bisects yet" description="Open a worse batch on a surface and pick Attribute this, or start from a pair of batches here. The free answer from records comes first; a bisect runs only when it is narrowed but not pinned." action={{ label: "Attribute a regression", href: evalsHref.bisectNew() }} />
      ) : (
        <div className="ev-card overflow-x-auto">
          <table className="evb-table">
            <thead>
              <tr>
                <th aria-label="Outcome" />
                <th>Bisect</th>
                <th>Surface</th>
                <th>Good to bad</th>
                <th>Outcome</th>
                <th className="evb-num">Spend</th>
                <th className="evb-num">Duration</th>
                <th className="evb-num">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const live = isBisectLive(b.status);
                const stalled = isBisectStalled(b, now, EVALS_STALL_MS);
                const href = evalsHref.bisect(b.id);
                return (
                  <tr key={b.id} data-evb-row={b.id} data-evb-live={live || undefined} onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(href, "_blank") : router.push(href))}>
                    <td>{live ? <span className={`evb-live-dot inline-block ${stalled ? "" : "ev-pulse"}`} aria-label={stalled ? "stalled" : "running"} /> : <VerdictGlyph state={bisectGlyph(b)} title={bisectSummaryWord(b)} size={12} />}</td>
                    <td>
                      <EvalsLink href={href} className="ev-mono text-[12px]" onClick={(e) => e.stopPropagation()}>
                        {b.id}
                      </EvalsLink>
                    </td>
                    <td>{b.surface}</td>
                    <td className="ev-mono text-[11.5px] ev-quiet">
                      {endpointLabel(b.good)} to {endpointLabel(b.bad)}
                    </td>
                    <td>
                      {b.culprit ? <span className="ev-mono">culprit {shortSha(b.culprit)}</span> : bisectSummaryWord(b)}
                      {stalled && (
                        <StallChip since={b.updatedAt} data-evb-stalled />
                      )}
                    </td>
                    <td className="evb-num">
                      {usd(b.spentUsd)} <span className="ev-quiet">of {usd(b.budgetUsd)}</span>
                    </td>
                    <td className="evb-num">{formatDuration(Date.parse(b.startedAt), b.finishedAt ? Date.parse(b.finishedAt) : now) || "under a minute"}</td>
                    <td className="evb-num ev-quiet">{formatTimeAgo(Date.parse(b.startedAt), now)} ago</td>
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
