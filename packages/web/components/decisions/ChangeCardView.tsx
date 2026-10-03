"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Check, ChevronRight, GitPullRequest, X } from "lucide-react";
import {
  cardVerdictIndexes,
  checksLabel,
  proofSummary,
  riskLabel,
  verdictLabel,
  verdictOfOption,
  type CardCheck,
  type ChangeCard,
  type ChangeVerdict,
} from "@codecast/shared/contracts/changeCard";
import type { DecisionAnswerInput, SessionDecisionItem } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useDecisionDraft } from "../../hooks/useDecisionDraft";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import "./changeCard.css";

// The change card (docs/architecture/the-line-end-to-end.md LE10, LE11) drawn
// natively, one component for every surface that shows a decision about a
// change: the decision page (full), the transcript sheet (inline) and the
// queue's compact card (line). The contract and the helpers that read it
// live in @codecast/shared/contracts/changeCard, the same ones the HTML page
// renderer uses, so the two never tell a card differently.

export type ChangeCardDensity = "full" | "inline" | "line";

const VERDICT_TONE: Record<ChangeVerdict, string> = { ship: "green", revise: "yellow", drop: "red" };
const RISK_TONE: Record<ChangeCard["risk"]["class"], string> = { low: "green", review: "yellow", plan: "red" };

const tokensLabel = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const prLabel = (url: string) => {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? `PR #${n}` : "PR";
};

/**
 * `recommend` draws the card's own verdict. A surface that also shows the
 * Ship / Revise / Drop controls turns it off: ChangeCardAnswer carries the
 * recommendation, so it is said once. `outcome` replaces it once the decision
 * is answered, so a settled card says what happened, not what was proposed.
 * `change` is off where the change sentence already reads nearby: on the line
 * beside the card, and on a full card whose page leads with the change as its
 * title and the cause under it (ChangeCardCause), so the card opens on what
 * was wrong.
 */
export function ChangeCardView({ card, density = "full", recommend = true, change = true, outcome }: { card: ChangeCard; density?: ChangeCardDensity; recommend?: boolean; change?: boolean; outcome?: ReactNode }) {
  const animate = useFirstSight(card.cause.task);
  if (density === "line") return <ChangeCardLine card={card} recommend={recommend && !outcome} change={change} />;
  return <ChangeCardFull card={card} inline={density === "inline"} head={change} recommend={recommend} outcome={outcome} animate={animate} />;
}

/** "evals, judges and users" */
const listLabel = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Why the change exists, in two quiet lines: its task and cause, then the
 * signals behind it (and where they came from), how old it is, and the goal
 * it serves, so the page goes from its title to the evidence in one glance.
 */
