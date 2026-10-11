"use client";
// The top of a problem's page (line-workspace.md LW1 Problems): the question
// it holds on, answered in place, and where it came from, the first and the
// newest finding each with its source, judge, time, words and evidence.
import { memo, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { LineSignal } from "../../../../../lib/lineFlow";
import { findingGist, findingJudgeLabel, findingTitle, sourceLabel } from "../../../../../lib/line/loopSteps";
import { useTeamRosterIdentity } from "../../../../../hooks/useTeamRoster";
import { formatRelativeTime } from "../../../../../lib/conversationFormat";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";

export type ProblemAnswer = "confirmed" | "dropped";

/** A person's answer to grounding's question: confirmed starts it (with the note as its context), dropped closes it. */
export function answerProblem(taskRef: string, how: ProblemAnswer, note = "") {
  const st = useInboxStore.getState();
  const said = note.trim();
  if (said) void st.addTaskComment(taskRef, said);
  void st.updateTask(taskRef, how === "confirmed" ? { readiness: "ready", readiness_note: said ? `Confirmed: ${said}` : "Confirmed by a person." } : { status: "dropped" });
}

/** The question grounding asked about the problem, with the answer box and its two outcomes. */
/** `question` is the ask itself (lineInbox askLine); `why` is grounding's whole note, read under it when it says more. */
export function ProblemAsk({ question, why, taskRef, focus }: { question: string; why?: string | null; taskRef: string | null; focus: boolean }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<ProblemAnswer | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useWatchEffect(() => { if (focus) box.current?.focus({ preventScroll: true }); }, [focus]);
  if (!taskRef) return null;
  const answer = (how: ProblemAnswer) => {
    answerProblem(taskRef, how, text);
    setSent(how);
  };
  return (
    <section className="lwt-ask" data-line-ask={sent ?? "open"}>
      <div className="lwt-ask-h"><span className="lwp-dot" data-status="waiting" aria-hidden />Question for you</div>
      <p className="lwt-ask-q">{question}</p>
      {why && why.replace(/\s+/g, " ").trim() !== question && <p className="lwt-ask-why">{why}</p>}
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

/** The team's names by user id, for who filed a person's finding. */
export function useReporterNames(): ReadonlyMap<string, string> {
  const roster = useTeamRosterIdentity();
  return useMemo(() => new Map(roster.map((m) => [m._id, m.name ?? m.email ?? ""] as [string, string]).filter(([, n]) => !!n)), [roster]);
}

/** Who in a source reported a finding: a person's name, or the judge that made it ("Comms judge"). Null when the source alone says it. */
export function reporterOf(s: LineSignal & { user_id?: string }, names: ReadonlyMap<string, string>): string | null {
  if (s.source === "person") return (s.user_id && names.get(s.user_id)) || null;
  const judge = findingJudgeLabel(s);
  return judge && judge !== sourceLabel(s.source) ? judge : null;
}

/** Where the problem came from: its first finding and its newest, each one line of source and one or two of words. */
export const CameFrom = memo(function CameFrom({ own, expected, now, openSource }: {
  own: ReadonlyArray<LineSignal>; expected: number; now: number; openSource: (source: string, finding?: string) => void;
}) {
  const names = useReporterNames();
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
      <Finding s={first} tag="first" now={now} openSource={openSource} names={names} />
      {latest && <Finding s={latest} tag="latest" now={now} openSource={openSource} names={names} />}
    </section>
  );
});

function Finding({ s, tag, now, openSource, names }: { s: LineSignal; tag: string; now: number; openSource: (source: string, finding?: string) => void; names: ReadonlyMap<string, string> }) {
  const who = reporterOf(s, names);
  const at = s.observed_at || s.created_at;
  const { says, quote } = findingGist(s);
  return (
    <div className="lwt-from-row" data-line-finding={s._id}>
      <span className="lwt-from-tag">{tag}</span>
      <div className="lwt-from-body">
        <div className="lwt-from-meta">
          <button type="button" className="lwt-src" onClick={() => openSource(s.source, s._id)} title="Open this finding in Sources">{sourceLabel(s.source)}</button>
          {who && <span className="lwt-who">{who}</span>}
          {s.source === "person" && s.subject && <span>{s.subject}</span>}
          {typeof s.severity === "number" && <span className="lwt-sev" data-sev={Math.min(5, Math.round(s.severity / 2))} title="Severity, 1 to 10">sev {s.severity}</span>}
          <time title={new Date(at).toLocaleString()}>{formatRelativeTime(at, now)}</time>
          {s.short_id && <span className="lwt-ref">{s.short_id}</span>}
          {s.evidence_url && <a className="lw-link" href={s.evidence_url} target="_blank" rel="noreferrer">Evidence <ArrowUpRight className="w-3 h-3" aria-hidden /></a>}
        </div>
        <div className="lwt-from-t">{findingTitle(s)}</div>
        {says && <div className="lwt-from-w">{says}</div>}
        {quote && <q className="lwt-from-q">{quote}</q>}
      </div>
    </div>
  );
}
