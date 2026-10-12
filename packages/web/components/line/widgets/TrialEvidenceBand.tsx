"use client";
// What a trial run built and proved, under the session's own words on its
// decision (LineDecision): one real message a contact got today beside what
// the change sends instead, the proof as numbers (the repro before and after,
// how many of the problem's conversations it reaches, checks, diff, cost), and
// the change itself folded. Read from the card the run's code built
// (hooks/useSyncTrial TrialCardRow), never from the session's prose, so the
// numbers are the line's and the words are the session's.
import { useMemo, type ReactNode } from "react";
import type { TrialCardRow } from "../../../hooks/useSyncTrial";
import { cardAsRead, proposalAsRead } from "../../../lib/trialEvidence";
import { trialFacts } from "../../trial/TrialFactsStrip";

type Side = { who?: string; quote: string; missing?: string };
type Proof = { label: string; value: ReactNode; tone?: "good" | "bad" | "warn"; title?: string };

/** "20 pass / 0 fail" out of a test run's tail, as passed of total; null when the detail does not say. */
export function passCount(detail: string | undefined): { pass: number; of: number } | null {
  const pass = /(\d+) pass\b/.exec(detail ?? "");
  const fail = /(\d+) fail\b/.exec(detail ?? "");
  if (!pass || !fail) return null;
  const p = Number(pass[1]);
  return { pass: p, of: p + Number(fail[1]) };
}

const hours = (min: number) => (min >= 90 ? `${Math.round(min / 60)}h` : `${min}m`);

/** The band's three parts, read from one card. Exported for a test. */
export function evidenceOf(c: TrialCardRow): { before: Side | null; after: string | null; proof: Proof[]; change: Array<{ label: string; text: string }>; examples: Array<{ input: string; before: string; after: string }>; pr: string | null } {
  const card = cardAsRead(c);
  const proposal = proposalAsRead(c.proposal, c.evidence);
  const proof: Proof[] = [];
  if (card) {
    const seen = card.seen?.[0];
    const ex = card.examples[0];
    const before: Side | null = seen ? { who: seen.asked, quote: seen.quote, missing: seen.missing } : ex ? { who: ex.input, quote: ex.before } : card.wrong ? { quote: card.wrong } : null;
    const was = passCount(card.proof.before[0]?.detail);
    const now = passCount(card.proof.after[0]?.detail);
    if (was && now) proof.push({ label: "Repro", value: <>{was.pass}/{was.of} <i>→</i> {now.pass}/{now.of}</>, tone: now.pass === now.of && was.pass < was.of ? "good" : "warn", title: `${card.proof.before[0].name}: ${was.pass} of ${was.of} passed before the change, ${now.pass} of ${now.of} after` });
    else if (card.proof.before.length || card.proof.after.length) {
      const b = card.proof.before.filter((k) => !k.ok).length;
      const a = card.proof.after.filter((k) => !k.ok).length;
      proof.push({ label: "Proof", value: <>{b} red <i>→</i> {a} red</>, tone: b > 0 && a === 0 ? "good" : "warn" });
    }
    if (card.reach) proof.push({ label: "Reaches", value: `${card.reach.conversations}/${card.reach.of}`, tone: card.reach.conversations * 2 >= card.reach.of ? undefined : "warn", title: `${card.reach.conversations} of the problem's ${card.reach.of} conversations` });
    const red = card.checks.filter((k) => !k.ok).length;
    proof.push({ label: "Checks", value: red ? `${red} red` : `${card.checks.length} green`, tone: red ? "bad" : "good", title: card.checks.map((k) => `${k.ok ? "ok" : "red"} ${k.name}`).join("\n") });
    proof.push({ label: "Diff", value: <>{card.diff.files} files <b className="ld-ev-add">+{card.diff.added}</b> <b className="ld-ev-del">−{card.diff.removed}</b></> });
    if (c.evals_owed?.length) proof.push({ label: "Evals", value: `${c.evals_owed.length} not run`, tone: "warn", title: `Owed: ${c.evals_owed.join(", ")}. The trial never runs them.` });
    proof.push({ label: "Cost", value: `$${card.cost.usd.toFixed(2)} · ${hours(card.cost.minutes)}` });
    return {
      before, after: ex && !seen ? ex.after : card.change, proof,
      change: [{ label: "Today", text: card.wrong }, { label: "After", text: card.change }, ...(card.context ? [{ label: "Where", text: card.context }] : [])],
      examples: card.examples.map((e) => ({ input: e.input, before: e.before, after: e.after })), pr: card.diff.pr ?? null,
    };
  }
  if (proposal) {
    const cs = proposal.case;
    if (proposal.measured) proof.push({ label: "Measured", value: `${proposal.measured.count}/${proposal.measured.of}`, title: `${proposal.measured.window} (${proposal.measured.method})` });
    if (proposal.proof) proof.push({ label: "Proof", value: `${proposal.proof.rung} · ${proposal.proof.outcome}`, tone: proposal.proof.outcome === "red" ? "good" : "warn", title: proposal.proof.outcome === "red" ? "Main still shows the miss" : undefined });
    proof.push({ label: "Risk", value: proposal.risk.class, tone: proposal.risk.class === "low" ? undefined : "warn", title: proposal.risk.reason });
    if (c.evidence) proof.push({ label: "Live now", value: `${c.evidence.findings} findings`, tone: c.evidence.findings ? undefined : "bad" });
    return {
      before: cs ? { who: cs.asked, quote: cs.quote, missing: cs.missing } : { quote: proposal.today },
      after: proposal.after, proof,
      change: [{ label: "Today", text: proposal.today }, { label: "After", text: proposal.after }, { label: "Cause", text: `${proposal.cause.line}${proposal.cause.where.length ? ` (${proposal.cause.where.join(", ")})` : ""}` }],
      examples: [], pr: null,
    };
  }
  // A judge fix or a bare gate: the facts the line measured, as they are.
  return { before: null, after: null, proof: trialFacts(c).map((f) => ({ label: f.label, value: f.value, tone: f.tone, title: f.title })), change: [], examples: [], pr: null };
}

