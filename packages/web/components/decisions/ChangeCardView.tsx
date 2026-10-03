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

/** Why the change exists: its task and cause, the signals behind it, and the goal it serves. */
export function ChangeCardCause({ card, className = "" }: { card: ChangeCard; className?: string }) {
  const now = useCoarseNow(60_000);
  const hasGoal = card.goal.ref && card.goal.ref !== "none";
  const meta = [
    card.cause.signals > 0 ? `${card.cause.signals} signal${card.cause.signals === 1 ? "" : "s"}` : "",
    card.cause.first_seen ? `first seen ${formatTimeAgo(card.cause.first_seen, now)}` : "",
  ].filter(Boolean);
  return (
    <div className={`cc-cause ${className}`}>
      <div className="cc-cause-row">
        <Link href={`/tasks/${card.cause.task}`} className="cc-chip text-sol-violet border-sol-violet/30 hover:bg-sol-violet/10">{card.cause.task}</Link>
        <span className="cc-cause-title">{card.cause.title}</span>
      </div>
      {(meta.length > 0 || card.cause.sources.length > 0) && (
        <div className="cc-cause-row">
          {meta.map((m, i) => <span key={m} className="cc-cause-meta">{i > 0 && <span className="cc-sep" aria-hidden>·</span>}{m}</span>)}
          {card.cause.sources.map((src) => <span key={src} className="cc-source">{src}</span>)}
        </div>
      )}
      {/* The goal it serves, one muted line; its ref shows on hover. */}
      {hasGoal && (
        <div className="cc-cause-row cc-goal" title={card.goal.why || undefined}>
          serves <span className="text-sol-text-muted">{card.goal.name || card.goal.ref}</span>
          {card.goal.name && <span className="cc-goal-ref">{card.goal.ref}</span>}
        </div>
      )}
    </div>
  );
}

const VERDICT_DONE: Record<ChangeVerdict, string> = { ship: "Shipped", revise: "Sent back to revise", drop: "Dropped" };

/**
 * What a settled card decision came to: the verdict in its tone, who gave it
 * and when, plus the Revise note. Null while pending or when the answer is not
 * one of Ship, Revise and Drop.
 */
