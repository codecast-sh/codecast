"use client";
// What was already tried on a cause (line-workspace.md LW5), the way the next
// attempt is handed it: the closes without a change and whether each held
// ("Dissolved 3x as no fix needed; it came back each time"), every fix that
// shipped with when it went live and whether the problem came back, and, on
// the problem's own page, the brief itself. The problem page, the problem
// widget and the attempt's card all draw this one piece.
import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { closesSummary, earlierFixes, historyBrief, type CauseHistory } from "../../../lib/line/causeHistory";
import "../workspace/views/timeline/timeline.css";

export function AlreadyTried({ h, brief: showBrief = false, exceptRunId, bare = false }: {
  h: CauseHistory;
  /** Show the history the next attempt reads, to read and copy. */
  brief?: boolean;
  /** The attempt the surface is for: not its own earlier attempt. */
  exceptRunId?: string;
  /** No box and heading: the surface around it has its own. */
  bare?: boolean;
}) {
  const fixes = useMemo(() => earlierFixes(h, exceptRunId), [h, exceptRunId]);
  const brief = useMemo(() => historyBrief(h, exceptRunId), [h, exceptRunId]);
  const closed = useMemo(() => closesSummary(h), [h]);
  const [copied, setCopied] = useState(false);
  if (!brief) return null;
  const body = (
    <>
      {closed && <p className="lwt-tried-closed" data-back={h.recurrences.length ? "" : undefined}>{closed}</p>}
      {fixes.length ? (
        <ol className="lwt-tried">
          {fixes.map((f) => (
            <li key={f.attempt} data-back={f.back ? "" : undefined}>
              <span className="lwt-tried-n">#{f.attempt}</span>
              <div>
                <p>{f.change}</p>
                <small>{f.live}.{f.back ? ` ${f.back}` : f.held ? ` ${f.held}` : ""}</small>
              </div>
            </li>
          ))}
        </ol>
      ) : !closed ? <p className="lwt-quiet">Nothing shipped yet; earlier attempts stopped before a fix.</p> : null}
      {showBrief && (
        <details className="lwt-brief">
          <summary>The history the next attempt reads</summary>
          <pre>{brief}</pre>
          <button type="button" className="lw-act" onClick={() => { void navigator.clipboard?.writeText(brief); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
            <Copy className="w-3.5 h-3.5" />{copied ? "Copied" : "Copy"}
          </button>
        </details>
      )}
    </>
  );
  if (bare) return <div className="lwt-vars" data-line-memory>{body}</div>;
  return (
    <section className="lwt-side-box lwt-vars" data-line-memory>
      <h3 className="lwt-sec-h">Already tried</h3>
      {body}
    </section>
  );
}
