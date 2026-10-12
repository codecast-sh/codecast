"use client";
// A proposal gate laid out for the person deciding it, from the change card's
// own building blocks (ChangeCardDecision): one yes/no question, what a
// contact gets today against after the proposed change, the size, proof,
// cause and risk as tiles, the facts it is decided against (the rule it
// breaks, an unmerged fix it builds on, other open cards on the same code),
// the recommended answer and why, the answers, the one real conversation
// that shows it, and the full proposal folded away for whoever reads it.
//
// A judge-review proposal (`tooling`) changes codecast's own review, not the
// product: its case reads as what the judge said, what it read and what was
// really there.
import type { ReactNode } from "react";
import type { ProposalAudience, ProposalCard, ProposalVerdict } from "@codecast/shared/contracts/proposalCard";
import { riskLabel } from "@codecast/shared/contracts/changeCard";
import { OverturnsLine, SeenQuote, type SeenCase } from "./ChangeCardDecision";
import { CardFacts, type CardFactsProps } from "./CardFacts";
import "./changeCard.css";

const RISK_TONE = { low: "green", review: "yellow", plan: "red" } as const;
const VERDICT_WORD: Record<ProposalVerdict, string> = { build: "Build it", revise: "Revise", wait: "Not now" };
const VERDICT_TONE: Record<ProposalVerdict, string> = { build: "green", revise: "yellow", wait: "red" };
/** Whose words the case quotes: a change to what callers or the team are shown is not something a contact received. */
const CASE_LABEL: Record<ProposalAudience, string> = { contact: "What a contact got today", member: "What a member got today", caller: "What the caller was told", team: "What our team was shown" };
/** "backend/src/lib/email/x.ts:49-50" as the file's name and line, the path a hover away. */
const shortWhere = (w: string) => w.split("/").pop() ?? w;

/** What the run's proof showed, in a tile's words. */
function proofTile(proof: ProposalCard["proof"]) {
  if (!proof) return { value: "–", sub: "not recorded", tone: "" };
  // Only a real conversation replayed on main shows the miss happens; a code test shows the mechanism.
  const replay = proof.rung === "replay";
  if (proof.outcome === "red") return replay ? { value: "Reproduced", sub: "a real case replayed on main", tone: "cc-text-green" } : { value: "Test only", sub: "a code test fails on main", tone: "" };
  if (proof.outcome === "infeasible") return { value: "Not shown", sub: "no check could show it", tone: "cc-text-yellow" };
  return { value: proof.outcome || "–", sub: replay ? "a real case replayed on main" : "a code test on main", tone: "" };
}