export function ChangeCardCause({ card, className = "" }: { card: ChangeCard; className?: string }) {
  const now = useCoarseNow(60_000);
  const hasGoal = card.goal.ref && card.goal.ref !== "none";
  const sources = card.cause.sources.length ? `from ${listLabel(card.cause.sources)}` : "";
  const signals = card.cause.signals > 0 ? `${card.cause.signals} signal${card.cause.signals === 1 ? "" : "s"}` : "";
  const meta: { key: string; node: ReactNode; className?: string; title?: string }[] = [];
  if (signals || sources) meta.push({ key: "signals", node: [signals, sources].filter(Boolean).join(" ") });
  if (card.cause.first_seen) meta.push({ key: "seen", node: `first seen ${formatTimeAgo(card.cause.first_seen, now)}` });
  // The goal it serves; its ref shows on hover.
  if (hasGoal) meta.push({
    key: "goal",
    className: "cc-goal",
    title: card.goal.why || undefined,
    node: <>serves <span className="text-sol-text-muted">{card.goal.name || card.goal.ref}</span>{card.goal.name && <span className="cc-goal-ref">{card.goal.ref}</span>}</>,
  });
  return (
    <div className={`cc-cause ${className}`}>
      <div className="cc-cause-row">
        <Link href={`/tasks/${card.cause.task}`} className="cc-chip text-sol-violet border-sol-violet/30 hover:bg-sol-violet/10">{card.cause.task}</Link>
        <span className="cc-cause-title">{card.cause.title}</span>
      </div>
      {/* Every fact carries its separator and the row clips the one that
          opens a line, so a wrapped line never starts with a dot. */}
      {meta.length > 0 && (
        <div className="cc-cause-facts">
          <div className="cc-cause-row">
            {meta.map((m) => (
              <span key={m.key} className={`cc-cause-meta ${m.className ?? ""}`} title={m.title}><span className="cc-sep" aria-hidden>·</span>{m.node}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const VERDICT_DONE: Record<ChangeVerdict, string> = { ship: "Shipped", revise: "Sent back to revise", drop: "Dropped" };

/** " · 5h ago", " · just now", or " · Sep 3": when a decision settled, as a tail. */
const whenTail = (at: number | undefined, now: number) => {
  const ago = at ? formatTimeAgo(at, now) : "";
  return !ago ? "" : ago === "now" ? " · just now" : /^\d+[mhd]$/.test(ago) ? ` · ${ago} ago` : ` · ${ago}`;
};

/**
 * What a settled card decision came to, so the card's last word matches what
 * happened: the verdict in its tone, who gave it and when, plus the Revise
 * note; or, muted, that it was withdrawn or dismissed with no verdict. Null
 * while pending or when an answer is not one of Ship, Revise and Drop.
 */
export function cardOutcome(decision: Pick<SessionDecisionItem, "status" | "options" | "answer_index" | "answer_text" | "resolved_at" | "answered_by">, by: string, now: number) {
  const when = whenTail(decision.resolved_at, now);
  if (decision.status === "withdrawn" || decision.status === "dismissed") {
    const head = decision.status === "withdrawn" ? "Withdrawn" : "Dismissed";
    const tail = decision.status === "withdrawn" ? `by the agent${when}` : decision.answered_by ? `by ${by}${when}` : when.replace(/^ · /, "");
    return { tone: "dim", verdict: head, pill: `${head} ${tail}`.trim(), line: outcomeLine("dim", head, tail) };
  }
  if (decision.status !== "answered" || decision.answer_index === undefined) return null;
  const verdict = verdictOfOption(decision.options[decision.answer_index]?.label);
  if (!verdict) return null;
  const note = decision.answer_text?.replace(/^revise:\s*/i, "").trim();
  // A default a policy applied is the agent's own course, never a person's answer.
  const wentAhead = decision.answered_by?.kind === "policy";
  const head = wentAhead ? `The agent went ahead with ${verdictLabel(verdict)}` : VERDICT_DONE[verdict];
  const tail = wentAhead ? `no one answered${when}` : `by ${by}${when}`;
  return {
    tone: VERDICT_TONE[verdict],
    verdict: wentAhead ? `Went ahead with ${verdictLabel(verdict)}` : VERDICT_DONE[verdict],
    pill: `${head} ${tail}`,
    line: outcomeLine(VERDICT_TONE[verdict], head, tail, note),
  };
}

function outcomeLine(tone: string, head: string, tail: string, note?: string) {
  return (
    <div className={`cc-outcome cc-tone-${tone}`} data-cc-outcome>
      <span className="cc-outcome-verdict">{head}</span>
      {tail && <span className="text-sol-text-dim">{tail}</span>}
      {note && <span className="basis-full text-sol-text-muted">{note}</span>}
    </div>
  );
}

// The wire fill is the card's one motion moment, and it plays the first time
// a card is seen in this window, never again on a remount (a queue re-sort,
// a sheet reopened, a hot reload). The key is marked seen after commit, so a
// strict mode double render still animates once.
const seenCards = new Set<string>();
function useFirstSight(key: string) {
  const [first] = useState(() => !seenCards.has(key));
  useEffect(() => { seenCards.add(key); }, [key]);
  return first;
}

// ── the proof strip: the card's signature ────────────────────────────────────

/**
 * One mark per red check, a tiny copy of the proof strip's wire: a red dot, a
 * hairline, and its after (green once fixed, red while it still fails). Past
 * three, one mark stands for them all (red if any still fails); the count
 * beside it says how many.
 */
function ProofPips({ card }: { card: ChangeCard }) {
  const after = new Map(card.proof.after.map((c) => [c.name, c.ok]));
  const red = card.proof.before.filter((c) => !c.ok);
  const marks = red.length > 3 ? [red.every((c) => after.get(c.name))] : red.map((c) => !!after.get(c.name));
  if (!marks.length) return null;
  return (
    <span className="cc-pips" aria-hidden>
      {marks.map((fixed, i) => <span key={i} className={`cc-pip ${fixed ? "cc-pip-fixed" : "cc-pip-red"}`} />)}
    </span>
  );
}

/** Diff counts in neutral ink: red and green on the card mean pass and fail, never removed and added. */
function DiffCounts({ diff }: { diff: ChangeCard["diff"] }) {
  return (
    <span className="cc-nowrap cc-diff"><span className="cc-diff-glyph">+</span>{diff.added} <span className="cc-diff-glyph">−</span>{diff.removed}</span>
  );
}

/** The detail most rows share, when at least two share it; rows that say just that show no detail of their own. */
function sharedDetail(details: string[]): string {
  const counts = new Map<string, number>();
  for (const d of details) if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = "";
  let n = 1;
  for (const [d, c] of counts) if (c > n) { best = d; n = c; }
  return best;
}

function ProofStrip({ card }: { card: ChangeCard }) {
  const summary = proofSummary(card.proof);
  const after = new Map(card.proof.after.map((c) => [c.name, c]));
  const red = card.proof.before.filter((c) => !c.ok);
  const broke = card.proof.after.filter((c) => summary.broke.includes(c.name));
  // The before and after most checks share ("fails on origin/main", "passes
  // on the branch") read once, in the header; a row speaks only where it differs.
  const commonBefore = sharedDetail(red.map((b) => b.detail));
  const commonAfter = sharedDetail(red.map((b) => after.get(b.name)?.detail ?? ""));
  return (
    <section className="cc-section" data-cc-proof>
      <div className="cc-label-row">
        <h3 className="cc-label">Proof</h3>
        <span className={`cc-proof-label ${summary.stillRed.length || summary.broke.length ? "cc-text-red" : summary.red ? "cc-text-green" : "text-sol-text-dim"}`}>{summary.label}</span>
        {/* The detail most rows share reads once, beside the headline, keyed
            to the strip by its own red and green dots. */}
        {(commonBefore || commonAfter) && (
          <span className="cc-proof-caption">
            {commonBefore && <span className="cc-legend"><span className="cc-legend-dot cc-dot-red" aria-hidden />{commonBefore}</span>}
            {commonBefore && commonAfter && <span className="cc-arrow" aria-hidden>→</span>}
            {commonAfter && <span className="cc-legend"><span className="cc-legend-dot cc-dot-green" aria-hidden />{commonAfter}</span>}
          </span>
        )}
      </div>
      {red.length === 0 && !broke.length ? (
        <div className="text-[12px] text-sol-text-dim">Nothing was shown failing before the change.</div>
      ) : (
        <ol className="cc-proof">
          {red.map((b, i) => {
            const a = after.get(b.name);
            const fixed = a?.ok === true;
            const beforeText = b.detail || "failed";
            const afterText = a?.detail || (a ? (fixed ? "passes" : "still fails") : "no after recorded");
            // A row that says exactly what the header says shows only its name.
            const shared = fixed && !!commonBefore && !!commonAfter && b.detail === commonBefore && a?.detail === commonAfter;
            return (
              <li key={b.name} className={`cc-proof-row ${fixed ? "is-fixed" : "is-red"}`} style={{ ["--i" as any]: i }}>
                <span className="cc-track" aria-hidden>
                  <span className="cc-dot cc-dot-red" />
                  <span className="cc-wire"><span className="cc-wire-fill" /></span>
                  <span className={`cc-dot ${fixed ? "cc-dot-green" : "cc-dot-red"}`} />
                </span>
                <span className="cc-proof-name">{b.name}</span>
                <span className="cc-proof-detail">
                  {!shared && (
                    <>
                      <span className="cc-proof-before" title={beforeText}>{beforeText}</span>
                      <span className="cc-arrow" aria-hidden>→</span>
                      <span className={`cc-proof-after ${fixed ? "cc-text-green" : "cc-text-red"}`} title={afterText}>{afterText}</span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
          {broke.map((a, i) => (
            <li key={`broke-${a.name}`} className="cc-proof-row is-broke" style={{ ["--i" as any]: red.length + i }}>
              <span className="cc-track" aria-hidden>
                <span className="cc-dot cc-dot-green" />
                <span className="cc-wire"><span className="cc-wire-fill" /></span>
                <span className="cc-dot cc-dot-red" />
              </span>
              <span className="cc-proof-name">{a.name}</span>
              <span className="cc-proof-detail"><span className="cc-proof-after cc-text-red" title={a.detail || undefined}>broke: {a.detail || "fails after the change"}</span></span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── the full card ────────────────────────────────────────────────────────────

function CheckRow({ check }: { check: CardCheck }) {
  return (
    <li className="cc-check">
      <span className={`cc-check-mark ${check.ok ? "cc-tone-green" : "cc-tone-red"}`}>
        {check.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      </span>
      <span className="text-sol-text shrink-0">{check.name}</span>
      {check.detail && <span className="text-sol-text-dim min-w-0">{check.detail}</span>}
    </li>
  );
}

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether an example's input says anything its Before does not: one whose Before is the input's opening (or any run of it) only repeats it, so it is dropped. */
export function exampleInputAdds(input: string, before: string): boolean {
  const i = squash(input);
  const b = squash(before);
  return !!i && !(b && i.includes(b));
}

/** One before and after pair: the input as a quiet quote that opens in full, two tiles of one height, the note under both. The Evals pages show eval flips with it too. */
export function ExamplePair({ ex, extra = false }: { ex: ChangeCard["examples"][number]; extra?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cc-example ${extra ? "cc-example-extra" : ""}`}>
      {exampleInputAdds(ex.input, ex.before) && (
        <button type="button" className={`cc-example-input ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? undefined : "Show the full input"}>
          {ex.input}
        </button>
      )}
      <div className="cc-pair">
        <div className="cc-side cc-before"><span className="cc-side-label">Before</span><span>{ex.before}</span></div>
        <div className="cc-side cc-after"><span className="cc-side-label">After</span><span>{ex.after}</span></div>
      </div>
      {ex.note && <p className="cc-example-note">{ex.note}</p>}
    </div>
  );
}

function ChangeCardFull({ card, inline, head, recommend, outcome, animate }: { card: ChangeCard; inline: boolean; head: boolean; recommend: boolean; outcome?: ReactNode; animate: boolean }) {
  const [allExamples, setAllExamples] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  // Two pairs show on a wide card, one on a phone or in the transcript sheet
  // (CSS hides the second there, .cc-example-extra); the rest wait behind a toggle.
  const examples = allExamples ? card.examples : card.examples.slice(0, 2);
  const hidden = card.examples.length - examples.length;
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  const checksPassed = card.checks.filter((c) => c.ok).length;
  // A failing check is news, so it shows without asking; passing ones wait behind the count.
  const showChecks = checksOpen || checksPassed < card.checks.length;
  return (
    <article className={`change-card ${inline ? "cc-inline" : "cc-full"} ${animate ? "cc-animate" : ""}`} data-change-card={card.cause.task}>
      {/* The box is the proposal, so it opens on that. The verdict it
          recommends reads here when the card is the one to say it; beside
          answer controls the controls say it, and a settled card ends on
          what happened instead. */}
      <div className={`cc-card-head cc-tone-${outcome ? "dim" : tone}`} data-cc-head>
        <span className="cc-card-head-dot" aria-hidden />
        <span>{outcome ? "Change proposed" : "Change ready"}</span>
        {!outcome && recommend && <span className="cc-sep-before">Recommends {verdictLabel(card.recommend.verdict)}</span>}
      </div>
      {/* Cause: why this run exists, one quiet line above the decision. */}
      {head && <header><ChangeCardCause card={card} /></header>}

      {/* The decision itself: the change speaks for itself, what was wrong supports it. */}
      <div className="cc-sentences">
        {head && <p className="cc-change">{card.change}</p>}
        <p className="cc-wrong"><span className="cc-leadin">What was wrong:</span> {card.wrong}</p>
      </div>

      <ProofStrip card={card} />

      {card.examples.length > 0 && (
        <section className="cc-section">
          <div className="cc-label-row"><h3 className="cc-label">Examples</h3><span className="text-[12px] text-sol-text-dim">before and after</span></div>
          <div className="space-y-4">
            {examples.map((ex, i) => <ExamplePair key={i} ex={ex} extra={!allExamples && i === 1} />)}
          </div>
          {card.examples.length > 1 && !allExamples && (
            <button type="button" onClick={() => setAllExamples(true)} className={`cc-more ${hidden ? "" : "is-narrow-only"}`} data-cc-more>
              {/* The narrow count includes the second pair, which CSS hides there. */}
              <span className="cc-more-wide">and {hidden} more</span>
              <span className="cc-more-narrow">and {hidden + 1} more</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </section>
      )}

      <div className="cc-facts-block">
        <dl className="cc-facts">
          {card.checks.length > 0 && (
            <div className="cc-fact">
              <dt className="cc-label">Checks</dt>
              <dd>
                <button type="button" className="cc-checks-toggle" onClick={() => setChecksOpen((o) => !o)} aria-expanded={showChecks} data-cc-checks>
                  {checksPassed === card.checks.length
                    ? <span><span className="text-sol-text-dim">all</span> <span className="cc-text-green">{checksPassed} pass</span></span>
                    : <span className="cc-text-red">{card.checks.length - checksPassed} of {card.checks.length} fail</span>}
                  <ChevronRight className={`w-3 h-3 text-sol-text-dim transition-transform ${showChecks ? "rotate-90" : ""}`} />
                </button>
              </dd>
            </div>
          )}
          <div className="cc-fact">
            <dt className="cc-label">Diff</dt>
            <dd>
              <DiffCounts diff={card.diff} />
              <span className="text-sol-text-dim cc-nowrap"> in {card.diff.files} file{card.diff.files === 1 ? "" : "s"}</span>
              {card.diff.pr && (
                <a href={card.diff.pr} target="_blank" rel="noreferrer" className="cc-pr"><GitPullRequest className="w-3 h-3" />{prLabel(card.diff.pr)}</a>
              )}
            </dd>
          </div>
          <div className="cc-fact cc-fact-risk">
            <dt className="cc-label">Risk</dt>
            <dd><span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span><div className="cc-fact-sub">{card.risk.reason}</div></dd>
          </div>
          <div className="cc-fact">
            <dt className="cc-label">Cost</dt>
            <dd>
              <span className="cc-nowrap">${card.cost.usd.toFixed(2)}</span>
              <div className="cc-fact-sub"><span className="cc-nowrap">{tokensLabel(card.cost.tokens)} tokens</span><span className="cc-nowrap cc-sep-before">{card.cost.minutes} min</span></div>
            </dd>
          </div>
        </dl>
        {showChecks && card.checks.length > 0 && <ul className="cc-checks">{card.checks.map((c) => <CheckRow key={c.name} check={c} />)}</ul>}
      </div>

      {outcome ?? (recommend && (
        <div className={`cc-recommend cc-tone-${tone}`}>
          <span className="cc-recommend-verdict">Why {verdictLabel(card.recommend.verdict)}</span>
          <span className="text-sol-text-muted">{card.recommend.why}</span>
        </div>
      ))}
    </article>
  );
}

// ── the queue's line ─────────────────────────────────────────────────────────

function ChangeCardLine({ card, recommend, change }: { card: ChangeCard; recommend: boolean; change: boolean }) {
  const summary = proofSummary(card.proof);
  const checksOk = card.checks.every((c) => c.ok);
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  return (
    <div className="change-card cc-line" data-change-card={card.cause.task}>
      {change && card.change && <div className="cc-line-change" title={card.change}>{card.change}</div>}
      <div className="cc-line-row">
        {/* Each item after the first carries its own separator (cc-sep-before),
            so a wrapped line never starts with one. */}
        <span className="cc-nowrap inline-flex items-center"><ProofPips card={card} /><span className={summary.stillRed.length || summary.broke.length ? "cc-text-red" : "text-sol-text"} title={summary.label}>{summary.short}</span></span>
        <span className={`cc-nowrap cc-sep-before ${checksOk ? "text-sol-text-muted" : "cc-text-red"}`}>{checksLabel(card.checks)}</span>
        <span className={`cc-nowrap cc-sep-before cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span>
        {recommend && <span className={`cc-line-verdict cc-tone-${tone}`}>recommends {verdictLabel(card.recommend.verdict)}</span>}
      </div>
    </div>
  );
}

// ── Ship / Revise / Drop ─────────────────────────────────────────────────────

/** The card's answer controls, or null when the decision's options are not Ship, Revise and Drop. */
export function cardAnswerIndexes(decision: Pick<SessionDecisionItem, "card" | "kind" | "options">) {
  if (!decision.card || (decision.kind ?? "single") !== "single") return null;
  return cardVerdictIndexes(decision.options);
}

/**
 * Whether a window key may reach answer controls: no modifier, no modal, and,
 * when the surface scoped its keys, focus inside that surface. A card that
 * shares a window with a transcript answers only while it is the thing in
 * focus, so a digit typed anywhere else never answers it.
 */
export function answerKeyAllowed(e: KeyboardEvent, scope?: RefObject<HTMLElement | null>): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return false;
  // Shift and a digit belongs to the page (the line jumps stations with it),
  // even on a layout where that chord still reports a bare digit.
  if (e.shiftKey && /^(Digit|Numpad)\d$/.test(e.code)) return false;
  if (!scope) return true;
  const root = scope.current;
  return !!root && root.contains(document.activeElement);
}

/**
 * Keyboard first: the option's digit answers Ship and Drop at once; Revise
 * opens a note, and return sends it. The note travels with the Revise answer,
 * so a gate routes on Revise and hands the note to build. An advisory card
 * says the agent already went ahead with its default and stays answerable
 * after an answer is on record, so a person can still change course.
 */
export function ChangeCardAnswer({
  decision,
  indexes,
  onAnswer,
  onDismiss,
  keys = false,
  keyScope,
  size = "full",
  record,
}: {
  decision: SessionDecisionItem;
  indexes: Record<ChangeVerdict, number>;
  /** The answer on record, said in full (cardOutcome's pill), so the bar names who chose it and when. */
  record?: string;
  onAnswer: (input: DecisionAnswerInput) => void;
  onDismiss?: () => void;
  keys?: boolean;
  /** Keys live only while focus is inside this element (answerKeyAllowed). */
  keyScope?: RefObject<HTMLElement | null>;
  size?: "full" | "compact";
}) {
  // The note and whether it is open live in the decision's draft, so a fold
  // or a page change never loses a half-written Revise.
  const [draft, patchDraft] = useDecisionDraft<{ note: string; noteOpen: boolean }>(decision._id);
  const noteOpen = !!draft.noteOpen;
  const note = draft.note ?? "";
  const setNoteOpen = useCallback((open: boolean) => patchDraft({ noteOpen: open }), [patchDraft]);
  const setNote = useCallback((text: string) => patchDraft({ note: text }), [patchDraft]);
  const [error, setError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const recommended = decision.card?.recommend.verdict;
  const why = decision.card?.recommend.why;
  const verdictAt = (i: number | undefined) => (i === undefined ? undefined : (Object.keys(indexes) as ChangeVerdict[]).find((v) => indexes[v] === i));
  // An advisory ask's agent went on with its default before anyone answered.
  const pending = decision.status === "pending";
  const wentAhead = pending && !decision.blocking ? verdictAt(decision.default_option) : undefined;
  // An answer on record that a new pick replaces (advisoryAnswerOpen).
  const current = pending ? undefined : verdictAt(decision.answer_index);

  const openNote = useCallback(() => { setNoteOpen(true); setTimeout(() => noteRef.current?.focus(), 0); }, [setNoteOpen]);
  const sendRevise = useCallback(() => {
    const t = note.trim();
    if (!t) { setError(true); noteRef.current?.focus(); return; }
    onAnswer({ index: indexes.revise, text: `Revise: ${t}` });
  }, [note, onAnswer, indexes.revise]);
  const pick = useCallback((v: ChangeVerdict) => {
    if (v === "revise") openNote();
    else onAnswer({ index: indexes[v] });
  }, [onAnswer, indexes, openNote]);

  useWatchEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (!answerKeyAllowed(e, keyScope)) return;
      const target = e.target as HTMLElement | null;
      if (target === noteRef.current) {
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setNoteOpen(false); setError(false); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); sendRevise(); }
        return;
      }
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT")) return;
      const n = Number(e.key) - 1;
      const verdict = (Object.keys(indexes) as ChangeVerdict[]).find((v) => indexes[v] === n);
      if (verdict && verdict !== current) { e.preventDefault(); e.stopImmediatePropagation(); pick(verdict); return; }
      if ((e.key === "x" || e.key === "X") && onDismiss) { e.preventDefault(); e.stopImmediatePropagation(); onDismiss(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, keyScope, indexes, current, pick, sendRevise, onDismiss, setNoteOpen]);

  const compact = size === "compact";
  const order: ChangeVerdict[] = (["ship", "revise", "drop"] as ChangeVerdict[]).sort((a, b) => indexes[a] - indexes[b]);
  return (
    <div className="change-card-answer" data-card-answer>
      {(wentAhead || current) && (
        <p className="cc-course" data-cc-course>
          {wentAhead ? <>The agent went ahead with <span className={`cc-text-${VERDICT_TONE[wentAhead]}`}>{verdictLabel(wentAhead)}</span>. Pick another to change course.</> : <>{record ? `${record}. ` : ""}Pick another to change course.</>}
        </p>
      )}
      <div className={`cc-verdicts ${compact ? "is-compact" : ""}`}>
        {order.map((v) => (
          <button
            key={v}
            onClick={() => pick(v)}
            disabled={current === v}
            data-verdict={v}
            className={`cc-verdict cc-tone-${VERDICT_TONE[v]} ${recommended === v && !current ? "is-recommended" : ""} ${current === v ? "is-current" : ""} ${v === "revise" && noteOpen ? "is-open" : ""}`}
            title={decision.options[indexes[v]]?.description}
          >
            {keys && indexes[v] < 9 && current !== v && <KeyCap size="xs">{String(indexes[v] + 1)}</KeyCap>}
            <span>{verdictLabel(v)}</span>
            {current === v ? <span className="cc-verdict-tag">on record</span> : recommended === v && !current && <span className="cc-verdict-tag">recommended</span>}
          </button>
        ))}
        {onDismiss && (
          <button onClick={onDismiss} className="cc-dismiss" title="Dismiss without answering" aria-label="Dismiss without answering">
            {keys ? <KeyCap size="xs">x</KeyCap> : null}<X className="cc-dismiss-icon w-3.5 h-3.5" /><span className="cc-dismiss-label">dismiss</span>
          </button>
        )}
      </div>
      {recommended && why && !noteOpen && !current && size !== "compact" && (
        <p className={`cc-why cc-tone-${VERDICT_TONE[recommended]}`}><span className="cc-why-verdict">Why {verdictLabel(recommended)}:</span> {why}</p>
      )}
      {noteOpen && (
        <div className="cc-note cc-tone-yellow">
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => { setNote(e.target.value); if (error) setError(false); }}
            rows={compact ? 2 : 3}
            placeholder="What should change? This goes back to build."
            className={`cc-note-field ${error ? "is-error" : ""}`}
            onKeyDown={(e) => {
              if (keys) return; // the window listener has it
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendRevise(); }
              if (e.key === "Escape") { setNoteOpen(false); setError(false); }
            }}
          />
          <div className="flex items-center gap-3 mt-1 text-[11px] text-sol-text-dim">
            <button onClick={sendRevise} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">return</KeyCap><span>send Revise</span></button>
            <button onClick={() => { setNoteOpen(false); setError(false); }} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">esc</KeyCap><span>cancel</span></button>
            {error && <span className="cc-text-red">Say what should change.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
