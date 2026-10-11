"use client";
// Where a run came from (line-workspace.md LW1): the finding it started on
// (the newest by its start), its source, judge and severity, the words it quotes,
// and the link to the evidence. More findings and other sources are counts
// that open the problem's timeline.
import { memo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { RunSource as RunSourceModel } from "../../../../../lib/line/runTrace";
import { dayWords } from "../../../widgets";
import { sourceChipWords } from "../../../../../lib/line/stepRuns";

/** `expected`: the findings the problem held when the run started (its recorded history); while they are read, the band says so rather than "by hand". */
export const RunSource = memo(function RunSource({ source, expected, onFindings, onSource }: { source: RunSourceModel; expected: number; onFindings: (() => void) | null; onSource: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const lead = source.lead;
  if (!lead) {
    return (
      <section className="rd-src" data-run-source={expected > 0 ? "reading" : "none"}>
        <span className="rd-tag">Source</span>
        {expected > 0
          ? <span className="rd-src-none"><span className="lw-spin" aria-hidden /> {expected} finding{expected === 1 ? "" : "s"}</span>
          : <span className="rd-src-none">Started by hand</span>}
      </section>
    );
  }
  const others = source.sources.filter((s) => s.source !== lead.source);
  return (
    <section className="rd-src" data-run-source={lead.source}>
      <span className="rd-tag">Source</span>
      <div className="rd-src-body">
        <div className="rd-src-facts">
          <button type="button" className="rd-chip" data-k="source" onClick={() => onSource(lead.source)} title={`Open this source (${lead.source})`}>{sourceChipWords({ source: lead.source, judge: lead.judge ?? null })}</button>
          {lead.severity != null && <span className="rd-fact" data-sev={lead.severity >= 7 ? "hi" : lead.severity >= 4 ? "mid" : "lo"}><i>sev</i>{lead.severity}</span>}
          {lead.ref && <span className="rd-fact rd-mono">{lead.ref}</span>}
          <span className="rd-fact">{dayWords(lead.at)}</span>
          {(Math.max(source.count, expected) > 1 || source.later > 0) && (() => {
            // Every finding the problem held at the start; the band lists those loaded, the rest open in the timeline.
            // What the problem held when the run started; findings after it are a separate count.
            const total = Math.max(source.count, expected);
            const words = `${total} finding${total === 1 ? "" : "s"} at start${source.later ? ` · +${source.later} since` : ""}`;
            const title = total > source.count ? `${source.count} of them loaded here` : undefined;
            return onFindings
              ? <button type="button" className="rd-fact rd-link" onClick={onFindings} title={title}>{words}</button>
              : <span className="rd-fact" title={title}>{words}</span>;
          })()}
          {others.map((o) => <button key={o.source} type="button" className="rd-chip" data-k="source" onClick={() => onSource(o.source)} title={o.source}>+{o.count} {sourceChipWords({ source: o.source, judge: null })}</button>)}
          <span className="rd-spacer" />
          {lead.evidenceUrl && <a className="rd-fact rd-link" href={lead.evidenceUrl} target="_blank" rel="noreferrer">Evidence <ExternalLink className="w-3 h-3" aria-hidden /></a>}
        </div>
        <div className="rd-src-title">{lead.title}</div>
        {(lead.quote || lead.headline) && (
          <blockquote className="rd-src-quote" data-open={open ? "" : undefined} onClick={() => setOpen((o) => !o)} title={open ? undefined : "Show all"}>
            {lead.quote ?? lead.headline}
          </blockquote>
        )}
        <FindingList findings={source.findings.filter((f) => f.id !== lead.id)} />
      </div>
    </section>
  );
});

const FOLD_AT = 3;

/** The other findings the problem held at the start, one row each, folded past three. */
function FindingList({ findings }: { findings: RunSourceModel["findings"] }) {
  const [all, setAll] = useState(false);
  if (!findings.length) return null;
  const shown = all ? findings : findings.slice(0, FOLD_AT);
  return (
    <ul className="rd-src-list" data-run-source-findings={findings.length}>
      {shown.map((f) => (
        <li key={f.id}>
          <span className="rd-mono rd-src-ref">{f.ref ?? ""}</span>
          <span className="rd-src-who">{sourceChipWords({ source: f.source, judge: f.judge })}</span>
          <span className="rd-src-t" title={f.title}>{f.title}</span>
          <span className="rd-src-at">{dayWords(f.at)}</span>
        </li>
      ))}
      {findings.length > FOLD_AT && (
        <li><button type="button" className="rd-more" onClick={() => setAll(!all)}>{all ? "Fewer" : `+${findings.length - FOLD_AT}`}</button></li>
      )}
    </ul>
  );
}
