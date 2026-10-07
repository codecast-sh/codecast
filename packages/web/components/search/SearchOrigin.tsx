import { highlightMatch } from "../../lib/searchHighlight";
import type { SessionSearchRow } from "../../lib/instantSessionSearch";
import { useSurface } from "../../lib/surfaces";

/** What a result's title no longer says: the names the session had before,
 *  what it was first asked to do, and how many of its workers matched too. A
 *  long session drifts, and the person looking for it remembers the start.
 *  Renders nothing for a row with none of these. Every search surface draws
 *  this one line set, so a drifted session reads the same wherever it is found. */
export function SearchOrigin({ row, query, className = "" }: {
  row: Pick<SessionSearchRow, "origin" | "workerCount">;
  query: string;
  className?: string;
}) {
  const earlier = row.origin?.earlier_titles ?? [];
  // Worker sessions are a fleet's machinery; hosted mode never names them.
  // Nor what a conversation began as: its first ask is the message the hit
  // shows under it, so the line said it twice.
  const internals = useSurface("search.internals");
  const started = internals ? row.origin?.started_as : undefined;
  const workers = internals ? row.workerCount ?? 0 : 0;
  if (!earlier.length && !started && !workers) return null;
  return (
    <div className={`text-[11px] leading-relaxed text-sol-text-dim space-y-0.5 ${className}`}>
      {earlier.length > 0 && (
        <p className="truncate">
          <span className="text-sol-text-muted">earlier titled </span>
          {earlier.map((title, i) => (
            <span key={title}>{i > 0 && " · "}{highlightMatch(title, query)}</span>
          ))}
        </p>
      )}
      {started && (
        <p className="line-clamp-2">
          <span className="text-sol-text-muted">began as </span>
          {highlightMatch(started, query)}
        </p>
      )}
      {workers > 0 && (
        <p className="text-sol-text-muted">
          {workers} worker session{workers === 1 ? "" : "s"} of this one matched too
        </p>
      )}
    </div>
  );
}
