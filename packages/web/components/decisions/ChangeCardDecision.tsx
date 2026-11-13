"use client";
// A change card laid out for the person deciding it (the-line-end-to-end.md
// LE10, LE11), self-contained: what changes and for whom, today against after,
// the numbers that decide it as tiles (reports, proof, checks, risk, cost,
// diff), the three answers each saying what they do, then the real cases
// before and after and the evidence under them. Built from ChangeCardView's
// own pieces, so every fact reads the way the queue reads it.
import { useTaskHref } from "../../lib/taskHrefContext";
import { useMemo, useState, type ReactNode } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { cardChecks, honestChecks, checkNotRun, runVerify, evalsOwed as evalsOwedCheck, proofSummary, riskLabel, type CardOverturns, type ChangeCard } from "@codecast/shared/contracts/changeCard";
import { CheckRow, EarlierFixes, ExamplePair, checkShort, commandCaseName, riskReason } from "./ChangeCardView";
import { severityWord } from "../tasks/impact";
import { CardFacts, type CardFactsProps } from "./CardFacts";
import "./changeCard.css";

const RISK_TONE: Record<ChangeCard["risk"]["class"], string> = { low: "green", review: "yellow", plan: "red" };
const firstSentence = (t: string) => (t.trim().match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? t).replace(/^On this (local )?branch,\s*/i, "").replace(/^\w/, (c) => c.toUpperCase());
const RISK_SUB: Record<ChangeCard["risk"]["class"], string> = { low: "safe to ship on the proof", review: "needs a person's review", plan: "needs its own plan" };
/** A risk reason that only restates the level says nothing a tile does not. */
const genericRisk = (r: string) => !r || /^(an agent rated it|ground rated it|not grounded yet)/i.test(r.trim());
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function Tile({ label, value, sub, title, className = "", open, onToggle }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; className?: string; open?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      <div className="ccd-tile-label">{label}</div>
      <div className="ccd-tile-value">{value}</div>
      {sub && <div className="ccd-tile-sub">{sub}</div>}
    </>
  );
  // A tile that holds a list opens it in place: the figure is the one reading, the list is one press away.
  return onToggle
    ? <button type="button" className={`ccd-tile ccd-tile-open ${className}`} title={title} aria-expanded={!!open} onClick={onToggle} data-card-tile={label}>{body}</button>
    : <div className={`ccd-tile ${className}`} title={title}>{body}</div>;
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
/** `claim`: on a judge-review card, what the judge said was wrong; the quote is then what it read, and `missing` what was really there. */
export type SeenCase = { key: string; title: string; quote: string; asked?: string; missing?: string; at: number; finding?: boolean; claim?: string; beats?: Array<{ at: string; who: "contact" | "caller" | "tip"; text: string }> };

const BEAT_WHO_LABEL = { contact: "Contact", caller: "Caller", tip: "Tip on screen" } as const;

/** One conversation as the card quotes it: the contact's situation, the words sent, what they leave out, and when. */
export function SeenQuote({ c }: { c: SeenCase }) {
  return (
    <li>
      {c.asked && <div className="ccd-seen-asked" data-seen-asked><span className="ccd-side-label">Situation</span>{c.asked}</div>}
      {c.claim && <div className="ccd-seen-claim" data-seen-claim><span className="ccd-side-label">Judge said</span>{c.claim}</div>}
      {c.quote && !c.beats?.length && <blockquote className={`ccd-seen-quote ${c.finding ? "is-finding" : ""}`} data-seen-finding={c.finding ? "" : undefined}>{c.quote}</blockquote>}
      {!!c.beats?.length && (
        <ol className="ccd-beats" data-seen-beats>
          {c.beats.map((b, i) => (
            <li key={i} className={`is-${b.who}`}>
              <span className="ccd-beat-at tabular-nums">{b.at}</span>
              <span className="ccd-beat-who">{BEAT_WHO_LABEL[b.who]}</span>
              <span className="ccd-beat-text">{b.text}</span>
            </li>
          ))}
        </ol>
      )}
      {c.missing && <div className="ccd-seen-missing" data-seen-missing><span className="ccd-side-label">{c.claim ? "What was there" : "Missing"}</span>{c.missing}</div>}
      <div className="ccd-seen-meta" title={c.title}><span className="tabular-nums">{day(c.at)}</span></div>
    </li>
  );
}

