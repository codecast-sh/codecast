"use client";
// The top of a problem's page (line-workspace.md LW1 Problems): the question
// it holds on, answered in place, and where it came from, the first and the
// newest finding each with its source, judge, time, words and evidence.
import { memo, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { signalQuotes } from "@codecast/shared/contracts/causeHistory";
import type { LineSignal } from "../../../../../lib/lineFlow";
import { findingJudgeLabel, findingTitle, sourceLabel } from "../../../../../lib/line/loopSteps";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";

/** The question grounding asked about the problem, with the answer box and its two outcomes. */
export function ProblemAsk({ question, taskRef, focus }: { question: string; taskRef: string | null; focus: boolean }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<"confirmed" | "dropped" | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useWatchEffect(() => { if (focus) box.current?.focus({ preventScroll: true }); }, [focus]);
  if (!taskRef) return null;
  const answer = (how: "confirmed" | "dropped") => {
    const st = useInboxStore.getState();
    const note = text.trim();
    if (note) void st.addTaskComment(taskRef, note);
    void st.updateTask(taskRef, how === "confirmed" ? { readiness: "ready", readiness_note: note ? `Confirmed: ${note}` : "Confirmed by a person." } : { status: "dropped" });
    setSent(how);
  };
  return (
    <section className="lwt-ask" data-line-ask={sent ?? "open"}>
      <div className="lwt-ask-h"><span className="lwp-dot" data-status="waiting" aria-hidden />Question for you</div>
      <p className="lwt-ask-q">{question}</p>
      {sent ? (
        <div className="lwt-ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? "confirmed" : "dropped"}</span></div>
      ) : (
        <>
          <textarea
            ref={box}
            className="lwt-ask-box"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer("confirmed"); } }}
            placeholder="Answer (optional)"
            data-line-ask-box
          />
          <div className="lwt-ask-acts">
            <button type="button" className="lw-act" data-primary="" onClick={() => answer("confirmed")} data-line-ask-confirm>Confirm, start it</button>
            <button type="button" className="lw-act" onClick={() => answer("dropped")} data-line-ask-drop>Not a problem</button>
          </div>
        </>
      )}
    </section>
  );
}

/** A finding's words past its title: the first thing it quotes, else its detail's opening line. */
function findingWords(s: LineSignal): string | null {
  const quote = signalQuotes(s.detail_md)[0];
  if (quote) return quote;
  const line = (s.detail_md ?? "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim()).find(Boolean);
  return line && line !== s.title ? line : null;
}

/** Where the problem came from: its first finding and its newest, each one line of source and one or two of words. */
export const CameFrom = memo(function CameFrom({ own, expected, now, openSource }: {
  own: ReadonlyArray<LineSignal>; expected: number; now: number; openSource: (source: string, finding?: string) => void;
}) {
  const [first, latest] = useMemo(() => {
    const by = [...own].sort((a, b) => (a.observed_at || a.created_at) - (b.observed_at || b.created_at));
    return [by[0] ?? null, by.length > 1 ? by[by.length - 1] : null];
  }, [own]);
  if (!first) {
    return (
      <section className="lwt-from" data-line-came-from="none">
        <div className="lwt-from-h">Came from</div>
        <p className="lwt-quiet">{expected > 0 ? <><span className="lw-spin" aria-hidden /> {expected} finding{expected === 1 ? "" : "s"}</> : "Filed by hand"}</p>
      </section>
    );
  }
  return (
    <section className="lwt-from" data-line-came-from={own.length}>
      <div className="lwt-from-h">Came from<span className="lw-num">{Math.max(expected, own.length)}</span></div>
      <Finding s={first} tag="first" now={now} openSource={openSource} />
      {latest && <Finding s={latest} tag="latest" now={now} openSource={openSource} />}
    </section>
  );
});

function Finding({ s, tag, now, openSource }: { s: LineSignal; tag: string; now: number; openSource: (source: string, finding?: string) => void }) {
  const judge = findingJudgeLabel(s);
  const at = s.observed_at || s.created_at;
  const words = findingWords(s);
  return (
    <div className="lwt-from-row" data-line-finding={s._id}>
      <span className="lwt-from-tag">{tag}</span>
      <div className="lwt-from-body">
        <div className="lwt-from-meta">
          <button type="button" className="lwt-src" onClick={() => openSource(s.source, s._id)} title="Open this finding in Sources">{sourceLabel(s.source)}</button>
          {judge && judge !== sourceLabel(s.source) && <span>{judge}</span>}
          {s.source === "person" && s.subject && <span>{s.subject}</span>}
          {typeof s.severity === "number" && <span className="lwt-sev" data-sev={Math.min(5, Math.round(s.severity / 2))} title="Severity, 1 to 10">sev {s.severity}</span>}
          <time title={new Date(at).toLocaleString()}>{formatRelativeTime(at, now)}</time>
          {s.short_id && <span className="lwt-ref">{s.short_id}</span>}
          {s.evidence_url && <a className="lw-link" href={s.evidence_url} target="_blank" rel="noreferrer">Evidence <ArrowUpRight className="w-3 h-3" aria-hidden /></a>}
        </div>
        <div className="lwt-from-t">{findingTitle(s)}</div>
        {words && <div className="lwt-from-w">{words}</div>}
      </div>
    </div>
  );
}
