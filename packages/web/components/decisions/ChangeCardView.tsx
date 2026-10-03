"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Check, ChevronRight, GitPullRequest, X } from "lucide-react";
import { toast } from "sonner";
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
export function ChangeCardView({ card, density = "full", recommend = true, change = true, outcome, story = false, summarized = false, meta }: { card: ChangeCard; density?: ChangeCardDensity; recommend?: boolean; change?: boolean; outcome?: ReactNode; story?: boolean; summarized?: boolean; meta?: ReactNode }) {
  const animate = useFirstSight(card.cause.task);
  if (density === "line") return <ChangeCardLine card={card} recommend={recommend && !outcome} change={change} story={story} meta={meta} />;
  return <ChangeCardFull card={card} inline={density === "inline"} head={change} recommend={recommend} outcome={outcome} animate={animate} summarized={summarized} />;
}

/** "evals, judges and users" */
const listLabel = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * A row of short facts that wraps without ever opening a line on a separator:
 * every item carries its own leading dot and the row clips the one that lands
 * at a line's start. `plain` items (chips with their own border) carry a blank
 * spacer of the same width instead, so the rhythm holds. `end` pushes an item
 * to the right of its line; `row` gives an item a line of its own.
 */
export function SepRow({ items, className = "" }: { items: { key: string; node: ReactNode; className?: string; title?: string; plain?: boolean; end?: boolean; row?: boolean }[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={`cc-seprow ${className}`}>
      <div className="cc-seprow-inner">
        {/* An item whose body renders nothing hides, separator and all. */}
        {items.map((m) => (
          <span key={m.key} className={["cc-seprow-item", m.end && "is-end", m.row && "is-row"].filter(Boolean).join(" ")} title={m.title}>
            <span className="cc-sep" aria-hidden>{m.plain ? "" : "·"}</span>
            <span className={`cc-seprow-body ${m.className ?? ""}`}>{m.node}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

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
  const seen = card.cause.first_seen ? `first seen ${formatTimeAgo(card.cause.first_seen, now)}` : "";
  const meta: Parameters<typeof SepRow>[0]["items"] = [];
  if (signals || sources) meta.push({ key: "signals", node: [signals, sources].filter(Boolean).join(" ") });
  // Age and goal share one fact, so a narrow card spends one line on them.
  // The goal's ref shows on hover.
  if (seen || hasGoal) meta.push({
    key: "seen",
    className: hasGoal ? "cc-goal" : "cc-nowrap",
    title: (hasGoal && card.goal.why) || undefined,
    node: (
      <span>
        {seen && <span className="cc-nowrap">{seen}</span>}
        {seen && hasGoal && <span className="cc-sep-inline" aria-hidden> · </span>}
        {hasGoal && <>serves <span className="text-sol-text-muted">{card.goal.name || card.goal.ref}</span>{card.goal.name && <span className="cc-goal-ref"> {card.goal.ref}</span>}</>}
      </span>
    ),
  });
  return (
    <div className={`cc-cause ${className}`}>
      {/* The chip sits in the title's first line and the title wraps beside it. */}
      <p className="cc-cause-head">
        <Link href={`/tasks/${card.cause.task}`} className="cc-chip text-sol-violet border-sol-violet/30 hover:bg-sol-violet/10">{card.cause.task}</Link>
        <span className="cc-cause-title">{card.cause.title}</span>
      </p>
      <SepRow items={meta} className="cc-cause-facts" />
    </div>
  );
}

/**
 * A change card's headline, the same wherever a card is the decision: the
 * change as the title, the asker's own question under it (dim, when it says
 * something else), then the cause. The card below it opens on what was wrong.
 */
/** The asker's own question beside a card, or null when it only repeats the change. */
export const cardAskedQuestion = (card: ChangeCard, question: string | undefined) => (question && question.trim() !== card.change.trim() ? question : null);

export function ChangeCardHeadline({ card, question, className = "" }: { card: ChangeCard; question?: string; className?: string }) {
  const asked = cardAskedQuestion(card, question);
  return (
    <div className={className}>
      <h1 className="cc-change cc-change-title">{card.change}</h1>
      {asked && <p className="mt-1.5 text-[13px] leading-snug text-sol-text-dim" data-card-question>{asked}</p>}
      <ChangeCardCause card={card} className="mt-3" />
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

/** Diff counts in neutral ink: red and green on the card mean pass and fail, never removed and added. */
function DiffCounts({ diff }: { diff: ChangeCard["diff"] }) {
  return (
    <span className="cc-nowrap cc-diff"><span className="cc-diff-glyph">+</span>{diff.added} <span className="cc-diff-glyph">−</span>{diff.removed}</span>
  );
}

/** The detail most rows share, when at least two share it; rows that say just that show it dimmed, so every row keeps one rhythm. */
function sharedDetail(details: string[]): string {
  const counts = new Map<string, number>();
  for (const d of details) if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = "";
  let n = 1;
  for (const [d, c] of counts) if (c > n) { best = d; n = c; }
  return best;
}

/**
 * Check names read "<group> · <case>" ("titlePrompt.test.ts · greeting is
 * never the title"). A group every row shares reads once, beside the
 * headline; otherwise each row keeps its group as a short dim prefix, a test
 * file without its ".test.ts".
 */
export function proofNames(names: string[]): { group: string; split: (name: string) => { group: string; leaf: string } } {
  const split = (name: string) => {
    const at = name.indexOf(" · ");
    if (at < 0) return { group: "", leaf: name };
    return { group: name.slice(0, at).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, ""), leaf: name.slice(at + 3) };
  };
  const groups = new Set(names.map((n) => split(n).group));
  const group = names.length > 1 && groups.size === 1 ? [...groups][0] : "";
  return { group, split };
}

function ProofName({ name, names }: { name: string; names: ReturnType<typeof proofNames> }) {
  const { group, leaf } = names.split(name);
  return (
    <span className="cc-proof-name" title={name}>
      {group && group !== names.group && <span className="cc-proof-prefix">{group}</span>}
      {leaf}
    </span>
  );
}

/**
 * `summarized` is set where a verdict bar above already says the proof's
 * summary (proofSummary.label), so the strip's heading stays a quiet label
 * and the numbers read once on the page.
 */
function ProofStrip({ card, summarized }: { card: ChangeCard; summarized: boolean }) {
  const summary = proofSummary(card.proof);
  const after = new Map(card.proof.after.map((c) => [c.name, c]));
  const red = card.proof.before.filter((c) => !c.ok);
  const broke = card.proof.after.filter((c) => summary.broke.includes(c.name));
  // The before and after most checks share ("fails before the change",
  // "passes after the change") read once, as a legend under the rows; the rows that say
  // just that keep only their wire, and a row that differs keeps its own words.
  const commonBefore = sharedDetail(red.map((b) => b.detail));
  const commonAfter = sharedDetail(red.map((b) => after.get(b.name)?.detail ?? ""));
  const isShared = (b: CardCheck) => !!commonBefore && !!commonAfter && after.get(b.name)?.ok === true && b.detail === commonBefore && after.get(b.name)?.detail === commonAfter;
  const anyShared = red.some(isShared);
  const names = proofNames([...red.map((b) => b.name), ...broke.map((a) => a.name)]);
  const empty = red.length === 0 && !broke.length;
  return (
    <section className="cc-section" data-cc-proof>
      <div className="cc-label-row">
        <h3 className="cc-label">Proof</h3>
        {/* An empty strip has no rows to stand for it, so it always says so. */}
        {(!summarized || empty) && <span className={`cc-proof-label ${summary.stillRed.length || summary.broke.length ? "cc-text-red" : summary.red ? "cc-text-green" : "text-sol-text-dim"}`}>{summary.label}</span>}
      </div>
      {!empty && (
        <ol className="cc-proof">
          {red.map((b, i) => {
            const a = after.get(b.name);
            const fixed = a?.ok === true;
            const beforeText = b.detail || "failed";
            const afterText = a?.detail || (a ? (fixed ? "passes" : "still fails") : "no after recorded");
            const shared = isShared(b);
            // A row still red says so once, in its own words: red to red
            // through an arrow repeats the failure.
            const stillText = a ? `still fails${a.detail && !/^still fails/i.test(a.detail) ? `: ${a.detail}` : ""}` : afterText;
            return (
              <li key={b.name} className={`cc-proof-row ${fixed ? "is-fixed" : "is-red"}`} style={{ ["--i" as any]: i }}>
                <span className="cc-track" aria-hidden>
                  <span className="cc-dot cc-dot-red" />
                  <span className="cc-wire"><span className="cc-wire-fill" /></span>
                  <span className={`cc-dot ${fixed ? "cc-dot-green" : "cc-dot-red"}`} />
                </span>
                <ProofName name={b.name} names={names} />
                {!fixed && (
                  <span className="cc-proof-detail"><span className="cc-proof-after cc-proof-still cc-text-red" title={stillText}>{stillText}</span></span>
                )}
                {fixed && !shared && (
                  <span className="cc-proof-detail">
                    <span className="cc-proof-before" title={beforeText}>{beforeText}</span>
                    <span className="cc-arrow" aria-hidden>→</span>
                    <span className={`cc-proof-after ${fixed ? "cc-text-green" : "cc-text-red"}`} title={afterText}>{afterText}</span>
                  </span>
                )}
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
              <ProofName name={a.name} names={names} />
              <span className="cc-proof-detail"><span className="cc-proof-after cc-text-red" title={a.detail || undefined}>broke: {a.detail || "fails after the change"}</span></span>
            </li>
          ))}
        </ol>
      )}
      {anyShared && (
        <p className="cc-proof-legend" data-cc-proof-shared>
          <span className="cc-legend-item"><span className="cc-legend-dot cc-dot-red" aria-hidden />{commonBefore}</span>
          <span className="cc-legend-item"><span className="cc-legend-dot cc-dot-green" aria-hidden />{commonAfter}</span>
        </p>
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

function ChangeCardFull({ card, inline, head, recommend, outcome, animate, summarized }: { card: ChangeCard; inline: boolean; head: boolean; recommend: boolean; outcome?: ReactNode; animate: boolean; summarized: boolean }) {
  const [allExamples, setAllExamples] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  // Two pairs show on a wide card, one on a narrow one (CSS hides the second
  // there, .cc-example-extra); the rest wait behind a toggle.
  const examples = allExamples ? card.examples : card.examples.slice(0, 2);
  const hidden = card.examples.length - examples.length;
  const checksPassed = card.checks.filter((c) => c.ok).length;
  // A failing check is news, so it shows without asking; passing ones wait behind the count.
  const showChecks = checksOpen || checksPassed < card.checks.length;
  return (
    <article className={`change-card ${inline ? "cc-inline" : "cc-full"} ${animate ? "cc-animate" : ""}`} data-change-card={card.cause.task}>
      {/* Cause: why this run exists, one quiet line above the decision. */}
      {head && <header><ChangeCardCause card={card} /></header>}

      {/* The decision itself: the change speaks for itself, what was wrong
          supports it in muted ink, and the proof follows at once. */}
      {/* Where the change heads the card, what was wrong reads as its
          subtitle; where the change is the page's own title above the card,
          it opens the card and names itself like every later section. */}
      <div className="cc-sentences">
        {head ? <p className="cc-change">{card.change}</p> : <h3 className="cc-label cc-wrong-label">What is wrong</h3>}
        <p className="cc-wrong">{card.wrong}</p>
      </div>

      <ProofStrip card={card} summarized={summarized} />

      {card.examples.length > 0 && (
        <section className="cc-section">
          <div className="cc-label-row"><h3 className="cc-label">Examples</h3></div>
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

      {/* The facts and, when open, the check list as a full width row right
          under them; on a narrow card the list sits under the short facts,
          above the risk (CSS orders them). */}
      <div className="cc-facts-block">
        <dl className="cc-facts">
          {card.checks.length > 0 && (
            <div className="cc-fact">
              <dt className="cc-label">Checks</dt>
              <dd>
                {/* A disclosure: the caret leads and turns as the list opens. */}
                <button type="button" className={`cc-checks-toggle ${showChecks ? "is-open" : ""}`} onClick={() => setChecksOpen((o) => !o)} aria-expanded={showChecks} data-cc-checks>
                  <ChevronRight className="cc-caret w-3 h-3" aria-hidden />
                  {checksPassed === card.checks.length
                    ? <span className="cc-nowrap">{checksPassed} of {card.checks.length} pass</span>
                    : <span className="cc-text-red cc-nowrap">{card.checks.length - checksPassed} of {card.checks.length} fail</span>}
                </button>
              </dd>
            </div>
          )}
          <div className="cc-fact">
            <dt className="cc-label">Diff</dt>
            <dd>
              <DiffCounts diff={card.diff} />
              <SepRow className="cc-fact-sub" items={[
                { key: "files", className: "cc-nowrap", node: `${card.diff.files} file${card.diff.files === 1 ? "" : "s"}` },
                ...(card.diff.pr ? [{ key: "pr", node: <a href={card.diff.pr} target="_blank" rel="noreferrer" className="cc-pr cc-nowrap"><GitPullRequest className="w-3 h-3" />{prLabel(card.diff.pr)}</a> }] : []),
              ]} />
            </dd>
          </div>
          <div className="cc-fact cc-fact-risk">
            <dt className="cc-label">Risk</dt>
            {/* The level in plain words is the value, in its tone, and its
                reason the sub line: the same two lines as every other fact,
                so the column scans by level on every card. */}
            <dd>
              <span className="cc-risk">
                <span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden />
                <span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span>
              </span>
              {card.risk.reason && <div className="cc-fact-sub cc-risk-reason">{card.risk.reason}</div>}
            </dd>
          </div>
          <div className="cc-fact">
            <dt className="cc-label">Cost</dt>
            <dd>
              <span className="cc-nowrap">${card.cost.usd.toFixed(2)}</span>
              <SepRow className="cc-fact-sub" items={[
                { key: "tokens", className: "cc-nowrap", node: `${tokensLabel(card.cost.tokens)} tokens` },
                { key: "minutes", className: "cc-nowrap", node: `${card.cost.minutes} min` },
              ]} />
            </dd>
          </div>
        </dl>
        {showChecks && card.checks.length > 0 && <ul className="cc-checks">{card.checks.map((c) => <CheckRow key={c.name} check={c} />)}</ul>}
      </div>

      {outcome ?? (recommend && <RecommendCaption verdict={card.recommend.verdict} why={card.recommend.why} />)}
    </article>
  );
}

/**
 * What the agent thinks, in one place and one style on every surface: a
 * muted caption led by the verdict in its tone ("Ship recommended."), under
 * the answer controls where a surface has them, at the card's foot where not.
 */
function RecommendCaption({ verdict, why }: { verdict: ChangeVerdict; why?: string }) {
  return (
    <p className={`cc-why cc-tone-${VERDICT_TONE[verdict] ?? "blue"}`} data-cc-recommended>
      <span className="cc-why-lead">{verdictLabel(verdict)} recommended.</span>
      {why && <> {why}</>}
    </p>
  );
}

// ── the queue's line ─────────────────────────────────────────────────────────

/** The first example whose output the change moved, for a card too small to hold them all. */
const movedExample = (card: ChangeCard) => card.examples.find((ex) => ex.before.trim() !== ex.after.trim()) ?? null;

/**
 * `story` is the line's own station (LE13), where the card is the one thing
 * the founder acts on and the question is "what broke, and did the fix prove
 * it": the cause first in plain ink (the one they would recognize), the change
 * in bold under it, one before and after, then the proof. The card's facts
 * (goal, age) ride the proof row's right end, so the card spends no line on them.
 */
function ChangeCardLine({ card, recommend, change, story, meta }: { card: ChangeCard; recommend: boolean; change: boolean; story: boolean; meta?: ReactNode }) {
  const summary = proofSummary(card.proof);
  const checksOk = card.checks.every((c) => c.ok);
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  const ex = story ? movedExample(card) : null;
  return (
    <div className={`change-card cc-line ${story ? "cc-line-story" : ""}`} data-change-card={card.cause.task}>
      {story && card.cause.title && <span className="cc-line-cause" title={card.wrong} data-cc-line-cause>{card.cause.title}</span>}
      {change && card.change && <span className="cc-line-change" title={card.change}>{card.change}</span>}
      {ex && (
        <span className="cc-line-ex" data-cc-line-example title={ex.input}>
          <span className="cc-line-ex-label cc-before-ink">Before</span><span className="cc-line-ex-text cc-line-ex-before">{ex.before}</span>
          <span className="cc-line-ex-label cc-after-ink">After</span><span className="cc-line-ex-text">{ex.after}</span>
        </span>
      )}
      {/* SepRow, so a wrapped line never opens on a separator. A row has no
          strip to decode "misses", so the proof reads as evidence
          (proofSummary.evidence): green when every failing case now passes.
          Passing checks and low risk are quiet news: a short row drops them
          (cc-line-quiet). A failing check or a risk past low always shows. */}
      <SepRow
        className="cc-line-row"
        items={[
          { key: "proof", className: "cc-nowrap items-center", node: <span className={!summary.red ? "text-sol-text" : summary.stillRed.length || summary.broke.length ? "cc-text-red" : "cc-text-green"} data-cc-line-proof>{summary.evidence}</span> },
          ...(card.checks.length ? [{ key: "checks", className: `cc-nowrap ${checksOk ? "text-sol-text-muted cc-line-quiet" : "cc-text-red"}`, node: checksLabel(card.checks) }] : []),
          { key: "risk", className: `cc-nowrap cc-text-${RISK_TONE[card.risk.class]} ${card.risk.class === "low" ? "cc-line-quiet" : ""}`, title: riskLabel(card.risk), node: riskLabel(card.risk, true) },
          ...(story && meta ? [{ key: "meta", plain: true, end: true, node: <span className="cc-line-meta" data-cc-line-meta>{meta}</span> }] : []),
          ...(recommend ? [{ key: "verdict", plain: true, end: !(story && meta), node: <span className={`cc-line-verdict cc-tone-${tone}`}>recommends {verdictLabel(card.recommend.verdict)}</span> }] : []),
        ]}
      />
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
 * opens a note, and return sends it. The queue's row (size "line") sits under
 * a cursor that walks a list, where a stray digit is easy, so there a digit
 * (or x) only selects the answer and return commits it; escape lets go. The note travels with the Revise answer,
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
  /** "line" is the queue's row: three small chips, no sentences around them. */
  size?: "full" | "compact" | "line";
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
  const line = size === "line";
  // The line's selected answer, waiting for return. It lets go when the
  // cursor leaves the card.
  const [armed, setArmed] = useState<ChangeVerdict | "dismiss" | null>(null);
  useEffect(() => { if (!keys) setArmed(null); }, [keys]);
  const recommended = decision.card?.recommend.verdict;
  const why = decision.card?.recommend.why;
  // A failing case still red (or one the change broke) leaves Ship the weak
  // answer, unless the card itself recommends it anyway.
  const proof = decision.card ? proofSummary(decision.card.proof) : null;
  const failing = proof ? proof.stillRed.length + proof.broke.length : 0;
  const weakShip = failing > 0 && recommended !== "ship";
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
    if (v === "revise") return openNote();
    onAnswer({ index: indexes[v] });
    // The row leaves the list as it answers, so a toast says what was sent.
    if (line) toast.success(`${verdictLabel(v)} sent`, { description: decision.card?.cause.title });
  }, [onAnswer, indexes, openNote, line, decision.card]);
  const commit = useCallback(() => {
    if (armed === "dismiss") { onDismiss?.(); toast(`Dismissed`, { description: decision.card?.cause.title }); }
    else if (armed) pick(armed);
    setArmed(null);
  }, [armed, onDismiss, pick, decision.card]);

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
      if (line && armed && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === "Enter") commit(); else setArmed(null);
        return;
      }
      const n = Number(e.key) - 1;
      const verdict = (Object.keys(indexes) as ChangeVerdict[]).find((v) => indexes[v] === n);
      if (verdict && verdict !== current) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (line && verdict !== "revise") setArmed(verdict); else { setArmed(null); pick(verdict); }
        return;
      }
      if ((e.key === "x" || e.key === "X") && onDismiss) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (line) setArmed("dismiss"); else onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, keyScope, indexes, current, pick, sendRevise, onDismiss, setNoteOpen, line, armed, commit]);

  const compact = size !== "full";
  const order: ChangeVerdict[] = (["ship", "revise", "drop"] as ChangeVerdict[]).sort((a, b) => indexes[a] - indexes[b]);
  // On a phone the full controls scroll away under the proof and examples; a
  // dock pinned to the screen's foot carries the three answers once they do.
  const rowRef = useRef<HTMLDivElement>(null);
  const offscreen = useScrolledPast(rowRef, size === "full");
  const dockPick = useCallback((v: ChangeVerdict) => {
    if (v === "revise") rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    pick(v);
  }, [pick]);
  const showCaption = !!recommended && !current && !noteOpen && !line;
  return (
    <div className={`change-card-answer ${line ? "is-line" : ""}`} data-card-answer>
      {(wentAhead || current) && !line && (
        <p className="cc-course" data-cc-course>
          {wentAhead ? <>The agent went ahead with <span className="cc-course-verdict">{verdictLabel(wentAhead)}</span>. Pick another to change course.</> : <>{record ? `${record}. ` : ""}Pick another to change course.</>}
        </p>
      )}
      <div ref={rowRef} className={`cc-verdicts ${compact ? "is-compact" : ""} ${line ? "is-line" : ""}`}>
        {/* The row has no course line, so the course the agent took is said
            beside the chips, or the check on its chip reads as a verdict. */}
        {line && (wentAhead || current) && (
          <span className="cc-course-short" data-cc-course-short>{wentAhead ? <>agent went with <span className="cc-course-verdict">{verdictLabel(wentAhead)}</span></> : <>on record: <span className="cc-course-verdict">{verdictLabel(current)}</span></>}</span>
        )}
        {order.map((v) => (
          <button
            key={v}
            onClick={() => pick(v)}
            disabled={current === v}
            data-verdict={v}
            className={`cc-verdict cc-tone-${VERDICT_TONE[v]} ${recommended === v && !current ? "is-recommended" : ""} ${current === v ? "is-current" : ""} ${wentAhead === v ? "is-taken" : ""} ${v === "revise" && noteOpen ? "is-open" : ""} ${armed === v ? "is-armed" : ""} ${v === "ship" && weakShip && !current ? "is-weak" : ""}`}
            title={wentAhead === v ? `The agent went ahead with ${verdictLabel(v)}` : v === "ship" && weakShip ? `Not every failing case passes yet. ${decision.options[indexes[v]]?.description ?? ""}`.trim() : recommended === v && why ? `Suggested: ${why}` : decision.options[indexes[v]]?.description}
          >
            {keys && indexes[v] < 9 && current !== v && <KeyCap size="xs">{String(indexes[v] + 1)}</KeyCap>}
            <span>{verdictLabel(v)}</span>
            {/* The row has no caption, so the tint and ring on the card's own
                answer say it; the word stays for screen readers and the tooltip. */}
            {line && recommended === v && !current && !wentAhead && <span className="sr-only" data-cc-suggested>suggested</span>}
            {/* A weak Ship still works: it says why it is risky, in the button. */}
            {line && v === "ship" && weakShip && !current && <span className="cc-verdict-fails" data-cc-fails>{failing} fail{failing === 1 ? "s" : ""}</span>}
            {/* The course already taken or on record: a small check, said in
                words by the line above the row. */}
            {(current === v || wentAhead === v) && <Check className="cc-verdict-check w-3 h-3" aria-label={current === v ? "on record" : "taken"} />}
          </button>
        ))}
        {onDismiss && !line && (
          <button onClick={onDismiss} className="cc-dismiss" title="Dismiss without answering" aria-label="Dismiss without answering">
            {keys ? <KeyCap size="xs">x</KeyCap> : null}<X className="cc-dismiss-icon w-3.5 h-3.5" /><span className="cc-dismiss-label">dismiss</span>
          </button>
        )}
      </div>
      {line && armed && (
        <p className={`cc-armed cc-tone-${armed === "dismiss" ? "red" : VERDICT_TONE[armed]}`} data-cc-armed>
          <KeyCap size="xs">return</KeyCap><span>{armed === "dismiss" ? "dismiss this card" : verdictLabel(armed)}</span>
          <KeyCap size="xs">esc</KeyCap><span className="text-sol-text-dim">cancel</span>
        </p>
      )}
      {/* Which is recommended, and on a full surface why, in one muted line
          under the row; the button itself wears only a ring. */}
      {showCaption && <RecommendCaption verdict={recommended!} why={compact ? undefined : why} />}
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
      {size === "full" && offscreen && (
        <div className="cc-dock" data-cc-dock>
          {order.map((v) => (
            <button
              key={v}
              onClick={() => dockPick(v)}
              disabled={current === v}
              className={`cc-verdict cc-tone-${VERDICT_TONE[v]} ${recommended === v && !current ? "is-recommended" : ""} ${current === v ? "is-current" : ""}`}
            >
              <span>{verdictLabel(v)}</span>
              {(current === v || wentAhead === v) && <Check className="cc-verdict-check w-3 h-3" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whether an element has scrolled up out of view (above it, not below), for as long as `on` holds. */
function useScrolledPast(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      // Out of view in its upper half means it scrolled up past; a row still
      // below the fold (a long card above it) is not news.
      if (e) setPast(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.height ?? window.innerHeight) / 2);
    }, { threshold: 0 });
    io.observe(el);
    return () => { io.disconnect(); setPast(false); };
  }, [ref, on]);
  return past;
}
