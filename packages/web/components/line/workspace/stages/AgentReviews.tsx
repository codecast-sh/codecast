"use client";
// An agent judge's reviews (convex agentReviews.ts, lineStages.reviews): the
// queue in numbers, what runs now and where, the newest finished and the
// failed. Any review opens whole: its session, both turns, as the agent wrote,
// ran and read it, from the transcript kept beside its moment.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { ReviewTranscript, TranscriptEntry } from "@codecast/shared/contracts/agentJudges";
import { useLineReviews, useSyncLineReviews, type LineReview } from "../../../../hooks/useLineStages";
import { useInboxStore } from "../../../../store/inboxStore";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { agoWords, usd } from "../../../../lib/line/flowStages";
import { Back, Section, StageHead } from "./parts";

const mins = (ms: number | null | undefined) => (ms == null ? "–" : `${(ms / 60_000).toFixed(1)} min`);

export function AgentReviews({ projectId, judge, now, openMoment }: { projectId: string | null; judge: string; now: number; openMoment: (moment: string) => void }) {
  useSyncLineReviews(projectId, judge);
  const r = useLineReviews(projectId, judge);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <ReviewSession review={open} onBack={() => setOpen(null)} back="Reviews" />;
  if (!r) return <div className="lw-skeleton" aria-busy>{[60, 90, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
  const c = r.counts;
  const total = c.queued + c.running + c.done + c.failed;
  const row = (x: LineReview) => (
    <li key={x.review}>
      <div className="sd-row" data-line-review={x.review}>
        <span className="lw-mono sd-ref">{x.review}</span>
        <a className="lw-link lw-mono sd-ref" href="#" onClick={(e) => { e.preventDefault(); openMoment(x.moment); }}>{x.moment}</a>
        <span className="sd-row-t">
          {x.status === "done" ? `${x.findings ?? 0} found · ${x.filed ?? 0} filed` : x.status === "running" ? `running on ${x.account ?? "?"} for ${mins(now - (x.started_at ?? now))}` : x.error ?? x.status}
        </span>
        <span className="sd-pill" data-tone={x.status === "done" ? ((x.findings ?? 0) ? "warn" : "ok") : x.status === "failed" ? "bad" : x.status === "running" ? "live" : "dim"}>{x.status}</span>
        {x.status === "done" && <span className="sd-dim lw-num">{mins(x.took_ms)} · {usd(x.notional_usd)}</span>}
        {x.finished_at && <span className="sd-dim">{agoWords(x.finished_at, now)}</span>}
        {x.transcript && <button type="button" className="lw-chip" onClick={() => setOpen(x.review)} data-line-review-open={x.review}>Transcript</button>}
      </div>
    </li>
  );
  return (
    <>
      <dl className="sd-facts" data-line-reviews={total}>
        <div><dt>Done</dt><dd className="lw-num">{c.done.toLocaleString("en-US")} of {total.toLocaleString("en-US")}</dd></div>
        <div><dt>Running</dt><dd className="lw-num">{c.running}</dd></div>
        <div><dt>Queued</dt><dd className="lw-num">{c.queued.toLocaleString("en-US")}</dd></div>
        <div><dt>Failed</dt><dd className="lw-num" data-tone={c.failed ? "bad" : undefined}>{c.failed}</dd></div>
        <div><dt>Per review</dt><dd className="lw-num" title={`mean of the newest ${r.averages.of}; list price is what the session would cost on the API, spent here as subscription quota`}>{mins(r.averages.took_ms)} · {usd(r.averages.notional_usd)} list</dd></div>
        <div><dt>Findings each</dt><dd className="lw-num">{r.averages.findings == null ? "–" : r.averages.findings.toFixed(1)}</dd></div>
      </dl>
      {r.running.length > 0 && <Section title="Running" n={r.running.length}><ul className="sd-list">{r.running.map(row)}</ul></Section>}
      <Section title="Newest finished" n={c.done}>{r.recent.length ? <ul className="sd-list">{r.recent.map(row)}</ul> : <p className="sd-note">None finished yet</p>}</Section>
      {r.failed.length > 0 && <Section title="Failed" n={c.failed}><ul className="sd-list">{r.failed.map(row)}</ul></Section>}
    </>
  );
}

/** Transcripts already read this page load, by viewer and review. */
const read = new Map<string, Promise<ReviewTranscript | null>>();
let readOf: string | null = null;

/** One review's whole session, both turns; `onBack` returns to where it was opened from. */
export function ReviewSession({ review, onBack, back }: { review: string; onBack: () => void; back: string }) {
  const fetchOne = useAction(api.agentReviews.webTranscript);
  const viewer = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  const [state, setState] = useState<{ review: string; t: ReviewTranscript | null } | null>(null);
  useWatchEffect(() => {
    if (!viewer) return;
    if (readOf !== viewer) { read.clear(); readOf = viewer; }
    const key = `${viewer}:${review}`;
    let p = read.get(key);
    if (!p) {
      p = fetchOne({ review }).then((x) => x.transcript).catch(() => null);
      read.set(key, p);
      void p.then((t) => { if (!t) read.delete(key); });
    }
    let live = true;
    void p.then((t) => { if (live) setState({ review, t }); });
    return () => { live = false; };
  }, [review, viewer]);
  const t = state?.review === review ? state.t : undefined;
  const tools = t ? t.turns.flat().filter((e) => e.kind === "tool_use").length : 0;
  return (
    <div data-line-review-transcript={review}>
      <Back label={back} onBack={onBack} href="#" />
      <StageHead
        title={<>{review}</>}
        sub={t ? `${t.judge} · ${t.model} · ${t.moment}` : undefined}
        figures={t ? [{ label: "Turns", n: t.turns.length }, { label: "Tool calls", n: tools }] : []}
      />
      {t === undefined && <div className="lw-skeleton" aria-busy>{[60, 90, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>}
      {t === null && <div className="lw-empty"><b>No transcript kept</b>this review's session was not handed back whole</div>}
      {t && t.turns.map((turn, i) => (
        <Section key={i} title={i === 0 ? "The review" : "Its findings"}>
          <ol className="rt-list">{turn.map((e, j) => <Entry key={j} e={e} />)}</ol>
        </Section>
      ))}
    </div>
  );
}

function Entry({ e }: { e: TranscriptEntry }) {
  if (e.kind === "text") return <li className="rt-text">{e.text}</li>;
  const label = e.kind === "prompt" ? `Prompt · ${e.text.length.toLocaleString("en-US")} characters` : e.kind === "thinking" ? "Thinking" : e.kind === "tool_use" ? e.name ?? "Tool" : e.error ? "Error" : "Result";
  const head = e.kind === "tool_use" ? toolLine(e.text) : e.text.replace(/\s+/g, " ").slice(0, 140);
  return (
    <li className="rt-fold" data-kind={e.kind} data-error={e.error ? "" : undefined}>
      <details>
        <summary><b>{label}</b><span className="lw-mono">{head}</span></summary>
        <pre>{e.text}</pre>
      </details>
    </li>
  );
}

/** A tool call's one line: a command's text, a file's path, a search's pattern. */
function toolLine(input: string): string {
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    return String(o.command ?? o.file_path ?? o.pattern ?? o.path ?? input).replace(/\s+/g, " ").slice(0, 160);
  } catch {
    return input.slice(0, 160);
  }
}