export function cardOutcome(decision: Pick<SessionDecisionItem, "status" | "options" | "answer_index" | "answer_text" | "resolved_at" | "answered_by">, by: string, now: number) {
  if (decision.status !== "answered" || decision.answer_index === undefined) return null;
  const verdict = verdictOfOption(decision.options[decision.answer_index]?.label);
  if (!verdict) return null;
  const ago = decision.resolved_at ? formatTimeAgo(decision.resolved_at, now) : "";
  const when = !ago ? "" : ago === "now" ? " · just now" : /^\d+[mhd]$/.test(ago) ? ` · ${ago} ago` : ` · ${ago}`;
  const note = decision.answer_text?.replace(/^revise:\s*/i, "").trim();
  // A default a policy applied is the agent's own course, never a person's answer.
  const wentAhead = decision.answered_by?.kind === "policy";
  const head = wentAhead ? `The agent went ahead with ${verdictLabel(verdict)}` : VERDICT_DONE[verdict];
  const tail = wentAhead ? `no one answered${when}` : `by ${by}${when}`;
  return {
    tone: VERDICT_TONE[verdict],
    verdict: wentAhead ? `Went ahead with ${verdictLabel(verdict)}` : VERDICT_DONE[verdict],
    pill: `${head} ${tail}`,
    line: (
      <div className={`cc-outcome cc-tone-${VERDICT_TONE[verdict]}`} data-cc-outcome>
        <span className="cc-outcome-verdict">{head}</span>
        <span className="text-sol-text-dim">{tail}</span>
        {note && <span className="basis-full text-sol-text-muted">{note}</span>}
      </div>
    ),
  };
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
 * hairline, and its after (green once fixed, red while it still fails).
 */
function ProofPips({ card }: { card: ChangeCard }) {
  const after = new Map(card.proof.after.map((c) => [c.name, c.ok]));
  const red = card.proof.before.filter((c) => !c.ok);
  return (
    <span className="cc-pips" aria-hidden>
      {red.map((c, i) => (
        <span key={i} className={`cc-pip ${after.get(c.name) ? "cc-pip-fixed" : "cc-pip-red"}`} />
      ))}
    </span>
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
      </div>
      {red.length === 0 && !broke.length ? (
        <div className="text-[12px] text-sol-text-dim">Nothing was shown failing before the change.</div>
      ) : (
        <ol className="cc-proof">
          {/* Column labels sit over the dots they name; the detail most rows
              share reads once, as the caption beside them. */}
          <li className="cc-proof-head">
            <span className="cc-track-labels" aria-hidden><span>before</span><span>after</span></span>
            {(commonBefore || commonAfter) && (
              <span className="cc-proof-caption">
                {commonBefore && <span className="cc-text-red">{commonBefore}</span>}
                {commonBefore && commonAfter && <span className="cc-arrow" aria-hidden>→</span>}
                {commonAfter && <span className="cc-text-green">{commonAfter}</span>}
              </span>
            )}
          </li>
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

/** One before and after pair: the input as a quiet quote that opens in full, two tiles of one height, the note under both. */
function ExamplePair({ ex }: { ex: ChangeCard["examples"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cc-example">
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
  const examples = allExamples ? card.examples : card.examples.slice(0, 1);
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  const checksPassed = card.checks.filter((c) => c.ok).length;
  // A failing check is news, so it shows without asking; passing ones wait behind the count.
  const showChecks = checksOpen || checksPassed < card.checks.length;
  return (
    <article className={`change-card ${inline ? "cc-inline" : "cc-full"} ${animate ? "cc-animate" : ""}`} data-change-card={card.cause.task}>
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
            {examples.map((ex, i) => <ExamplePair key={i} ex={ex} />)}
          </div>
          {card.examples.length > examples.length && (
            <button onClick={() => setAllExamples(true)} className="mt-3 text-[12px] text-sol-blue hover:underline">
              Show all {card.examples.length} examples
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
                  <span className={checksPassed === card.checks.length ? "cc-text-green" : "cc-text-red"}>{checksPassed}/{card.checks.length}</span>
                  <span className="text-sol-text-dim">pass</span>
                  <ChevronRight className={`w-3 h-3 text-sol-text-dim transition-transform ${showChecks ? "rotate-90" : ""}`} />
                </button>
              </dd>
            </div>
          )}
          <div className="cc-fact">
            <dt className="cc-label">Diff</dt>
            <dd>
              <span className="cc-nowrap"><span className="cc-text-green">+{card.diff.added}</span> <span className="cc-text-red">−{card.diff.removed}</span></span>
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
          <span className="cc-recommend-verdict">Recommends {verdictLabel(card.recommend.verdict)}</span>
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
        <span className="cc-nowrap cc-sep-before"><span className="cc-text-green">+{card.diff.added}</span> <span className="cc-text-red">−{card.diff.removed}</span></span>
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
}: {
  decision: SessionDecisionItem;
  indexes: Record<ChangeVerdict, number>;
  onAnswer: (input: DecisionAnswerInput) => void;
  onDismiss?: () => void;
  keys?: boolean;
  /** Keys live only while focus is inside this element (answerKeyAllowed). */
  keyScope?: RefObject<HTMLElement | null>;
  size?: "full" | "compact";
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
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

  const openNote = useCallback(() => { setNoteOpen(true); setTimeout(() => noteRef.current?.focus(), 0); }, []);
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
  }, [keys, keyScope, indexes, current, pick, sendRevise, onDismiss]);

  const compact = size === "compact";
  const order: ChangeVerdict[] = (["ship", "revise", "drop"] as ChangeVerdict[]).sort((a, b) => indexes[a] - indexes[b]);
  return (
    <div className="change-card-answer" data-card-answer>
      {(wentAhead || current) && (
        <p className="cc-course" data-cc-course>
          {wentAhead ? <>The agent went ahead with <span className={`cc-text-${VERDICT_TONE[wentAhead]}`}>{verdictLabel(wentAhead)}</span>. Pick another to change course.</> : <>Pick another to change course.</>}
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
