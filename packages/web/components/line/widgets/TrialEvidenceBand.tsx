"use client";
// What a trial run built and proved, on its decision (LineDecision) or its
// proposal (TrialCardPanel). Under a session's own words (`compact`) it is one
// row of number chips when those words quote a conversation: the session
// already told the case, so the band never says it twice. Words that quote
// nothing get the card's first real message against what changes above the
// chips, so every decision shows a before and after on a real conversation,
// whatever its session happened to write. Where no session wrote a top, it also shows every real
// message the card cites against what the change does, a replayed result when
// the run made one, and what the change costs. The numbers are read from the
// card the run's code built (hooks/useSyncTrial TrialCardRow), never from the
// session's prose, so the numbers are the line's and the words the session's.
import { useMemo, useState } from "react";
import Link from "next/link";
import type { TrialCardRow } from "../../../hooks/useSyncTrial";
import { cardAsRead, proposalAsRead } from "../../../lib/trialEvidence";
import { trialFacts, type Fact, type FactOpen } from "../../trial/TrialFactsStrip";
import { useRunVerify } from "../../../hooks/useRunVerify";
import type { VerifyFigure } from "../../../lib/line/runVerify";
import { TrialFactOpen } from "./TrialFactOpen";

/** `said`: the words are what a contact received (a real message), so they read as a quote; else a description of today. */
type Side = { who?: string; quote: string; note?: string; said?: boolean };
/** The chips are the card's facts (trialFacts), the same rows /trial's strip shows. */
type Proof = Pick<Fact, "label" | "value" | "sub" | "tone" | "title" | "href" | "opens">;
type After = { change: string; cost?: string | null; replay?: { text: string; note?: string } | null };

export { passCount } from "../../trial/TrialFactsStrip";

/** The note under a quote says what is wrong with it; "Missing" only when it names something absent. */
export const noteLabel = (note: string): "Missing" | "Problem" =>
  /^(no|not|never|without|omits?|missing|lacks?|leaves? out|skips?|drops?|does(?: not|n't)|did(?: not|n't)|nothing|any (?:mention|word|sign|trace))\b/i.test(note.trim()) || /\b(left out|is missing|was missing|never (?:says|said|mentions|mentioned|names|named))\b/i.test(note) ? "Missing" : "Problem";

const LOSS = /\b(lost|loses?|lacks?|lacked|no longer|stops?|stopped|fewer|miss(?:es|ed)?|risks?|costs?|delay(?:s|ed)?|held)\b/i;

/** A proposal's "after" sentence, split where it turns from what changes to what that costs ("...; in 5 of 17 pairs the news is lost"). */
export function splitCost(after: string): { change: string; cost: string | null } {
  const at = after.indexOf("; ");
  if (at < 0) return { change: after, cost: null };
  const tail = after.slice(at + 2).trim();
  if (!LOSS.test(tail)) return { change: after, cost: null };
  return { change: `${after.slice(0, at).trim()}.`, cost: tail.charAt(0).toUpperCase() + tail.slice(1) };
}

/** The band's parts, read from one card. Exported for a test. */
export function evidenceOf(c: TrialCardRow, verify?: VerifyFigure | null): { cases: Side[]; after: After | null; proof: Proof[]; lines: Array<{ label: string; text: string }>; examples: Array<{ input: string; before: string; after: string; note?: string }>; pr: string | null } {
  const card = cardAsRead(c);
  const proposal = proposalAsRead(c.proposal, c.evidence);
  const proof: Proof[] = trialFacts(c, verify).map(({ label, value, sub, tone, title, href, opens }) => ({ label, value, sub, tone, title, href, opens }));
  if (card) {
    const ex = card.examples[0];
    // Every conversation the card cites, as sent; a card that cites none shows its replayed case, else today in its own words.
    const cases: Side[] = card.seen?.length ? card.seen.map((s) => ({ who: s.asked, quote: s.quote, note: s.missing, said: true }))
      : ex ? [{ who: ex.input, quote: ex.before, said: true }] : card.wrong ? [{ quote: card.wrong }] : [];
    return {
      cases, after: { change: card.change, replay: ex ? { text: ex.after, note: ex.note || undefined } : null }, proof,
      lines: card.context ? [{ label: "Where", text: card.context }] : [],
      // The first example is the After box's replay; any more read as their own before and after.
      examples: card.examples.slice(1).map((e) => ({ input: e.input, before: e.before, after: e.after, note: e.note || undefined })), pr: card.diff.pr ?? null,
    };
  }
  if (proposal) {
    const cs = proposal.case;
    return {
      cases: [cs ? { who: cs.asked, quote: cs.quote, note: cs.missing, said: true } : { quote: proposal.today }],
      after: splitCost(proposal.after), proof,
      lines: [{ label: "Cause", text: `${proposal.cause.line}${proposal.cause.where.length ? ` (${proposal.cause.where.join(", ")})` : ""}` }],
      examples: [], pr: null,
    };
  }
  // A judge fix or a bare gate: the facts the line measured, as they are.
  return { cases: [], after: null, proof, lines: [], examples: [], pr: null };
}

