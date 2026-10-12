"use client";
// A change card laid out for the person deciding it (the-line-end-to-end.md
// LE10, LE11), self-contained: what changes and for whom, today against after,
// the numbers that decide it as tiles (reports, proof, checks, risk, cost,
// diff), the three answers each saying what they do, then the real cases
// before and after and the evidence under them. Built from ChangeCardView's
// own pieces, so every fact reads the way the queue reads it.
import type { ReactNode } from "react";
import { cardChecks, honestChecks, checkNotRun, proofSummary, riskLabel, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { CheckRow, EarlierFixes, ExamplePair, checkShort, commandCaseName, riskReason } from "./ChangeCardView";
import { severityWord } from "../tasks/impact";
import "./changeCard.css";

const RISK_TONE: Record<ChangeCard["risk"]["class"], string> = { low: "green", review: "yellow", plan: "red" };
const firstSentence = (t: string) => (t.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? t).replace(/^On this (local )?branch,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase());
const RISK_SUB: Record<ChangeCard["risk"]["class"], string> = { low: "safe to ship on the proof", review: "needs a person's review", plan: "needs its own plan" };
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

/**
 * The proof in one yardstick on every card: fixed or not, and what it was
 * proven on. "Fixed" is earned only by a real conversation replayed before and
 * after; a code test passing reads "Test passes" in a neutral tone, and a
 * synthetic replay says it was synthetic. `real` says whether the card's
 * before/after cases were observed (a replay) or are what the fix should do.
 */
export function proofTile(card: ChangeCard) {
  const s = proofSummary(card.proof);
  if (!s.red) return { value: "none", sub: "no failing case shown", tone: "", title: "", real: false };
  const bad = s.stillRed.length + s.broke.length;
  const names = card.proof.before.filter((c) => !c.ok).map((c) => commandCaseName(c.name) ?? c.name);
  const last = card.proof.after.map((c) => c.detail.trim().split("\n").filter(Boolean).pop() ?? "").filter(Boolean).join("\n");
  // An eval's proven freeze is a real conversation replayed ("Real case N"); a Replay command is one only when the card shows the real case it ran on.
  const evalReal = names.some((n) => /^Real case \d+$/.test(n));
  const replay = names.some((n) => n === "Replay");
  const real = evalReal || (replay && card.examples.length > 0);
  const synthetic = replay && !real;
  const draws = /(\d+) of (\d+) draws/.exec(last)?.[2];
  const kind = real ? (s.red === 1 ? "on a replayed real case" : `on ${s.red} replayed real cases`) : synthetic ? `synthetic ${Number(draws ?? s.red) === 1 ? "replay" : "replays"}, 0 real cases` : names.length === 1 && names[0] !== "Repro test" ? `${names[0].toLowerCase()} only` : "code test only";
  return {
    value: bad ? `${s.fixed} of ${s.red} fixed` : real ? "Fixed" : synthetic ? `Passes ×${draws ?? s.red}` : "Test passes",
    sub: s.broke.length ? `${s.broke.length} new failure${s.broke.length === 1 ? "" : "s"}` : kind,
    tone: bad ? "cc-text-red" : real ? "cc-text-green" : synthetic ? "cc-text-yellow" : "",
    title: last,
    real,
  };
}

/** A finding behind the cause, as the card shows it: the words sent (or, when no sent words show the miss, the
 *  finding's own text), the contact's stated need they broke, and when. */
export type SeenCase = { key: string; title: string; quote: string; asked?: string; missing?: string; at: number; finding?: boolean };

/** One conversation as the card quotes it: the contact's situation, the words sent, what they leave out, and when. */
export function SeenQuote({ c }: { c: SeenCase }) {
  return (
    <li>
      {c.asked && <div className="ccd-seen-asked" data-seen-asked><span className="ccd-side-label">Situation</span>{c.asked}</div>}
      <blockquote className={`ccd-seen-quote ${c.finding ? "is-finding" : ""}`} data-seen-finding={c.finding ? "" : undefined}>{c.quote}</blockquote>
      {c.missing && <div className="ccd-seen-missing" data-seen-missing><span className="ccd-side-label">Missing</span>{c.missing}</div>}
      <div className="ccd-seen-meta" title={c.title}><span className="tabular-nums">{day(c.at)}</span></div>
    </li>
  );
}

/** `impact`: how bad it was for the contacts, in the problem page's words ("1 noticed by the contact", "likely unnoticed"). */
/** `worst`: the worst severity a judge gave, for a surface that has no impact line yet; it reads in the same words. */
/** `live`: the problem's conversations now (the card's own count is from when it was built and is never shown). */
/** `gone`: where the problem's evidence went when none is left ("moved to ct-59425"); the card then reads stale. */
/** `problem`: the problem's title now; a card built under another title, or on another count, says the problem changed since. */
export function ChangeCardDecision({ card, answer, seen = [], impact: impactIn, worst, live, gone, problem }: { card: ChangeCard; answer: ReactNode; seen?: SeenCase[]; impact?: string; worst?: number; live?: number; gone?: string; problem?: string }) {
  const impact = impactIn ?? (worst ? severityWord(worst) : undefined);
  const own = honestChecks(card.checks);
  const failing = own.filter((c) => !c.ok);
  const ran = own.filter((c) => !checkNotRun(c));
  const notRun = own.filter((c) => checkNotRun(c));
  const proof = proofTile(card);
  const proofBad = cardChecks(card)[0]?.ok === false;
  // Failing checks lead the evidence; one that never ran sits last.
  const checks = [...failing, ...notRun];
  // One count everywhere: the problem's conversations now. The author's reach is out of that count, never the one the card was built on.
  const reach = card.reach && live !== undefined ? { conversations: Math.min(card.reach.conversations, live), of: live } : card.reach;
  const partial = reach && reach.conversations < reach.of;
  const retitled = !!problem && problem.trim() !== card.cause.title.trim();
  const regrown = !!card.reach && live !== undefined && card.reach.of !== live;
  const changed = !gone && (retitled || regrown);
  return (
    <article className="change-card cc-full" data-change-card={card.cause.task} data-card-decision data-card-stale={gone ? "" : undefined}>
      <header className="ccd-head">
        {/* A card written before headlines leads with its change's first sentence; the whole change reads beside Today. */}
        <h1 className="ccd-title" data-card-headline title={card.context || undefined}>{card.headline || firstSentence(card.change)}</h1>
      </header>

      {/* What a contact gets, before and after, in the author's words; what the proof printed sits on the Proof tile. */}
      <div className="ccd-shift" data-card-shift>
        <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.wrong}</div>
        {card.change && <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{card.change}</div>}
      </div>

      <div className="ccd-tiles" data-card-tiles>
        {gone
          ? <Tile label="Conversations" value={<span className="cc-text-red">0</span>} sub={<><span className="cc-text-red">No current evidence</span><br />{gone}</>} className="is-bad" title="Every finding behind this problem has left it, so nothing is left for this change to fix" />
          : (
            <Tile
              label="Conversations"
              value={live ?? "–"}
              sub={<>
                {reach && <span className={partial ? "cc-text-yellow" : ""} data-card-reach>covers {reach.conversations} of {reach.of}<br /></span>}
                {changed && (
                  <span
                    className="cc-text-yellow"
                    title={`This card was written for "${card.cause.title}"${card.reach ? ` on ${card.reach.of} conversations` : ""}. The problem is now${retitled ? ` "${problem}"` : ""}${live !== undefined ? ` with ${live}` : ""}: what the change covers may be a slice of it.`}
                    data-card-changed
                  >problem changed since this card<br /></span>
                )}
                {[impact ?? "", card.cause.first_seen ? `since ${day(card.cause.first_seen)}` : ""].filter(Boolean).join(" · ")}
              </>}
              title="Conversations behind the problem now, how many of them this change reaches, and how many the contact noticed (a judge's 7 or more of 10)"
              className="ccd-tile-wrap"
            />
          )}
        {/* With no evidence left, a proof is history: it fixed a case that no longer counts, so it reads dim, never green beside a 0. */}
        {gone
          ? <Tile label="Proof" value={<span className="text-sol-text-dim">{proof.real ? "Was fixed" : proof.value}</span>} sub={`${proof.real ? "an earlier case" : proof.sub}; no live case now`} title={proof.title || undefined} />
          : <Tile label="Proof" value={<span className={proof.tone}>{proof.value}</span>} sub={proof.sub} title={proof.title || undefined} className={proofBad ? "is-bad" : ""} />}
        {card.stops && (
          <Tile
            label="Stops"
            value={<span className="cc-text-yellow" data-card-stops>~{card.stops.per_week} {card.stops.what}/wk</span>}
            sub={card.stops.next}
            className="ccd-tile-wrap"
            title="What this change stops sending, per week on the replayed window, and what the contact hears instead"
          />
        )}
        <Tile
          label="Checks"
          value={<span className={failing.length ? "cc-text-red" : "cc-text-green"}>{failing.length ? `${failing.length} failing` : `${ran.length} pass`}</span>}
          sub={failing.length ? failing.map((c) => c.name).join(", ") : undefined}
        />
        <Tile
          label="Risk"
          value={<span className="inline-flex items-center gap-1.5"><span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden /><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk, true).replace(/ risk$/, "")}</span></span>}
          sub={genericRisk(card.risk.reason) ? RISK_SUB[card.risk.class] : riskReason(card.risk)}
          className="ccd-tile-wrap"
        />
      </div>

      {answer}

      {/* The proof it was broken, in real conversations: the words that were sent. */}
      {seen.length > 0 && card.examples.length === 0 && (
        <section className="cc-section" data-card-seen>
          <div className="cc-label-row"><h3 className="cc-label">What contacts got today</h3>{live ? <span className="text-[11px] text-sol-text-dim">{seen.length} of {live} conversations</span> : null}</div>
          <ul className="ccd-seen">{seen.map((c) => <SeenQuote key={c.key} c={c} />)}</ul>
        </section>
      )}

      {/* Cases before and after: observed when a real case was replayed, otherwise what the fix should do (the Proof tile says which). */}
      {card.examples.length > 0 && (
        <section className="cc-section ccd-examples" data-card-examples data-card-examples-real={proof.real ? "" : undefined}>
          <div className="cc-label-row"><h3 className="cc-label">{gone ? "Earlier cases, no longer counted" : proof.real ? "Real cases, before and after" : "Real cases, and what should happen"}</h3></div>
          <div className="space-y-4">{card.examples.map((ex, i) => <ExamplePair key={i} ex={ex} afterLabel={proof.real ? "After" : "Expected"} />)}</div>
        </section>
      )}

      {own.length > 0 && (
        <section className="cc-section" data-card-checks>
          <div className="cc-label-row"><h3 className="cc-label">Checks</h3></div>
          {/* Every check in one row, failing first, then not run, then passed: one reading, never "passed" above a red list. */}
          <ul className="cc-checks ccd-checkrow">{[...checks, ...own.filter((c) => c.ok && !checkNotRun(c))].map((c) => <CheckRow key={c.name} check={c} detail={checkShort(c)} />)}</ul>
        </section>
      )}

      {card.earlier?.length ? <EarlierFixes earlier={card.earlier} /> : null}

    </article>
  );
}
