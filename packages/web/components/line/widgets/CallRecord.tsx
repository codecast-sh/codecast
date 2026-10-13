"use client";
// A call a finding names, read through the connected app's history reader (lib/line/callRecord) when the app's own
// call screen cannot be framed here: the call's head, its transcript by speaker with the lines the finding quotes
// marked, and the app's summary on demand. Read once per page load and call id; a read changes nothing in the app.
import { useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { ProductViewRef } from "@codecast/shared/contracts/productView";
import { useActiveWorkspaceKey } from "../../../hooks/useWorkspaceCollection";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { CALL_READER, readCallRecord, type CallRecord as Call } from "../../../lib/line/callRecord";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import "./callRecord.css";

type Read = { ok: true; text: string } | { ok: false; error: string };
const reads = new Map<string, Promise<Read>>();

export function CallRecord({ viewRef, marks }: { viewRef: ProductViewRef; marks: string[] }) {
  const run = useAction(api.sources.app.read);
  const workspace = useActiveWorkspaceKey();
  const [got, setGot] = useState<{ key: string; read: Read } | null>(null);
  const key = `${workspace}:${viewRef.app}:${viewRef.id}`;
  useWatchEffect(() => {
    if (!workspace) return;
    let p = reads.get(key);
    if (!p) {
      const scope = workspace.startsWith("team:") ? { workspace: "team" as const, team_id: workspace.slice(5) as never } : { workspace: "personal" as const };
      p = run({ ...scope, source: viewRef.app, reader: CALL_READER.name, args_json: JSON.stringify({ [CALL_READER.arg]: viewRef.id }) })
        .then((r): Read => (r.ok && r.text ? { ok: true, text: r.text } : { ok: false, error: r.error ?? "no answer" }))
        .catch((): Read => ({ ok: false, error: "could not reach codecast" }));
      reads.set(key, p);
      void p.then((r) => { if (!r.ok) reads.delete(key); });
    }
    let live = true;
    void p.then((read) => { if (live) setGot({ key, read }); });
    return () => { live = false; };
  }, [key, workspace]);
  const read = got?.key === key ? got.read : null;
  const call = useMemo(() => (read?.ok ? readCallRecord(read.text, marks) : null), [read, marks]);
  if (!read) return <div className="cr cr-wait" data-line-call-record="loading"><span className="lw-spin" aria-hidden /> Reading the call</div>;
  if (!call) return null;
  return <CallBody call={call} />;
}

function CallBody({ call: c }: { call: Call }) {
  const who = (w: "contact" | "caller") => (w === "contact" ? c.contact ?? "Contact" : c.caller ?? "Caller");
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
