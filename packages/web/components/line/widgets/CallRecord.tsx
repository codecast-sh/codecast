"use client";
// A call a finding names, read through the connected app's history reader (lib/line/callRecord) when the app's own
// call screen cannot be framed here: the call's head, its transcript by speaker with the lines the finding quotes
// marked, and the app's summary on demand. Read once per page load and call id; a read changes nothing in the app.
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProductViewRef } from "@codecast/shared/contracts/productView";
import { CALL_READER, callExcerpt, callHead, readCallRecord, type CallLine, type CallRecord as Call } from "../../../lib/line/callRecord";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { useAppRead } from "./useAppRead";
import "./callRecord.css";

/** `marks`: the finding's quotes; `times`: the call times it cites (callRecord citedTimes). */
export function CallRecord({ viewRef, marks, times = [] }: { viewRef: ProductViewRef; marks: string[]; times?: string[] }) {
  const read = useAppRead(viewRef.app, CALL_READER.name, { [CALL_READER.arg]: viewRef.id });
  const call = useMemo(() => (read?.ok ? readCallRecord(read.text, marks, times) : null), [read, marks, times]);
  if (!read) return <div className="cr cr-wait" data-line-call-record="loading"><span className="lw-spin" aria-hidden /> Reading the call</div>;
  // Nothing to read in place: the head above still names the call. Why stays on the element for whoever set it up.
  if (!call) return <div hidden data-line-call-record="none" title={read.ok ? "the answer is not a call" : read.error} />;
  return <CallBody call={call} />;
}

/** The call opens on the lines the finding cites, a few either side; the whole call is one press away, in a scroller
 *  of its own opened at the first cited line. A finding that cites no line opens the whole call in that scroller. */
function CallBody({ call: c }: { call: Call }) {
  // First names fit the speaker column; the summary names each in full.
  const who = (w: "contact" | "caller") => (w === "contact" ? c.contact ?? "Contact" : c.caller ?? "Caller").split(" ")[0];
  const runs = useMemo(() => callExcerpt(c.lines), [c.lines]);
  const [whole, setWhole] = useState(false);
  const length = callHead(c).length;
  const line = (l: CallLine, i: number) => (
    <li key={i} data-who={l.who} data-marked={l.marked ? "" : undefined}>
      <span className="cr-at">{l.at}</span>
      <span className="cr-who">{who(l.who)}</span>
      <span className="cr-text">{l.text}</span>
    </li>
  );
  return (
    <div className="cr" data-line-call-record="ready">
      <CallHead call={c} />
      {runs.length > 0 && !whole && (
        <ol className="cr-lines" aria-label="The cited lines" data-line-call-excerpt={runs.length}>
          {runs.map((r, k) => (
            <Fragment key={r.from}>
              {k > 0 && <li className="cr-gap" aria-hidden>⋯</li>}
              {c.lines.slice(r.from, r.to + 1).map((l, j) => line(l, r.from + j))}
            </Fragment>
          ))}
        </ol>
      )}
      {c.lines.length > 0 && (runs.length === 0 || whole) && <WholeCall lines={c.lines} line={line} />}
      {runs.length > 0 && c.lines.length > 0 && (
        <button type="button" className="lw-link cr-whole" aria-expanded={whole} onClick={() => setWhole(!whole)} data-line-call-whole={whole ? "open" : "closed"}>
          {whole ? "Only the cited lines" : `Whole call${length ? ` (${length})` : ""}`}
        </button>
      )}
      {c.summary && (
        <details className="cr-summary">
          <summary>Summary</summary>
          <MarkdownRenderer content={c.summary} />
        </details>
      )}
    </div>
  );
}

/** Every line of the call in a scroller of its own, opened at the first marked line. */
function WholeCall({ lines, line }: { lines: CallLine[]; line: (l: CallLine, i: number) => ReactNode }) {
  const box = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const mark = el?.querySelector<HTMLElement>("li[data-marked]");
    if (el && mark) el.scrollTop = Math.max(0, mark.offsetTop - 3 * mark.offsetHeight);
  }, []);
  return <ol ref={box} className="cr-lines cr-scroll" aria-label="Transcript" data-line-call-transcript={lines.length}>{lines.map(line)}</ol>;
}

/** The call named the way a person names one: who called whom, when, how long. The app's own head line is its title. */
function CallHead({ call }: { call: Call }) {
  const h = callHead(call);
  return (
    <p className="cr-head" title={call.head ?? undefined} data-line-call-head>
      <b>{h.who}</b>
      {h.when && <span>{h.when}</span>}
      {h.length && <span>{h.length}</span>}
    </p>
  );
}
