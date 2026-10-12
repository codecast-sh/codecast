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

/** The proof in one yardstick on every card: fixed or not, and what it was proven on. */
function proofTile(card: ChangeCard) {
  const s = proofSummary(card.proof);
  if (!s.red) return { value: "none", sub: "no failing case shown", tone: "", title: "" };
  const bad = s.stillRed.length + s.broke.length;
  const names = card.proof.before.filter((c) => !c.ok).map((c) => commandCaseName(c.name) ?? c.name);
  const kind = names.length === 1 ? (names[0] === "Replay" ? "on a replayed real case" : names[0] === "Repro test" ? "code test only" : `by ${names[0].toLowerCase()}`) : `on ${s.red} cases`;
  const last = card.proof.after.map((c) => c.detail.trim().split("\n").filter(Boolean).pop() ?? "").filter(Boolean).join("\n");
  // A test of the miss proves the code path, not what a contact reads; only a real conversation shown before and after earns "Fixed".
  const realCase = card.examples.length > 0;
  const replayed = !realCase && names.some((n) => n === "Replay");
  const draws = /(\d+) of (\d+) draws/.exec(last)?.[2];
  return {
    value: bad ? `${s.fixed} of ${s.red} fixed` : realCase ? "Fixed" : replayed ? `Fixed ×${draws ?? s.red}` : "Test passes",
    sub: s.broke.length ? `${s.broke.length} new failure${s.broke.length === 1 ? "" : "s"}` : replayed ? `synthetic ${Number(draws ?? s.red) === 1 ? "replay" : "replays"}, 0 real cases` : kind,
    tone: bad ? "cc-text-red" : replayed ? "cc-text-yellow" : "cc-text-green",
    title: last,
  };
}

/** What a replay proof itself printed: the prompts it changed, and its RED and GREEN verdict lines, before and after. Null when the proof is not one. */
export function replayShift(card: ChangeCard): { prompts: string[]; before: string; after: string } | null {
  const lineOf = (cs: ChangeCard["proof"]["before"], tag: string) => cs.map((c) => c.detail.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${tag}:`))).find(Boolean) ?? null;
  const before = lineOf(card.proof.before, "RED");
  const after = lineOf(card.proof.after, "GREEN");
  if (!before || !after) return null;
  const said = [...card.proof.after, ...card.proof.before].map((c) => /prompt texts? changed[^:]*:\s*([^\n]+)/i.exec(c.detail)?.[1]).find(Boolean);
  return { prompts: said ? said.split(/\s*,\s*/).filter(Boolean) : [], before: before.replace(/^RED:\s*/, ""), after: after.replace(/^GREEN:\s*/, "") };
}

/** A finding behind the cause, as the card shows it: what was sent, to whom, when. */
export type SeenCase = { key: string; title: string; quote: string; at: number };

/** `worst`: the worst severity a judge gave the problem's findings (1 to 10), when the surface knows it. */
/** `live`: the problem's conversations now, when the surface counts them (the card's own number is from when it was built). */
export function ChangeCardDecision({ card, answer, seen = [], worst, live }: { card: ChangeCard; answer: ReactNode; seen?: SeenCase[]; worst?: number; live?: number }) {
  const own = honestChecks(card.checks);
  const failing = own.filter((c) => !c.ok);
  const ran = own.filter((c) => !checkNotRun(c));
  const notRun = own.filter((c) => checkNotRun(c));
  const proof = proofTile(card);
  const shift = replayShift(card);
  const proofBad = cardChecks(card)[0]?.ok === false;
  // Failing checks lead the evidence; one that never ran sits last.
  const checks = [...failing, ...notRun];
  return (
    <article className="change-card cc-full" data-change-card={card.cause.task} data-card-decision>
      <header className="ccd-head">
        {/* A card written before headlines leads with its change's first sentence; the whole change reads beside Today. */}
        <h1 className="ccd-title" data-card-headline title={card.context || undefined}>{card.headline || firstSentence(card.change)}</h1>
      </header>

      {shift ? (
        <>
          {shift.prompts.length > 0 && (
            <div className="ccd-prompts" data-card-prompts={shift.prompts.length}>
              <span className="ccd-side-label">Prompts changed</span>
              {shift.prompts.map((p) => <code key={p} className="ccd-prompt">{p}</code>)}
            </div>
          )}
          <div className="ccd-shift" data-card-shift="replay" title={`${card.wrong}\n\n${card.change}`}>
            <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{shift.before}</div>
            <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{shift.after}</div>
          </div>
        </>
      ) : (
        <div className="ccd-shift" data-card-shift>
          <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.wrong}</div>
          {card.change && <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{card.change}</div>}
        </div>
      )}

      <div className="ccd-tiles" data-card-tiles>
        <Tile label={live ? "Conversations" : "Reports"} value={live || card.cause.signals || "–"} sub={[worst ? `worst ${worst}/10` : "", card.cause.first_seen ? `since ${day(card.cause.first_seen)}` : ""].filter(Boolean).join(" · ") || undefined} title="Reports behind the problem when this fix was built, and the worst severity a judge gave one (9-10 breaks trust, 7-8 the contact noticed, 5-6 likely unnoticed)" />
        <Tile label="Proof" value={<span className={proof.tone}>{proof.value}</span>} sub={proof.sub} title={proof.title || undefined} className={proofBad ? "is-bad" : ""} />
        <Tile
          label="Checks"
          value={<span className={failing.length ? "cc-text-red" : "cc-text-green"}>{failing.length ? `${failing.length} failing` : `${ran.length} pass`}</span>}
          sub={failing.length ? failing.map((c) => c.name).join(", ") : notRun.length ? "wider tests not run" : undefined}
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
      {seen.length > 0 && card.examples.length === 0 && (
        <section className="cc-section" data-card-seen>
          <div className="cc-label-row"><h3 className="cc-label">What contacts got today</h3><span className="text-[11px] text-sol-text-dim">{seen.length} of {live || card.cause.signals} {live ? "conversations" : "reports"}</span></div>
          <ul className="ccd-seen">
            {seen.map((c) => (
              <li key={c.key}>
                <blockquote className="ccd-seen-quote">{c.quote}</blockquote>
                <div className="ccd-seen-meta" title={c.title}><span className="tabular-nums">{day(c.at)}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cc-section ccd-examples" data-card-examples>
        <div className="cc-label-row"><h3 className="cc-label">Real cases, before and after</h3></div>
        {card.examples.length > 0
          ? <div className="space-y-4">{card.examples.map((ex, i) => <ExamplePair key={i} ex={ex} />)}</div>
          : <p className="ccd-gap" data-card-no-examples>0 real cases replayed</p>}
      </section>

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