/** `gone`: where the problem's evidence went when none is left; the Conversations tile then reads stale. */
/** `noCase`: why the card has no live conversation to show ("sg-2470 judged again: not a defect"); the case block says so instead of vanishing. */
export function ProposalCardDecision({ card, answer, seen, impact, live, gone, doc, noCase, tooling, facts }: {
  card: ProposalCard;
  answer: ReactNode;
  seen?: SeenCase | null;
  impact?: string;
  live?: number;
  gone?: string;
  doc?: ReactNode;
  noCase?: string | null;
  tooling?: "judge" | "extractor" | null;
  facts?: CardFactsProps;
}) {
  // One conversation behind a change that reaches many (any risk above low) is a single case, said on the tile.
  const thin = live === 1 && card.risk.class !== "low" && (card.measured?.count ?? 0) <= 1;
  const proof = proofTile(card.proof);
  const rec = card.recommend;
  return (
    <article className="change-card cc-full" data-proposal-card data-proposal-tooling={tooling ?? undefined}>
      <header className="ccd-head">
        <h1 className="ccd-title" data-card-headline>{card.question}</h1>
      </header>

      <div className="ccd-shift" data-card-shift>
        <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.today}</div>
        <div className="ccd-side ccd-after"><span className="ccd-side-label">After this fix</span>{card.after}</div>
      </div>

      {card.overturns && <OverturnsLine o={card.overturns} />}

      <CardFacts {...facts} ruleLabel={tooling ? "Rule the judge applied" : "Rule"} />

      <div className="ccd-tiles" data-card-tiles>
        <div className={`ccd-tile ${gone ? "is-bad" : ""}`}>
          <div className="ccd-tile-label">Conversations</div>
          <div className="ccd-tile-value">{gone ? <span className="cc-text-red">0</span> : live ?? "–"}</div>
          {gone
            ? <div className="ccd-tile-sub"><span className="cc-text-red">No current evidence</span><br />{gone}</div>
            : thin
              ? <div className="ccd-tile-sub" title="One conversation behind a change that would reach many: the case may be a one-off"><span className="cc-text-yellow" data-card-thin>thin evidence</span>{impact ? <><br />{impact}</> : null}</div>
              : impact && <div className="ccd-tile-sub">{impact}</div>}
        </div>
        {card.measured && (
          <div className="ccd-tile" data-card-measured title={card.measured.method === "replay" ? "Real cases replayed on main by the run" : "Counted by the run in Union's record, read-only; not the problem's findings"}>
            <div className="ccd-tile-label">Measured</div>
            <div className="ccd-tile-value"><span className={card.measured.count > 0 ? "" : "text-sol-text-dim"}>{card.measured.count}<span className="text-sol-text-dim font-normal"> of {card.measured.of}</span></span>{card.measured.after !== undefined && <span className="text-sol-green font-normal text-[13px]">→ {card.measured.after}</span>}</div>
            <div className="ccd-tile-sub">{card.measured.window}</div>
          </div>
        )}
        <div className="ccd-tile" data-card-proof title={card.proof?.prior_art ? `Also run with ${card.proof.prior_art}` : undefined}>
          <div className="ccd-tile-label">Proof</div>
          <div className="ccd-tile-value"><span className={proof.tone}>{proof.value}</span></div>
          <div className="ccd-tile-sub">{proof.sub}</div>
        </div>
        <div className="ccd-tile">
          <div className="ccd-tile-label">Cause</div>
          <div className="ccd-tile-sub ccd-tile-cause">{card.cause.line}</div>
        </div>
        <div className="ccd-tile ccd-tile-wrap">
          <div className="ccd-tile-label">Risk</div>
          <div className="ccd-tile-value"><span className="inline-flex items-center gap-1.5"><span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden /><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk, true).replace(/ risk$/, "")}</span></span></div>
          <div className="ccd-tile-sub">{card.risk.reason}</div>
        </div>
      </div>

      {rec && (
        <p className={`cc-why cc-tone-${VERDICT_TONE[rec.verdict]}`} data-cc-recommended data-proposal-verdict={rec.verdict}>
          <span className="cc-why-lead">{VERDICT_WORD[rec.verdict]} recommended:</span> {rec.why}
        </p>
      )}

      {answer}

      {(seen || noCase) && (
        <section className="cc-section" data-card-seen>
          <div className="cc-label-row"><h3 className="cc-label">{tooling ? "What the judge saw vs what was there" : CASE_LABEL[card.case?.to ?? "contact"]}</h3></div>
          {seen ? <ul className="ccd-seen"><SeenQuote c={seen} /></ul> : <p className="ccd-nocase" data-card-nocase><b>No case on file</b> · {noCase}</p>}
        </section>
      )}

      {/* Where it lives is for whoever opens the proposal; the card is the decision. */}
      <details className="cc-section ccd-doc" data-proposal-doc>
        <summary className="cc-label cursor-pointer">Full proposal</summary>
        <div className="mt-3 flex flex-wrap gap-1.5" data-proposal-where>
          {card.cause.where.map((w) => <code key={w} className="ccd-where" title={w}>{shortWhere(w)}</code>)}
        </div>
        {doc && <div className="mt-3">{doc}</div>}
      </details>
    </article>
  );
}

export { VERDICT_WORD as PROPOSAL_VERDICT_WORD, VERDICT_TONE as PROPOSAL_VERDICT_TONE };
