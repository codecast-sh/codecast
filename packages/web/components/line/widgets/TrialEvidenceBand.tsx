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
import { useMemo, type ReactNode } from "react";
import type { TrialCardRow } from "../../../hooks/useSyncTrial";
import { cardAsRead, proposalAsRead, trialReach } from "../../../lib/trialEvidence";
import { trialFacts } from "../../trial/TrialFactsStrip";

/** `said`: the words are what a contact received (a real message), so they read as a quote; else a description of today. */
type Side = { who?: string; quote: string; note?: string; said?: boolean };
type Proof = { label: string; value: ReactNode; sub?: string; tone?: "good" | "bad" | "warn"; title?: string };
type After = { change: string; cost?: string | null; replay?: { text: string; note?: string } | null };

/** "20 pass / 0 fail" out of a test run's tail, as passed of total; null when the detail does not say. */
export function passCount(detail: string | undefined): { pass: number; of: number } | null {
  const pass = /(\d+) pass\b/.exec(detail ?? "");
  const fail = /(\d+) fail\b/.exec(detail ?? "");
  if (!pass || !fail) return null;
  const p = Number(pass[1]);
  return { pass: p, of: p + Number(fail[1]) };
}

const hours = (min: number) => (min >= 90 ? `${Math.round(min / 60)}h` : `${min}m`);
const RISK_WORD: Record<string, string> = { low: "low", review: "needs review", plan: "needs a plan" };

/** The note under a quote says what is wrong with it; "Missing" only when it names something absent. */
export const noteLabel = (note: string): "Missing" | "Problem" =>
  /^(no|not|never|without|omits?|missing|lacks?|leaves? out|skips?|drops?|does(?: not|n't)|did(?: not|n't)|nothing)\b/i.test(note.trim()) || /\b(left out|is missing|was missing|never (?:says|said|mentions|mentioned|names|named))\b/i.test(note) ? "Missing" : "Problem";

const LOSS = /\b(lost|loses?|lacks?|lacked|no longer|stops?|stopped|fewer|miss(?:es|ed)?|risks?|costs?|delay(?:s|ed)?|held)\b/i;

/** A proposal's "after" sentence, split where it turns from what changes to what that costs ("...; in 5 of 17 pairs the news is lost"). */
export function splitCost(after: string): { change: string; cost: string | null } {
  const at = after.indexOf("; ");
  if (at < 0) return { change: after, cost: null };
  const tail = after.slice(at + 2).trim();
  if (!LOSS.test(tail)) return { change: after, cost: null };
  return { change: `${after.slice(0, at).trim()}.`, cost: tail.charAt(0).toUpperCase() + tail.slice(1) };
}

const riskProof = (risk: { class: string; reason: string }): Proof => ({ label: "Risk", value: RISK_WORD[risk.class] ?? risk.class, sub: risk.reason || undefined, tone: risk.class === "low" ? undefined : "warn" });