export function TrialEvidenceBand({ card: c }: { card: TrialCardRow }) {
  const ev = useMemo(() => evidenceOf(c), [c]);
  if (!ev.before && !ev.proof.length) return null;
  return (
    <section className="ld-ev" data-line-decision-evidence={c.short_id} aria-label="What the run built and proved">
      {ev.before && ev.after && (
        <div className="ld-ev-pair">
          <figure className="ld-ev-side" data-side="before">
            <figcaption>Today{ev.before.who ? <span>{ev.before.who}</span> : null}</figcaption>
            <blockquote>{ev.before.quote}</blockquote>
            {ev.before.missing && <p className="ld-ev-missing"><b>Missing</b> {ev.before.missing}</p>}
          </figure>
          <figure className="ld-ev-side" data-side="after">
            <figcaption>After the change</figcaption>
            <p>{ev.after}</p>
          </figure>
        </div>
      )}
      {ev.proof.length > 0 && (
        <dl className="ld-ev-proof" data-line-decision-proof>
          {ev.proof.map((p) => (
            <div key={p.label} data-tone={p.tone} title={p.title}>
              <dt>{p.label}</dt>
              <dd className="lw-num">{p.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(ev.change.length > 0 || ev.examples.length > 0) && (
        <details className="ld-ev-change" data-line-decision-change>
          <summary>Prompt and behavior change</summary>
          <dl className="ld-ev-lines">
            {ev.change.map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.text}</dd></div>)}
          </dl>
          {ev.examples.map((e, i) => (
            <div key={i} className="ld-ev-example">
              <div className="ld-ev-input">{e.input}</div>
              <div className="ld-ev-diff"><span data-op="del">{e.before}</span><span data-op="add">{e.after}</span></div>
            </div>
          ))}
          {ev.pr && <a className="ld-ev-pr" href={ev.pr} target="_blank" rel="noreferrer">The diff</a>}
        </details>
      )}
    </section>
  );
}