/** Whether a session's words already show a real conversation: a blockquote, or a quoted passage long enough to be a message. */
export const quotesConversation = (md: string | null | undefined): boolean => !!md && (/^\s{0,3}>\s*\S/m.test(md) || /["\u201c][^"\u201c\u201d\n]{40,}["\u201d]/.test(md));

/** `compact`: under a session's own words: the number chips, and (unless those words quote a conversation, `quoted`)
 *  the card's first real message against what changes. Nothing the session already said is said twice. */
export function TrialEvidenceBand({ card: c, compact = false, quoted = compact }: { card: TrialCardRow; compact?: boolean; quoted?: boolean }) {
  const verify = useRunVerify(c.run_id);
  const ev = useMemo(() => evidenceOf(c, verify), [c, verify]);
  const [open, setOpen] = useState<FactOpen | null>(null);
  const pair = (!compact || !quoted) && ev.cases.length > 0 && !!ev.after;
  const cases = compact ? ev.cases.slice(0, 1) : ev.cases;
  // The fold holds only what the boxes above it do not: more replayed cases, where the cause lives, the diff.
  const more = ev.examples.length > 0 || !!ev.pr || (!compact && ev.lines.length > 0);
  if (!pair && !ev.proof.length && !more) return null;
  return (
    <section className="ld-ev" data-line-decision-evidence={c.short_id} data-compact={compact ? "" : undefined} aria-label="What the run built and proved">
      {pair && (
        <div className="ld-ev-pair">
          <div className="ld-ev-cases">
            {cases.map((s, i) => (
              <figure key={i} className="ld-ev-side" data-side="before" data-line-decision-case>
                <figcaption>{i === 0 ? "Today" : "Also today"}{s.who ? <span>{s.who}</span> : null}</figcaption>
                {s.said ? <blockquote>{s.quote}</blockquote> : <p>{s.quote}</p>}
                {s.note && <p className="ld-ev-missing"><b>{noteLabel(s.note)}</b> {s.note}</p>}
              </figure>
            ))}
          </div>
          <figure className="ld-ev-side" data-side="after">
            <figcaption>What changes</figcaption>
            <p>{ev.after!.change}</p>
            {ev.after!.replay && (
              <div className="ld-ev-replay" data-line-decision-replay>
                <b>Same case, with the change</b>
                <p>{ev.after!.replay.text}</p>
                {ev.after!.replay.note && <span>{ev.after!.replay.note}</span>}
              </div>
            )}
            {ev.after!.cost && <div className="ld-ev-cost" data-line-decision-cost><b>What it costs</b><p>{ev.after!.cost}</p></div>}
          </figure>
        </div>
      )}
      {ev.proof.length > 0 && (
        <div className="ld-ev-facts" data-line-decision-proof role="list" aria-label="What the run measured">
          {ev.proof.map((p) => {
            const body = <><span className="k">{p.label}</span><span className="v lw-num">{p.value}</span>{p.sub && <span className="s">{p.sub}</span>}</>;
            // A figure opens what it counts in place; one counted elsewhere links there; the rest are plain facts.
            if (p.opens) return <button key={p.label} type="button" role="listitem" className="ld-ev-fact" data-tone={p.tone} title={p.title} aria-expanded={open === p.opens} data-trial-fact={p.opens} onClick={() => setOpen((o) => (o === p.opens ? null : p.opens!))}>{body}</button>;
            if (p.href) return p.href.startsWith("http")
              ? <a key={p.label} role="listitem" className="ld-ev-fact" data-tone={p.tone} title={p.title} href={p.href} target="_blank" rel="noreferrer" data-trial-fact-link={p.label}>{body}</a>
              : <Link key={p.label} role="listitem" className="ld-ev-fact" data-tone={p.tone} title={p.title} href={p.href} data-trial-fact-link={p.label}>{body}</Link>;
            return <div key={p.label} role="listitem" className="ld-ev-fact" data-tone={p.tone} title={p.title}>{body}</div>;
          })}
        </div>
      )}
      {open && <TrialFactOpen card={c} open={open} />}
      {more && (
        <details className="ld-ev-change" data-line-decision-change>
          <summary>{ev.examples.length ? "More cases, before and after" : ev.pr ? "The diff" : "Where it lives"}</summary>
          {!compact && ev.lines.length > 0 && (
            <dl className="ld-ev-lines">
              {ev.lines.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.text}</dd></div>)}
            </dl>
          )}
          {ev.examples.map((e, i) => (
            <div key={i} className="ld-ev-example">
              <div className="ld-ev-input">{e.input}</div>
              <div className="ld-ev-diff"><span data-op="del">{e.before}</span><span data-op="add">{e.after}</span></div>
            </div>
          ))}
          {ev.pr && <a className="ld-ev-pr" href={ev.pr} target="_blank" rel="noreferrer">Open the diff</a>}
        </details>
      )}
    </section>
  );
}