/** Where a reversed call lives: a task, a trial card on the review page, or a decision. */
const overturnsHref = (ref: string, taskHref: (ref: string) => string) => (ref.startsWith("ct-") ? taskHref(ref) : ref.startsWith("tc-") ? `/trial?card=${ref}` : `/decisions/${ref}`);

/** A card that undoes an earlier call says so before the numbers, so the person knows what they would reverse. */
export function OverturnsLine({ o }: { o: CardOverturns }) {
  const taskHref = useTaskHref();
  return (
    <p className="ccd-overturns" data-card-overturns>
      <span className="ccd-side-label">Changes an earlier call</span>
      <a href={overturnsHref(o.ref, taskHref)} className="font-mono hover:underline">{o.ref}</a>
      <span className="text-sol-text-dim">{o.by}:</span>
      <span>{o.what}</span>
      {o.why && <span className="ccd-overturns-why" data-card-overturns-why><span className="ccd-side-label">Why change it</span>{o.why}</span>}
    </p>
  );
}

/** `impact`: how bad it was for the contacts, in the problem page's words ("1 noticed by the contact", "likely unnoticed"). */
/** `worst`: the worst severity a judge gave, for a surface that has no impact line yet; it reads in the same words. */
/** `live`: the problem's conversations now (the card's own count is from when it was built and is never shown). */
/** `gone`: where the problem's evidence went when none is left ("moved to ct-59425"); the card then reads stale. */
/** `problem`: the problem's title now; a card built under another title, or on another count, says the problem changed since. */
/** `coverage`: the live conversations against what the author read (lineTrial.coverageOf): reached, read and left out, arrived since the card. */
/** `owed`: the eval suites the diff owes and nobody ran; Ship then waits on them, shown as a blocking step on the Checks tile. */
/** `facts`: the rule, an unmerged fix it builds on, and other open cards on the same code (CardFacts). */
/** `runId`: the run the card was built on; when the store holds it, the card's Verify reads the run's own Verify step (one figure on both). */
export function ChangeCardDecision({ card: stored, answer, seen = [], impact: impactIn, worst, live, gone, problem, coverage, owed, facts, runId }: { card: ChangeCard; answer: ReactNode; seen?: SeenCase[]; impact?: string; worst?: number; live?: number; gone?: string; problem?: string; coverage?: { covered: number; other: number; fresh: number; gone: number } | null; owed?: string[]; facts?: CardFactsProps; runId?: string | null }) {
  // A card built before its CLI counted the verify step's own checks carries other words for Verify than the run row: read the run's.
  const verifyNode = useInboxStore((s) => (runId ? ((s.workflowRuns as Record<string, { node_statuses?: Array<{ node_id: string }> }> | undefined)?.[runId]?.node_statuses?.find((n) => n.node_id === "verify") ?? null) : null));
  const card = useMemo(() => {
    const v = verifyNode ? runVerify([verifyNode as never]) : null;
    return v && stored.checks.some((c) => c.name === "Verify") ? { ...stored, checks: stored.checks.map((c) => (c.name === "Verify" ? v : c)) } : stored;
  }, [stored, verifyNode]);
  const [checksOpen, setChecksOpen] = useState(false);
  // A change that reaches none of the problem's conversations now has no case of its own to show.
  const noneCovered = !gone && coverage?.covered === 0 && !!live;
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
  // With the author's per-finding reading, the live conversations split into reached, left out on purpose, and arrived since: no guessing whether the uncovered ones are the same miss.
  const reach = coverage && live !== undefined
    ? { conversations: coverage.covered, of: live }
    : card.reach && live !== undefined ? { conversations: Math.min(card.reach.conversations, live), of: live } : card.reach;
  const partial = reach && reach.conversations < reach.of;
  const retitled = !!problem && problem.trim() !== card.cause.title.trim();
  const regrown = !coverage && !!card.reach && live !== undefined && card.reach.of !== live;
  const changed = !gone && (retitled || regrown);
  const evalOwed = evalsOwedCheck(card);
  const owedN = owed?.length || (evalOwed ? 1 : 0);
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

      {/* A change that undoes someone's earlier call says so before the numbers, so the person knows what they would reverse. */}
      {card.overturns && <OverturnsLine o={card.overturns} />}

      <CardFacts {...facts} />

      <div className="ccd-tiles" data-card-tiles>
        {gone
          ? <Tile label="Conversations" value={<span className="cc-text-red">0</span>} sub={<><span className="cc-text-red">No current evidence</span><br />{gone}</>} className="is-bad" title="Every finding behind this problem has left it, so nothing is left for this change to fix" />
          : (
            <Tile
              label="Conversations"
              value={reach
                ? <span className={reach.conversations === 0 ? "cc-text-red" : partial ? "cc-text-yellow" : ""} data-card-reach>{reach.conversations}<span className="ccd-tile-of"> of {reach.of}</span></span>
                : live ?? "–"}
              sub={<>
                {reach && reach.conversations === 0 && <span className="cc-text-red" data-card-reach-none>none covered now<br /></span>}
                {coverage && partial && (coverage.other > 0 || coverage.fresh > 0) && (
                  <span data-card-coverage title="Of the conversations this change does not reach: the ones its author read and judged another cause, and the ones that joined the problem after the card was written (not yet read; a recard reads them)">
                    {[coverage.other ? `${coverage.other} other cause` : "", coverage.fresh ? `${coverage.fresh} new since card` : ""].filter(Boolean).join(" · ")}<br />
                  </span>
                )}
                {changed && (
                  <span
                    className="cc-text-yellow"
                    title={`This card was written for "${card.cause.title}"${card.reach ? ` on ${card.reach.of} conversations` : ""}. The problem is now${retitled ? ` "${problem}"` : ""}${live !== undefined ? ` with ${live}` : ""}: what the change covers may be a slice of it.`}
                    data-card-changed
                  >problem changed since this card<br /></span>
                )}
                {[impact ?? "", card.cause.first_seen ? `since ${day(card.cause.first_seen)}` : ""].filter(Boolean).join(" · ")}
              </>}
              title="How many of the problem's conversations now this change reaches, why the rest are left, and how many the contact noticed (a judge's 7 or more of 10)"
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
            sub={<>{card.stops.basis && <span data-card-stops-basis>{card.stops.basis}<br /></span>}{card.stops.next}</>}
            className="ccd-tile-wrap"
            title="What this change stops sending per week, what the count was taken over, and what the contact hears instead"
          />
        )}
        {/* An eval the change owes and nobody ran blocks Ship: it reads as the step left, not as a pass. */}
        <Tile
          label="Checks"
          value={failing.length
            ? <span className="cc-text-red">{failing.length} failing</span>
            : owedN ? <span className="cc-text-yellow" data-card-evals-owed>{owedN} {owedN === 1 ? "eval" : "evals"} owed</span>
            : <span className="cc-text-green">{ran.length} pass</span>}
          sub={failing.length ? failing.map((c) => c.name).join(", ") : owedN ? `${ran.length} pass · run ${owed?.length ? owed.join(", ") : "the eval"} before Ship` : undefined}
          className={owedN && !failing.length ? "ccd-tile-wrap" : ""}
          open={checksOpen}
          onToggle={own.length ? () => setChecksOpen((o) => !o) : undefined}
        />
        <Tile
          label="Risk"
          value={<span className="inline-flex items-center gap-1.5"><span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden /><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk, true).replace(/ risk$/, "")}</span></span>}
          sub={genericRisk(card.risk.reason) ? RISK_SUB[card.risk.class] : riskReason(card.risk)}
          className="ccd-tile-wrap"
        />
      </div>
      {checksOpen && own.length > 0 && (
        // Every check in one row, failing first, then not run, then passed: one reading, never "passed" above a red list.
        <ul className="cc-checks ccd-checkrow" data-card-checks>{[...checks, ...own.filter((c) => c.ok && !checkNotRun(c))].map((c) => <CheckRow key={c.name} check={c} detail={checkShort(c)} />)}</ul>
      )}

      {answer}

      {/* The proof it was broken, in real conversations: the words that were sent. */}
      {noneCovered && seen.length === 0 && card.examples.length === 0 && (
        <section className="cc-section" data-card-seen>
          <p className="ccd-nocase" data-card-nocase><b>No case this change covers</b> · {live} {live === 1 ? "conversation" : "conversations"} on the problem, none it reaches</p>
        </section>
      )}
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


      {card.earlier?.length ? <EarlierFixes earlier={card.earlier} /> : null}

    </article>
  );
}
