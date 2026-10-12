"use client";
// A change card laid out for the person deciding it (the-line-end-to-end.md
// LE10, LE11), self-contained: what changes and for whom, today against after,
// the numbers that decide it as tiles (reports, proof, checks, risk, cost,
// diff), the three answers each saying what they do, then the real cases
// before and after and the evidence under them. Built from ChangeCardView's
// own pieces, so every fact reads the way the queue reads it.
import type { ReactNode } from "react";
import { cardChecks, honestChecks, checkNotRun, proofSummary, riskLabel, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { CheckRow, EarlierFixes, ExamplePair, ProofDots, commandCaseName, riskReason } from "./ChangeCardView";
import "./changeCard.css";

const RISK_TONE: Record<ChangeCard["risk"]["class"], string> = { low: "green", review: "yellow", plan: "red" };
const firstSentence = (t: string) => (t.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? t).replace(/^On this (local )?branch,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase());
const RISK_SUB: Record<ChangeCard["risk"]["class"], string> = { low: "safe to ship on the proof", review: "a person should look first", plan: "needs its own plan" };
/** A risk reason that only restates the level says nothing a tile does not. */
const genericRisk = (r: string) => !r || /^(an agent rated it|ground rated it|not grounded yet)/i.test(r.trim());
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

/** The proof in one yardstick on every card: fixed or not, and what it was proven on. */
function proofTile(card: ChangeCard) {
  const s = proofSummary(card.proof);
  if (!s.red) return { value: "none", sub: "no failing case shown", tone: "", title: "" };
  const bad = s.stillRed.length + s.broke.length;
  const names = card.proof.before.filter((c) => !c.ok).map((c) => commandCaseName(c.name) ?? c.name);
  const kind = names.length === 1 ? (names[0] === "Replay" ? "on a replayed real case" : names[0] === "Repro test" ? "by a test of the miss" : `by ${names[0].toLowerCase()}`) : `on ${s.red} cases`;
  const last = card.proof.after.map((c) => c.detail.trim().split("\n").filter(Boolean).pop() ?? "").filter(Boolean).join("\n");
  return {
    value: bad ? `${s.fixed} of ${s.red} fixed` : "Fixed",
    sub: s.broke.length ? `${s.broke.length} new failure${s.broke.length === 1 ? "" : "s"}` : kind,
    tone: bad ? "cc-text-red" : "cc-text-green",
    title: last,
  };
}

/** A finding behind the cause, as the card shows it: what was sent, to whom, when. */
export type SeenCase = { key: string; title: string; quote: string; at: number };

export function ChangeCardDecision({ card, answer, seen = [] }: { card: ChangeCard; answer: ReactNode; seen?: SeenCase[] }) {
  const own = honestChecks(card.checks);
  const failing = own.filter((c) => !c.ok);
  const ran = own.filter((c) => !checkNotRun(c));
  const notRun = own.filter((c) => checkNotRun(c));
  const proof = proofTile(card);
  const proofBad = cardChecks(card)[0]?.ok === false;
  // Failing checks lead the evidence; one that never ran sits last.
  const checks = [...failing, ...own.filter((c) => c.ok && !checkNotRun(c)), ...own.filter((c) => c.ok && checkNotRun(c))];
  return (
    <article className="change-card cc-full" data-change-card={card.cause.task} data-card-decision>
      <header className="ccd-head">
        {/* A card written before headlines leads with its change's first sentence; the whole change reads beside Today. */}
        <h1 className="ccd-title" data-card-headline title={card.context || undefined}>{card.headline || firstSentence(card.change)}</h1>
      </header>

      <div className="ccd-shift" data-card-shift>
        <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.wrong}</div>
        {card.change && <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{card.change}</div>}
      </div>

      <div className="ccd-tiles" data-card-tiles>
        <Tile label="Reports" value={card.cause.signals || "–"} sub={card.cause.first_seen ? `when built · since ${day(card.cause.first_seen)}` : "when built"} title="Reports behind the problem when this fix was built; the problem page counts them live" />
        <Tile label="Proof" value={<><ProofDots card={card} /><span className={proof.tone}>{proof.value}</span></>} sub={proof.sub} title={proof.title || undefined} className={proofBad ? "is-bad" : ""} />
        <Tile
          label="Checks"
          value={<span className={failing.length ? "cc-text-red" : "cc-text-green"}>{failing.length ? `${failing.length} fails` : `${ran.length} pass`}</span>}
          sub={[failing.length ? failing.map((c) => c.name).join(", ") : "", notRun.length ? `${notRun.map((c) => c.name.toLowerCase()).join(", ")} not run` : ""].filter(Boolean).join(" · ") || undefined}
          className={notRun.length ? "is-partial" : ""}
        />
        <Tile
          label="Risk"
          value={<span className="inline-flex items-center gap-1.5"><span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden /><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk, true).replace(/ risk$/, "")}</span></span>}
          sub={genericRisk(card.risk.reason) ? RISK_SUB[card.risk.class] : riskReason(card.risk)}
          title={riskReason(card.risk)}
        />
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

      <section className="cc-section ccd-examples" data-card-examples>
        <div className="cc-label-row"><h3 className="cc-label">Real cases, before and after</h3></div>
        {card.examples.length > 0
          ? <div className="space-y-4">{card.examples.map((ex, i) => <ExamplePair key={i} ex={ex} />)}</div>
          : <p className="ccd-gap" data-card-no-examples>No real conversation was replayed after the change, so how it writes to a contact is not shown.</p>}
      </section>

      {checks.length > 0 && (
        <section className="cc-section" data-card-checks>
          <div className="cc-label-row"><h3 className="cc-label">Checks</h3></div>
          <ul className="cc-checks">{checks.map((c) => <CheckRow key={c.name} check={c} detail={checkNotRun(c) ? "not run in the trial" : c.detail.replace(/^handoff status (\w+)$/, "the builder marked its handoff $1")} />)}</ul>
        </section>
      )}

      {card.earlier?.length ? <EarlierFixes earlier={card.earlier} /> : null}

      {/* What it took and how big it is: footnotes, not reasons to decide. */}
      <p className="ccd-foot" data-card-foot title={`+${card.diff.added} −${card.diff.removed} lines in ${card.diff.files} file${card.diff.files === 1 ? "" : "s"}, tests and fixtures included`}>
        <span>Built in {card.cost.minutes} agent min{card.cost.usd > 0 ? ` · $${card.cost.usd.toFixed(2)}` : ""}</span>
        {card.diff.pr && <a href={card.diff.pr} target="_blank" rel="noreferrer" className="hover:text-sol-blue">pull request</a>}
      </p>
    </article>
  );
}
