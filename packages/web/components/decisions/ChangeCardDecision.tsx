"use client";
// A change card laid out for the person deciding it (the-line-end-to-end.md
// LE10, LE11), self-contained: what changes and for whom, today against after,
// the numbers that decide it as tiles (reports, proof, checks, risk, cost,
// diff), the three answers each saying what they do, then the real cases
// before and after and the evidence under them. Built from ChangeCardView's
// own pieces, so every fact reads the way the queue reads it.
import type { ReactNode } from "react";
import { cardChecks, honestChecks, checkNotRun, proofSummary, riskLabel, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { CheckRow, EarlierFixes, ExamplePair, ProofDots, ProofStrip, riskReason, runnerTally } from "./ChangeCardView";
import "./changeCard.css";

const RISK_TONE: Record<ChangeCard["risk"]["class"], string> = { low: "green", review: "yellow", plan: "red" };
const firstSentence = (t: string) => (t.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? t).replace(/^On this (local )?branch,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase());
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Tile({ label, value, sub, title, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; className?: string }) {
  return (
    <div className={`ccd-tile ${className}`} title={title}>
      <div className="ccd-tile-label">{label}</div>
      <div className="ccd-tile-value">{value}</div>
      {sub && <div className="ccd-tile-sub">{sub}</div>}
    </div>
  );
}

/** The proof as one number: a lone test run reads as its failing count before and after, else cases fixed. */
function proofTile(card: ChangeCard) {
  const s = proofSummary(card.proof);
  if (!s.red) return { value: "none", sub: "no failing case shown", tone: "" };
  const before = card.proof.before.filter((c) => !c.ok);
  if (before.length === 1) {
    const after = card.proof.after.find((c) => c.name === before[0].name);
    const b = runnerTally(before[0].detail);
    const a = runnerTally(after?.detail);
    if (b && a) return { value: `${b.fail} → ${a.fail}`, sub: "failing tests", tone: a.fail ? "cc-text-red" : "cc-text-green" };
  }
  const bad = s.stillRed.length + s.broke.length;
  return { value: `${s.fixed} of ${s.red}`, sub: s.broke.length ? `cases fixed, ${s.broke.length} broke` : "cases fixed", tone: bad ? "cc-text-red" : "cc-text-green" };
}

/** A finding behind the cause, as the card shows it: what was sent, to whom, when. */
export type SeenCase = { key: string; title: string; quote: string; at: number };

export function ChangeCardDecision({ card, answer, seen = [] }: { card: ChangeCard; answer: ReactNode; seen?: SeenCase[] }) {
  const own = honestChecks(card.checks);
  const failing = own.filter((c) => !c.ok);
  const ran = own.filter((c) => !checkNotRun(c));
  const proof = proofTile(card);
  const proofBad = cardChecks(card)[0]?.ok === false;
  // Failing checks lead the evidence; one that never ran sits last.
  const checks = [...failing, ...own.filter((c) => c.ok && !checkNotRun(c)), ...own.filter((c) => c.ok && checkNotRun(c))];
  return (
    <article className="change-card cc-full" data-change-card={card.cause.task} data-card-decision>
      <header className="ccd-head">
        {card.context && <p className="ccd-context" data-card-context>{card.context}</p>}
        {/* A card written before headlines leads with its change's first sentence; the whole change reads beside Today. */}
        <h1 className="ccd-title" data-card-headline>{card.headline || firstSentence(card.change)}</h1>
      </header>

      <div className="ccd-shift" data-card-shift>
        <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.wrong}</div>
        {card.change && <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{card.change}</div>}
      </div>

      <div className="ccd-tiles" data-card-tiles>
        <Tile label="Reports" value={card.cause.signals || "–"} sub={card.cause.first_seen ? `since ${day(card.cause.first_seen)}` : undefined} />
        <Tile label="Proof" value={<><ProofDots card={card} /><span className={proof.tone}>{proof.value}</span></>} sub={proof.sub} className={proofBad ? "is-bad" : ""} />
        <Tile
          label="Checks"
          value={<span className={failing.length ? "cc-text-red" : "cc-text-green"}>{failing.length ? `${failing.length} fails` : `${ran.length} pass`}</span>}
          sub={failing.length ? failing.map((c) => c.name).join(", ") : own.length > ran.length ? `${own.length - ran.length} not run` : undefined}
        />
        <Tile
          label="Risk"
          value={<span className="inline-flex items-center gap-1.5"><span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden /><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk, true).replace(/ risk$/, "")}</span></span>}
          sub={riskReason(card.risk)}
          title={riskReason(card.risk)}
        />
        <Tile label={card.cost.usd > 0 ? "Cost" : "Agent time"} value={card.cost.usd > 0 ? `$${card.cost.usd.toFixed(2)}` : `${card.cost.minutes} min`} sub={card.cost.usd > 0 ? `${card.cost.minutes} agent min` : "no spend recorded"} />
        <Tile label="Diff" value={<span><span className="text-sol-text-dim">+</span>{card.diff.added} <span className="text-sol-text-dim">−</span>{card.diff.removed}</span>} sub={`${card.diff.files} file${card.diff.files === 1 ? "" : "s"}`} />
      </div>

      {answer}

      {/* The proof it was broken, in real conversations: the words that were sent. */}
      {seen.length > 0 && (
        <section className="cc-section" data-card-seen>
          <div className="cc-label-row"><h3 className="cc-label">What contacts got today</h3><span className="text-[11px] text-sol-text-dim">{seen.length} of {card.cause.signals} reports</span></div>
          <ul className="ccd-seen">
            {seen.map((c) => (
              <li key={c.key}>
                <blockquote className="ccd-seen-quote">{c.quote}</blockquote>
                <div className="ccd-seen-meta"><span className="min-w-0 truncate">{c.title}</span><span className="shrink-0 tabular-nums">{day(c.at)}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.examples.length > 0 && (
        <section className="cc-section" data-card-examples>
          <div className="cc-label-row"><h3 className="cc-label">Real cases, before and after</h3></div>
          <div className="space-y-4">{card.examples.map((ex, i) => <ExamplePair key={i} ex={ex} />)}</div>
        </section>
      )}

      <ProofStrip card={card} summarized />

      {checks.length > 0 && (
        <section className="cc-section" data-card-checks>
          <div className="cc-label-row"><h3 className="cc-label">Checks</h3></div>
          <ul className="cc-checks">{checks.map((c) => <CheckRow key={c.name} check={c} />)}</ul>
        </section>
      )}

      {card.earlier?.length ? <EarlierFixes earlier={card.earlier} /> : null}
    </article>
  );
}
