"use client";
// A proposal gate laid out for the person deciding it, from the change card's
// own building blocks (ChangeCardDecision): one yes/no question, what a
// contact gets today against after the proposed change, the size, cause and
// risk as tiles, the answers, the one real conversation that shows it, and
// the full proposal (where it lives in the code, and the document) folded
// away for whoever wants to read it.
import type { ReactNode } from "react";
import type { ProposalCard } from "@codecast/shared/contracts/proposalCard";
import { riskLabel } from "@codecast/shared/contracts/changeCard";
import { SeenQuote, type SeenCase } from "./ChangeCardDecision";
import "./changeCard.css";

const RISK_TONE = { low: "green", review: "yellow", plan: "red" } as const;
/** "backend/src/lib/email/x.ts:49-50" as the file's name and line, the path a hover away. */
const shortWhere = (w: string) => w.split("/").pop() ?? w;

/** `gone`: where the problem's evidence went when none is left; the Conversations tile then reads stale. */
export function ProposalCardDecision({ card, answer, seen, impact, live, gone, doc }: { card: ProposalCard; answer: ReactNode; seen?: SeenCase | null; impact?: string; live?: number; gone?: string; doc?: ReactNode }) {
  return (
    <article className="change-card cc-full" data-proposal-card>
      <header className="ccd-head">
        <h1 className="ccd-title" data-card-headline>{card.question}</h1>
      </header>

      <div className="ccd-shift" data-card-shift>
        <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.today}</div>
        <div className="ccd-side ccd-after"><span className="ccd-side-label">After this fix</span>{card.after}</div>
      </div>

      <div className="ccd-tiles ccd-tiles-3" data-card-tiles>
        <div className={`ccd-tile ${gone ? "is-bad" : ""}`}>
          <div className="ccd-tile-label">Conversations</div>
          <div className="ccd-tile-value">{gone ? <span className="cc-text-red">0</span> : live ?? "–"}</div>
          {gone ? <div className="ccd-tile-sub"><span className="cc-text-red">No current evidence</span><br />{gone}</div> : impact && <div className="ccd-tile-sub">{impact}</div>}
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

      {answer}

      {seen && (
        <section className="cc-section" data-card-seen>
          <div className="cc-label-row"><h3 className="cc-label">What a contact got today</h3></div>
          <ul className="ccd-seen"><SeenQuote c={seen} /></ul>
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
