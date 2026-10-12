"use client";
// What one visit of a step produced (lib/line/visitOutput), drawn the same way
// in the step drawer's Decisions rows, the Runs list and a run's step list:
// a JSON result as key: value chips, a step's own words as text, a person's
// choice with their note, an older agent run as a link to its session.
import { ArrowUpRight } from "lucide-react";
import { visitOutputWords, type VisitOutput } from "../../../lib/line/visitOutput";
import "./visitOutput.css";

export function VisitOutputView({ out, className }: { out: VisitOutput | null; className?: string }) {
  if (!out) return null;
  const title = visitOutputWords(out) ?? undefined;
  const cls = className ? `vo ${className}` : "vo";
  if (out.kind === "fields") {
    return (
      <span className={cls} data-kind="fields" title={title}>
        {out.fields.map((f) => <span key={f.key} className="vo-f"><b>{f.key}</b><span>{f.value}</span></span>)}
        {out.more > 0 && <span className="vo-more">+{out.more}</span>}
      </span>
    );
  }
  if (out.kind === "choice") {
    return (
      <span className={cls} data-kind="choice" title={title}>
        <span className="vo-choice">{out.choice}</span>
        {out.note && <span className="vo-note">{out.note}</span>}
      </span>
    );
  }
  if (out.kind === "session") {
    return (
      <span className={cls} data-kind="session">
        <a className="vo-session" href={out.href} onClick={(e) => e.stopPropagation()}>session<ArrowUpRight aria-hidden /></a>
      </span>
    );
  }
  return <span className={cls} data-kind="text" title={title}>{out.text}</span>;
}
