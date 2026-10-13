"use client";
// A call a finding names, read through the connected app's history reader (lib/line/callRecord) when the app's own
// call screen cannot be framed here: the call's head, its transcript by speaker with the lines the finding quotes
// marked, and the app's summary on demand. Read once per page load and call id; a read changes nothing in the app.
import { useMemo } from "react";
import type { ProductViewRef } from "@codecast/shared/contracts/productView";
import { CALL_READER, readCallRecord, type CallRecord as Call } from "../../../lib/line/callRecord";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { useAppRead } from "./useAppRead";
import "./callRecord.css";

export function CallRecord({ viewRef, marks }: { viewRef: ProductViewRef; marks: string[] }) {
  const read = useAppRead(viewRef.app, CALL_READER.name, { [CALL_READER.arg]: viewRef.id });
  const call = useMemo(() => (read?.ok ? readCallRecord(read.text, marks) : null), [read, marks]);
  if (!read) return <div className="cr cr-wait" data-line-call-record="loading"><span className="lw-spin" aria-hidden /> Reading the call</div>;
  // Nothing to read in place: the head above still names the call. Why stays on the element for whoever set it up.
  if (!call) return <div hidden data-line-call-record="none" title={read.ok ? "the answer is not a call" : read.error} />;
  return <CallBody call={call} />;
}

function CallBody({ call: c }: { call: Call }) {
  // First names fit the speaker column; the summary names each in full.
  const who = (w: "contact" | "caller") => (w === "contact" ? c.contact ?? "Contact" : c.caller ?? "Caller").split(" ")[0];
  return (
    <div className="cr" data-line-call-record="ready">
      {c.head && <p className="cr-head">{c.head}</p>}
      {c.lines.length > 0 && (
        <ol className="cr-lines" aria-label="Transcript">
          {c.lines.map((l, i) => (
            <li key={i} data-who={l.who} data-marked={l.marked ? "" : undefined}>
              <span className="cr-at">{l.at}</span>
              <span className="cr-who">{who(l.who)}</span>
              <span className="cr-text">{l.text}</span>
            </li>
          ))}
        </ol>
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