/** The band's parts, read from one card. Exported for a test. */
export function evidenceOf(c: TrialCardRow): { cases: Side[]; after: After | null; proof: Proof[]; lines: Array<{ label: string; text: string }>; examples: Array<{ input: string; before: string; after: string; note?: string }>; pr: string | null } {
  const card = cardAsRead(c);
  const proposal = proposalAsRead(c.proposal, c.evidence);
  const proof: Proof[] = [];
  if (card) {
    const ex = card.examples[0];
    // Every conversation the card cites, as sent; a card that cites none shows its replayed case, else today in its own words.
    const cases: Side[] = card.seen?.length ? card.seen.map((s) => ({ who: s.asked, quote: s.quote, note: s.missing, said: true }))
      : ex ? [{ who: ex.input, quote: ex.before, said: true }] : card.wrong ? [{ quote: card.wrong }] : [];
    const was = passCount(card.proof.before[0]?.detail);
    const now = passCount(card.proof.after[0]?.detail);
    if (was && now) proof.push({ label: "Repro", value: <>{was.pass}/{was.of} <i>→</i> {now.pass}/{now.of}</>, tone: now.pass === now.of && was.pass < was.of ? "good" : "warn", title: `${card.proof.before[0].name}: ${was.pass} of ${was.of} passed before the change, ${now.pass} of ${now.of} after` });
    else if (card.proof.before.length || card.proof.after.length) {
      const b = card.proof.before.filter((k) => !k.ok).length;
      const a = card.proof.after.filter((k) => !k.ok).length;
      proof.push({ label: "Failing cases", value: <>{b} <i>→</i> {a}</>, tone: b > 0 && a === 0 ? "good" : "warn", title: `${b} failing before the change, ${a} after` });
    }
    // One count for the card (trialReach): covered of the problem's conversations now.
    const reach = trialReach(c);
    if (reach) proof.push({ label: "Reaches", value: `${reach.covered}/${reach.of}`, sub: "conversations", tone: reach.covered * 2 >= reach.of ? undefined : "warn", title: `${reach.covered} of the problem's ${reach.of} conversations` });
    const red = card.checks.filter((k) => !k.ok).length;
    proof.push({ label: "Checks", value: red ? `${red} red` : `${card.checks.length} green`, tone: red ? "bad" : "good", title: card.checks.map((k) => `${k.ok ? "ok" : "red"} ${k.name}`).join("\n") });
    proof.push(riskProof(card.risk));
    proof.push({ label: "Diff", value: <>{card.diff.files} files <b className="ld-ev-add">+{card.diff.added}</b> <b className="ld-ev-del">−{card.diff.removed}</b></> });
    if (c.evals_owed?.length) proof.push({ label: "Evals", value: `${c.evals_owed.length} not run`, tone: "warn", title: `Owed: ${c.evals_owed.join(", ")}. The trial never runs them.` });
    proof.push({ label: "Cost", value: `$${card.cost.usd.toFixed(2)} · ${hours(card.cost.minutes)}` });
    return {
      cases, after: { change: card.change, replay: ex ? { text: ex.after, note: ex.note || undefined } : null }, proof,
      lines: card.context ? [{ label: "Where", text: card.context }] : [],
      // The first example is the After box's replay; any more read as their own before and after.
      examples: card.examples.slice(1).map((e) => ({ input: e.input, before: e.before, after: e.after, note: e.note || undefined })), pr: card.diff.pr ?? null,
    };
  }
  if (proposal) {
    const cs = proposal.case;
    if (proposal.measured) proof.push({ label: "Seen in", value: `${proposal.measured.count} of ${proposal.measured.of}`, sub: proposal.measured.window, title: proposal.measured.method === "replay" ? "Counted by replaying real cases on main" : "Counted in the product's own records" });
    if (proposal.proof) proof.push(proposal.proof.outcome === "red"
      ? { label: "Still broken on main", value: "yes", sub: `${proposal.proof.rung} check`, title: "The run's check showed the miss on main" }
      : { label: "Still broken on main", value: "not shown", sub: proposal.proof.outcome, tone: "warn", title: "No check could show the miss on main" });
    proof.push(riskProof(proposal.risk));
    if (c.evidence) proof.push({ label: "Live now", value: `${c.evidence.findings} ${c.evidence.findings === 1 ? "finding" : "findings"}`, tone: c.evidence.findings ? undefined : "bad" });
    return {
      cases: [cs ? { who: cs.asked, quote: cs.quote, note: cs.missing, said: true } : { quote: proposal.today }],
      after: splitCost(proposal.after), proof,
      lines: [{ label: "Cause", text: `${proposal.cause.line}${proposal.cause.where.length ? ` (${proposal.cause.where.join(", ")})` : ""}` }],
      examples: [], pr: null,
    };
  }
  // A judge fix or a bare gate: the facts the line measured, as they are.
  return { cases: [], after: null, proof: trialFacts(c).map((f) => ({ label: f.label, value: f.value, tone: f.tone, title: f.title })), lines: [], examples: [], pr: null };
}

/** Whether a session's words already show a real conversation: a blockquote, or a quoted passage long enough to be a message. */
export const quotesConversation = (md: string | null | undefined): boolean => !!md && (/^\s{0,3}>\s*\S/m.test(md) || /["\u201c][^"\u201c\u201d\n]{40,}["\u201d]/.test(md));

/** `compact`: under a session's own words: the number chips, and (unless those words quote a conversation, `quoted`)
 *  the card's first real message against what changes. Nothing the session already said is said twice. */
export function TrialEvidenceBand({ card: c, compact = false, quoted = compact }: { card: TrialCardRow; compact?: boolean; quoted?: boolean }) {
  const ev = useMemo(() => evidenceOf(c), [c]);
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
        <dl className="ld-ev-proof" data-line-decision-proof>
          {ev.proof.map((p) => (
            <div key={p.label} data-tone={p.tone} title={p.title}>
              <dt>{p.label}</dt>
              <dd className="lw-num">{p.value}</dd>
              {p.sub && <dd className="ld-ev-sub">{p.sub}</dd>}
            </div>
          ))}
        </dl>
      )}
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
