"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Check, ChevronRight, GitPullRequest, X } from "lucide-react";
import { toast } from "sonner";
import {
  cardChecks,
  cardFailing,
  cardVerdictIndexes,
  checksLabel,
  honestChecks,
  proofSummary,
  riskLabel,
  verdictLabel,
  verdictOfOption,
  type CardCheck,
  type ChangeCard,
  type ChangeVerdict,
} from "@codecast/shared/contracts/changeCard";
import { useInboxStore, type DecisionAnswerInput, type DecisionDetailItem, type SessionDecisionItem } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useDecisionDraft } from "../../hooks/useDecisionDraft";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hasOpenModal } from "../../shortcuts";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useGoalChip } from "../../hooks/useGoalChip";
import { lineTraceHref } from "../../lib/line/lineMapUrl";
import "./changeCard.css";
import type { ChangeGuide } from "@codecast/shared/contracts/changeGuide";
import { ChangeGuideWalkthrough } from "../tasks/ChangeGuideWalkthrough";
import { keysOwnedElsewhere } from "../../shortcuts/keyOwnership";

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
 * `change` is off on a full card whose surface draws its head above it
 * (ChangeCardHeadline), so the card opens on what was wrong. A line never
 * draws the head: the surface holding it does. `dots` is off where a full
 * proof strip reads on the same page.
 */
export function ChangeCardView({ card, density = "full", recommend = true, change = true, outcome, story = false, summarized = false, folded, dots = true, diffAnchor, guide }: { card: ChangeCard; density?: ChangeCardDensity; recommend?: boolean; change?: boolean; outcome?: ReactNode; story?: boolean; summarized?: boolean; folded?: boolean; dots?: boolean; diffAnchor?: string; guide?: ChangeGuide | null }) {
  const animate = useFirstSight(card.cause.task);
  if (density === "line") return <ChangeCardLine card={card} recommend={recommend && !outcome} story={story} folded={folded} dots={dots} />;
  return <ChangeCardFull card={card} inline={density === "inline"} head={change} recommend={recommend} outcome={outcome} animate={animate} summarized={summarized} diffAnchor={diffAnchor} guide={guide} />;
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

type SepItem = Parameters<typeof SepRow>[0]["items"][number];

/**
 * Why the change exists, in quiet lines under it: the cause with its task,
 * then the signals behind it (and where they came from), how old it is, and
 * the goal it serves. `brief` is a row's version: one line, the cause's title
 * with the surface's own facts (`facts`) trailing it. The task, the goal and
 * the signals wait on the decision page, so a queue card reaches its proof
 * after one grey line.
 */
function ChangeCardCause({ card, brief = false, facts = [] }: { card: ChangeCard; brief?: boolean; facts?: SepItem[] }) {
  const now = useCoarseNow(60_000);
  if (brief) {
    return (
      <div className="cc-cause">
        <p className="cc-cause-head" data-card-cause title={`${card.cause.task}: ${card.cause.title}`}>
          <span className="cc-cause-title">{card.cause.title}</span>
          {facts.map((f) => (
            <span key={f.key} className={`cc-cause-fact ${f.className ?? ""}`} title={f.title}>
              <span className="cc-sep-inline" aria-hidden> · </span>{f.node}
            </span>
          ))}
        </p>
      </div>
    );
  }
  const hasGoal = card.goal.ref && card.goal.ref !== "none";
  // "signal" is the kind every signal filed task carries, not a source: it says nothing.
  const named = card.cause.sources.filter((src) => src !== "signal");
  const sources = named.length ? `from ${listLabel(named)}` : "";
  const signals = card.cause.signals > 0 ? `${card.cause.signals} signal${card.cause.signals === 1 ? "" : "s"}` : "";
  const seen = card.cause.first_seen ? `first seen ${formatTimeAgo(card.cause.first_seen, now)}` : "";
  // A card written before its goal was named carries the key as the name.
  const goalName = card.goal.name && card.goal.name !== card.goal.ref ? card.goal.name : null;
  const goal = hasGoal ? <>serves <span className="text-sol-text-muted">{goalName ?? <GoalName goalRef={card.goal.ref} />}</span></> : null;
  const meta: SepItem[] = [];
  if (signals || sources) meta.push({ key: "signals", node: [signals, sources].filter(Boolean).join(" ") });
  // Age and goal share one fact, so a narrow card spends one line on them.
  // Why it serves the goal waits on hover.
  if (seen || goal) meta.push({
    key: "seen",
    className: goal ? "cc-goal" : "cc-nowrap",
    title: hasGoal ? card.goal.why || undefined : undefined,
    node: (
      <span data-card-goal={goal ? "" : undefined}>
        {seen && <span className="cc-nowrap">{seen}</span>}
        {seen && goal && <span className="cc-sep-inline" aria-hidden> · </span>}
        {goal}
      </span>
    ),
  });
  meta.push(...facts);
  return (
    <div className="cc-cause">
      <p className="cc-cause-head" data-card-cause>
        <Link href={`/tasks/${card.cause.task}`} className="cc-cause-ref">{card.cause.task}</Link>
        <span className="cc-cause-title">{card.cause.title}</span>
        {/* The cause followed through the line, step by step (line-map.md LX4). */}
        <Link href={lineTraceHref(card.cause.task)} className="cc-cause-ref cc-cause-trace" title="Follow this cause through the line: its signals, runs, card, ship and watch" data-card-trace>trace</Link>
      </p>
      <SepRow items={meta} className="cc-cause-facts" />
    </div>
  );
}

/** A goal the card names only by its key, in words (never the key itself). */
function GoalName({ goalRef }: { goalRef: string }) {
  return <>{useGoalChip(goalRef).label}</>;
}

/** The asker's own question beside a card, or null when it only repeats the change. */
export const cardAskedQuestion = (card: ChangeCard, question: string | undefined) => {
  const q = question?.trim();
  if (!q || q === card.change.trim() || (card.headline && q.includes(card.headline.trim()))) return null;
  return q;
};

/**
 * A change card's head, one component and one order on every surface: the
 * change in bold, the asker's own question under it (dim, when it says
 * something else), then the muted cause with its task, then the goal and the
 * surface's facts. Only the size follows the surface: the decision page's and
 * the sheet's title, a standalone card's head, a queue row (whose cause is one
 * line: the title and the row's facts). `href` makes a
 * row's change its link; `folded` keeps only the change.
 */
/** `questionFirst`: the decision page, where the question asked is the
 *  headline ("Ship the fix for C117?") and the change reads under it. */
export function ChangeCardHeadline({ card, question, size = "title", facts, href, folded = false, questionFirst = false, className = "" }: { card: ChangeCard; question?: string; size?: "title" | "card" | "row"; facts?: SepItem[]; href?: string; folded?: boolean; questionFirst?: boolean; className?: string }) {
  const asked = cardAskedQuestion(card, question);
  // A card written for a cold reader leads with its plain headline and the one
  // sentence saying what the affected part is; older cards lead with the change.
  const title = card.headline || card.change;
  if (questionFirst && asked && size === "title" && !folded) {
    return (
      <div className={`cc-head cc-head-title ${className}`}>
        <h1 className="cc-change cc-change-title" data-card-question>{asked}</h1>
        <p className="cc-change-sub" data-card-change>{title}</p>
        {card.context && <p className="cc-context" data-card-context>{card.context}</p>}
        <ChangeCardCause card={card} brief={false} facts={facts} />
      </div>
    );
  }
  const change = size === "title" ? <h1 className="cc-change cc-change-title">{title}</h1>
    : size === "card" ? <p className="cc-change">{title}</p>
    : href ? <Link href={href} className="cc-line-change" title={title}>{title}</Link>
    : <span className="cc-line-change">{title}</span>;
  return (
    <div className={`cc-head cc-head-${size} ${folded ? "is-folded" : ""} ${className}`}>
      {change}
      {card.context && size !== "row" && !folded && <p className="cc-context" data-card-context>{card.context}</p>}
      {asked && !folded && <p className="cc-asked" data-card-question title={asked}>{asked}</p>}
      {!folded && <ChangeCardCause card={card} brief={size === "row"} facts={facts} />}
    </div>
  );
}

/**
 * The decision under a card's head, on every surface that answers one (the
 * decision page, the transcript sheet): the proof, checks and risk in one
 * line, then Ship / Revise / Drop with the recommendation and its reason.
 * The proof's dots stay off here; the Proof section below draws it in full.
 */
export function ChangeCardVerdictBar({ card, children }: { card: ChangeCard; children: ReactNode }) {
  return (
    <div className="cc-verdict-bar" data-verdict-bar>
      <ChangeCardView card={card} density="line" recommend={false} dots={false} />
      {children}
    </div>
  );
}

const VERDICT_DONE: Record<ChangeVerdict, string> = { ship: "Shipped", revise: "Sent back to revise", drop: "Dropped" };

/** "5h ago", "just now", or "Sep 3": when something settled, in words. */
export const settledAgo = (at: number | undefined, now: number) => {
  const ago = at ? formatTimeAgo(at, now) : "";
  return !ago ? "" : ago === "now" ? "just now" : /^\d+[mhd]$/.test(ago) ? `${ago} ago` : ago;
};
/** The same, as a tail: " · 5h ago". */
const whenTail = (at: number | undefined, now: number) => {
  const ago = settledAgo(at, now);
  return ago ? ` · ${ago}` : "";
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

/** Who answered a decision, in the words a card's outcome line uses: a person's name ("you" for the viewer), a role's, or "policy". */
export function answererNameOf(detail: Pick<DecisionDetailItem, "decision" | "asked_users" | "holder_role" | "ladder">, meId: string | null | undefined): string {
  const by = detail.decision.answered_by;
  if (!by) return "a person";
  if (by.kind === "policy") return "policy";
  if (by.kind === "role") return detail.holder_role?.name ?? detail.ladder.find((h) => h.role_id === by.id)?.role?.name ?? "a role";
  return detail.asked_users.find((u) => u._id === by.id)?.name ?? (by.id === meId ? "you" : "a person");
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
  useWatchEffect(() => { seenCards.add(key); }, [key]);
  return first;
}

// ── the proof strip: the card's signature ────────────────────────────────────

/** Diff counts in neutral ink: red and green on the card mean pass and fail, never removed and added. */
function DiffCounts({ diff }: { diff: ChangeCard["diff"] }) {
  return (
    <span className="cc-nowrap cc-diff"><span className="cc-diff-glyph">+</span>{diff.added} <span className="cc-diff-glyph">−</span>{diff.removed}</span>
  );
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

/** One case's before and after, in the proof dots' own language: two dots and a dim rule between them. */
function ProofPair({ before, after }: { before: boolean; after: boolean }) {
  return (
    <span className="cc-proof-pair" aria-hidden>
      <span className="cc-proof-dot" data-ok={before ? "true" : undefined} />
      <span className="cc-proof-dots-rule" />
      <span className="cc-proof-dot cc-proof-dot-after" data-ok={after ? "true" : undefined} />
    </span>
  );
}

/**
 * `summarized` is set where a verdict bar above already says the proof's
 * sentence (proofSummary.evidence), so the heading keeps only the dots and
 * the numbers read once on the page. Where it shows, the heading says that
 * same sentence beside the same dots the queue draws: one device, one
 * phrasing, on every surface.
 *
 * Every case is a row of its own, in one weight: a fixed case reads as its
 * name, a case still failing or one the change broke adds what went wrong
 * under it, in red, since that is what the founder has to judge. A lone
 * fixed case keeps its before and after values on its line; several keep
 * theirs on hover.
 */
/** A test runner's tally in its own output ("4 pass 2 fail", "6 passed, 0 failed"), the last one it printed. */
export function runnerTally(text: string | undefined): { pass: number; fail: number } | null {
  const all = [...(text ?? "").matchAll(/(\d+)\s+pass(?:ed)?\b[\s,]*(\d+)\s+fail(?:ed)?\b/gi)];
  const m = all[all.length - 1];
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

/** A case whose before and after are a test runner's whole log reads as its
 *  counts ("2 failing → 6 of 6 passing"); null when either side is not one. */
export function runnerChange(before: string | undefined, after: string | undefined): string | null {
  const b = runnerTally(before);
  const a = runnerTally(after);
  if (!b || !a) return null;
  return `${b.fail} failing \u2192 ${a.pass} of ${a.pass + a.fail} passing`;
}

function ProofStrip({ card, summarized }: { card: ChangeCard; summarized: boolean }) {
  const summary = proofSummary(card.proof);
  const after = new Map(card.proof.after.map((c) => [c.name, c]));
  const red = card.proof.before.filter((c) => !c.ok);
  const fixed = red.filter((b) => after.get(b.name)?.ok === true);
  const still = red.filter((b) => after.get(b.name)?.ok !== true);
  const broke = card.proof.after.filter((c) => summary.broke.includes(c.name));
  // The prefix (a test file, an eval surface) shows only where the failing
  // rows differ in it; a fixed case is settled news and reads as its name alone.
  const names = proofNames([...still.map((b) => b.name), ...broke.map((a) => a.name)]);
  const values = (b: CardCheck) => {
    const a = after.get(b.name)?.detail ?? "";
    return b.detail && a ? `${b.detail} \u2192 ${a}` : "";
  };
  const empty = red.length === 0 && !broke.length;
  const bad = still.length + broke.length;
  return (
    <section className="cc-section" data-cc-proof>
      <div className="cc-label-row">
        <h3 className="cc-label">Proof</h3>
        {!empty && <ProofDots card={card} />}
        {/* An empty strip has no dots to stand for it, so it always says so. */}
        {(!summarized || empty) && <span className={`cc-proof-label ${bad ? "cc-text-red" : summary.red ? "cc-text-green" : "text-sol-text-dim"}`}>{summary.evidence}</span>}
      </div>
      {!empty && (
        <ol className="cc-proof">
          {fixed.map((b, i) => {
            // A runner's log reads as its counts, the log itself one click away.
            const counts = runnerChange(b.detail, after.get(b.name)?.detail);
            return (
              <li key={b.name} className="cc-proof-row is-fixed" style={{ ["--i" as any]: i }} data-cc-proof-fixed>
                <ProofPair before={false} after />
                <span className="cc-proof-fixed-name">
                  <span className="cc-proof-name" title={counts ? b.name : [b.name, values(b)].filter(Boolean).join(": ")}>{names.split(b.name).leaf}</span>
                  {counts ? <span className="cc-proof-fixed-vals" data-cc-proof-counts>{counts}</span>
                    : fixed.length === 1 && values(b) && <span className="cc-proof-fixed-vals" data-cc-proof-values>{values(b)}</span>}
                </span>
                {counts && (
                  <details className="cc-proof-log" data-cc-proof-log>
                    <summary>Test output</summary>
                    <div className="cc-proof-log-body">
                      <div className="cc-proof-log-head">Before the change</div>
                      <pre>{b.detail}</pre>
                      <div className="cc-proof-log-head">After</div>
                      <pre>{after.get(b.name)?.detail}</pre>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
          {still.map((b, i) => {
            const a = after.get(b.name);
            // A row still red says so once, in its own words: red to red
            // through an arrow repeats the failure.
            const stillText = a ? `still fails${a.detail && !/^still fails/i.test(a.detail) ? `: ${a.detail}` : ""}` : "no after recorded";
            return (
              <li key={b.name} className="cc-proof-row is-red" style={{ ["--i" as any]: fixed.length + i }}>
                <ProofPair before={false} after={false} />
                <ProofName name={b.name} names={names} />
                <span className="cc-proof-detail"><span className="cc-proof-after cc-proof-still cc-text-red" title={stillText}>{stillText}</span></span>
              </li>
            );
          })}
          {broke.map((a, i) => (
            <li key={`broke-${a.name}`} className="cc-proof-row is-broke" style={{ ["--i" as any]: fixed.length + still.length + i }}>
              <ProofPair before after={false} />
              <ProofName name={a.name} names={names} />
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

// A reply split into its sentences and list items, separators kept, so the
// text renders as written and a changed piece can be marked.
const PIECE = /((?<=[.!?])\s+(?=\S)|\s+-\s+|\n+)/;

const wordsOf = (t: string) => new Set(squash(t).split(" ").filter(Boolean));
/** Two pieces say the same thing when most of their words are shared ("Add the button" and "Added the button"). */
const samePiece = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared) >= 0.5;
};

/** The pieces of `text` with `changed` set on each one `other` does not say.
 *  Nothing is marked when most pieces changed: a reply marked nearly whole
 *  says nothing a reader cannot see. */
export function changedPieces(text: string, other: string): Array<{ text: string; changed: boolean }> {
  const parts = text.split(PIECE);
  const theirs = other.split(PIECE).filter((_, i) => i % 2 === 0).map(wordsOf).filter((w) => w.size > 0);
  const out = parts.map((t, i) => {
    const mine = i % 2 === 0 ? wordsOf(t) : null;
    return { text: t, changed: !!mine && mine.size > 0 && !theirs.some((w) => samePiece(mine, w)) };
  });
  const pieces = out.filter((p, i) => i % 2 === 0 && squash(p.text));
  const changed = pieces.filter((p) => p.changed).length;
  return changed > 0 && changed <= pieces.length / 2 ? out : out.map((p) => ({ ...p, changed: false }));
}

/** A note cut short where it was stored ends at its last whole sentence, so it never stops mid-thought. */
export function wholeSentences(note: string): string {
  const t = note.trim();
  if (!t.endsWith("…")) return t;
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  return end > 0 ? t.slice(0, end + 1) : t;
}

function SideText({ text, other, tone }: { text: string; other: string; tone: "before" | "after" }) {
  const pieces = useMemo(() => changedPieces(text, other), [text, other]);
  return <>{pieces.map((p, i) => (p.changed ? <mark key={i} className={`cc-changed cc-changed-${tone}`}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

/** Long enough that four lines would cut it. */
const longSide = (t: string) => t.length > 220 || t.split("\n").length > 4;

/** One before and after pair: two tiles of one height, the input as a small "for:" caption inside Before that opens in full, the note under both. What one side says that the other does not is marked. `clamp` holds each side to four lines with a toggle that opens both. The Evals pages show eval flips with it too. */
export function ExamplePair({ ex, clamp = false }: { ex: ChangeCard["examples"][number]; clamp?: boolean }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const clamped = clamp && !all && (longSide(ex.before) || longSide(ex.after));
  const note = ex.note ? wholeSentences(ex.note) : "";
  return (
    <div className="cc-example">
      <div className="cc-pair">
        <div className="cc-side cc-before">
          <span className="cc-side-label">Before</span>
          {/* What the pair answers belongs to the pair, not above it as a quote competing with the tiles. */}
          {exampleInputAdds(ex.input, ex.before) && (
            <button type="button" className={`cc-example-input ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? undefined : "Show the full input"}>
              <span className="cc-example-for">for:</span> {ex.input}
            </button>
          )}
          <span className={`cc-side-text ${clamped ? "is-clamped" : ""}`}><SideText text={ex.before} other={ex.after} tone="before" /></span>
        </div>
        <div className="cc-side cc-after">
          <span className="cc-side-label">After</span>
          <span className={`cc-side-text ${clamped ? "is-clamped" : ""}`}><SideText text={ex.after} other={ex.before} tone="after" /></span>
        </div>
      </div>
      {clamp && (longSide(ex.before) || longSide(ex.after)) && (
        <button type="button" className="cc-more" onClick={() => setAll((a) => !a)} aria-expanded={all} data-cc-example-all>
          {all ? "Show less" : "Show all"}
          <ChevronRight className={`w-3 h-3 transition-transform ${all ? "-rotate-90" : "rotate-90"}`} />
        </button>
      )}
      {note && (
        <button type="button" className={`cc-example-note ${noteOpen ? "is-open" : ""}`} onClick={() => setNoteOpen((o) => !o)} aria-expanded={noteOpen} title={noteOpen ? undefined : "Show the whole note"} data-cc-example-note>
          {note}
        </button>
      )}
    </div>
  );
}

function ChangeCardFull({ card, inline, head, recommend, outcome, animate, summarized, diffAnchor, guide }: { card: ChangeCard; inline: boolean; head: boolean; recommend: boolean; outcome?: ReactNode; animate: boolean; summarized: boolean; diffAnchor?: string; guide?: ChangeGuide | null }) {
  const [allExamples, setAllExamples] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  // Two pairs show at every width; the rest wait behind a toggle that names
  // what it opens.
  const examples = allExamples ? card.examples : card.examples.slice(0, 2);
  const hidden = card.examples.length - examples.length;
  // One list for every count on the card (cardChecks): the proof as a check,
  // and a check whose own words report a failure counted as failing.
  const checks = cardChecks(card);
  const checksPassed = checks.filter((c) => c.ok).length;
  // A failing check is news, so it shows without asking; passing ones wait behind the count.
  const showChecks = checksOpen || checksPassed < checks.length;
  // Under a verdict bar the counts and the risk level are said once, in the
  // bar, so the card holds only their detail: the check list itself (the
  // proof has its own section right above, so it is not a row again) and
  // the risk's reason.
  const ownChecks = summarized ? honestChecks(card.checks) : [];
  return (
    <article className={`change-card ${inline ? "cc-inline" : "cc-full"} ${animate ? "cc-animate" : ""}`} data-change-card={card.cause.task}>
      {/* The head every surface draws (ChangeCardHeadline): the change,
          then its cause, then its goal. A surface that titles the page with
          it turns it off here. */}
      {head && <header><ChangeCardHeadline card={card} size="card" /></header>}

      {/* What was wrong names itself like every later section. */}
      <div className="cc-sentences">
        <h3 className="cc-label cc-wrong-label">What is wrong</h3>
        <p className="cc-wrong">{card.wrong}</p>
        {card.headline && <>
          <h3 className="cc-label cc-change-label">What this changes</h3>
          <p className="cc-wrong" data-card-change>{card.change}</p>
        </>}
      </div>

      {/* Proof, then examples, stacked on every card at every width, so the
          examples are always in the same place. */}
      <ProofStrip card={card} summarized={summarized} />

      {card.examples.length > 0 && (
        <section className="cc-section">
          <div className="cc-label-row"><h3 className="cc-label">Examples</h3></div>
          <div className="space-y-4">
            {examples.map((ex, i) => <ExamplePair key={i} ex={ex} clamp={inline} />)}
          </div>
          {hidden > 0 && (
            <button type="button" onClick={() => setAllExamples(true)} className="cc-more" data-cc-more>
              {hidden} more example{hidden === 1 ? "" : "s"}
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </section>
      )}

      {/* The facts and, when open, the check list as a full width row right
          under them; on a narrow card the list sits under the short facts,
          above the risk (CSS orders them). */}
      <div className={`cc-facts-block ${!summarized && checks.length ? "has-checks" : ""}`}>
        <dl className="cc-facts">
          {!summarized && checks.length > 0 && (
            <div className="cc-fact">
              <dt className="cc-label">Checks</dt>
              <dd>
                {/* A disclosure: the caret leads and turns as the list opens. */}
                <button type="button" className={`cc-checks-toggle ${showChecks ? "is-open" : ""}`} onClick={() => setChecksOpen((o) => !o)} aria-expanded={showChecks} data-cc-checks>
                  <ChevronRight className="cc-caret w-3 h-3" aria-hidden />
                  <span className={`cc-nowrap ${checksPassed < checks.length ? "cc-text-red" : ""}`}>{checksLabel(checks, true)}</span>
                </button>
              </dd>
            </div>
          )}
          <div className="cc-fact scroll-mt-4" id={diffAnchor}>
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
              {summarized && card.risk.reason ? (
                <span className="cc-risk" title={riskLabel(card.risk)}>
                  <span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden />
                  <span className="cc-risk-reason is-only">{card.risk.reason}</span>
                </span>
              ) : (
                <>
                  <span className="cc-risk">
                    <span className={`cc-risk-dot cc-tone-${RISK_TONE[card.risk.class]}`} aria-hidden />
                    <span className={`cc-text-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span>
                  </span>
                  {card.risk.reason && <div className="cc-fact-sub cc-risk-reason">{card.risk.reason}</div>}
                </>
              )}
            </dd>
          </div>
          <div className="cc-fact">
            <dt className="cc-label">Cost</dt>
            <dd>
              <span className="cc-nowrap">${card.cost.usd.toFixed(2)}</span>
              <SepRow className="cc-fact-sub" items={[
                // A card that recorded no tokens says nothing rather than "0 tokens".
                ...(card.cost.tokens > 0 ? [{ key: "tokens", className: "cc-nowrap", node: `${tokensLabel(card.cost.tokens)} tokens` }] : []),
                // Agent time summed over the run's sessions, not the run's wall time.
                { key: "minutes", className: "cc-nowrap", node: `${card.cost.minutes} agent min` },
              ]} />
            </dd>
          </div>
          {ownChecks.length > 0 && (
            <div className="cc-fact cc-fact-checks">
              <dt className="cc-label">Checks</dt>
              <dd><ul className="cc-checks">{ownChecks.map((c) => <CheckRow key={c.name} check={c} />)}</ul></dd>
            </div>
          )}
        </dl>
        {!summarized && showChecks && checks.length > 0 && <ul className="cc-checks">{checks.map((c) => <CheckRow key={c.name} check={c} />)}</ul>}
      </div>

      {/* The author's tour of the code (ct-57527), read just before the verdict. */}
      {guide && guide.steps.length > 0 && <ChangeGuideWalkthrough guide={guide} compact={inline} className="cc-section" />}

      {outcome ?? (recommend && <RecommendCaption verdict={card.recommend.verdict} why={card.recommend.why} />)}
    </article>
  );
}

/**
 * What the agent thinks, in one place and one style on every surface: a
 * muted line led by the verdict in its tone ("Ship recommended: ..."). Where a
 * surface has answer controls it sits above them, right under the proof
 * line, so the page reads verdict, evidence, action; at the card's foot where
 * not.
 */
function RecommendCaption({ verdict, why }: { verdict: ChangeVerdict; why?: string }) {
  return (
    <p className={`cc-why cc-tone-${VERDICT_TONE[verdict] ?? "blue"}`} data-cc-recommended>
      <span className="cc-why-lead">{verdictLabel(verdict)} recommended{why ? ":" : "."}</span>
      {why && <> {why}</>}
    </p>
  );
}

// ── the queue's line ─────────────────────────────────────────────────────────

/** The first example whose output the change moved, for a card too small to hold them all. */
const movedExample = (card: ChangeCard) => card.examples.find((ex) => ex.before.trim() !== ex.after.trim()) ?? null;

/** A goal a cause serves, as a pill the shape of the line's project pills,
 *  so a goal reads the same on every cause row of the line. */
export function GoalChip({ name, title }: { name: string; title?: string }) {
  return <span className="cc-goal-chip" title={title} data-goal-chip>{name}</span>;
}

/** The proof as evidence at a glance: one 8px dot per case, before then
 *  after, in the In build stepper's dot language. Red before turns green when the change
 *  fixed it and stays red when it did not; a case the change broke goes from
 *  green to red. The broken cases sit in a group of their own, so the dots
 *  count the way the sentence reads ("2 of 3 cases fixed, 1 new failure"). */
function ProofDots({ card }: { card: ChangeCard }) {
  const summary = proofSummary(card.proof);
  const after = new Map(card.proof.after.map((c) => [c.name, c.ok]));
  const red = card.proof.before.filter((c) => !c.ok).map((c) => c.name);
  const proven = red.map((n) => ({ n, before: false, after: after.get(n) === true }));
  const broken = summary.broke.map((n) => ({ n, before: true, after: false }));
  const cases = [...proven, ...broken];
  if (!cases.length) return null;
  const dot = (c: (typeof cases)[number], ok: boolean) => <span key={c.n} className="cc-proof-dot" data-ok={ok ? "true" : undefined} />;
  const row = (pick: (c: (typeof cases)[number]) => boolean) => (
    <span className="cc-proof-dots-row">
      {proven.map((c) => dot(c, pick(c)))}
      {proven.length > 0 && broken.length > 0 && <span className="cc-proof-dots-gap" />}
      {broken.map((c) => dot(c, pick(c)))}
    </span>
  );
  return (
    <span className="cc-proof-dots" role="img" aria-label={summary.evidence} title={cases.map((c) => `${c.n}: ${c.before ? "passed" : "failed"} before, ${c.after ? "passes" : "fails"} after`).join("\n")} data-cc-proof-dots>
      {row((c) => c.before)}<span className="cc-proof-dots-rule" aria-hidden />{row((c) => c.after)}
    </span>
  );
}

/**
 * The card's decision facts in one line: the proof (dots and its sentence),
 * the checks, and the risk, always last and always said (a low risk quietly).
 * The surface draws the head above it (ChangeCardHeadline). `story` is the
 * line's own station (LE13), which adds one before and after above the row.
 * `folded` is a card in the line's queue the cursor is not on: the proof
 * alone, so the queue reads as a list to work down.
 */
function ChangeCardLine({ card, recommend, story, folded = false, dots = true }: { card: ChangeCard; recommend: boolean; story: boolean; folded?: boolean; dots?: boolean }) {
  const summary = proofSummary(card.proof);
  // The same count the full card's Checks cell and the badge on Ship say (cardChecks).
  const checks = cardChecks(card);
  const checksOk = checks.every((c) => c.ok);
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  const riskTone = RISK_TONE[card.risk.class];
  const ex = story && !folded ? movedExample(card) : null;
  return (
    <div className={`change-card cc-line ${story ? "cc-line-story" : ""} ${folded ? "cc-line-folded" : ""}`} data-change-card={card.cause.task} data-folded={folded ? "true" : undefined}>
      {ex && (
        <span className="cc-line-ex" data-cc-line-example title={ex.input}>
          <span className="cc-line-ex-label cc-before-ink">Before</span><span className="cc-line-ex-text cc-line-ex-before">{ex.before}</span>
          <span className="cc-line-ex-label cc-after-ink">After</span><span className="cc-line-ex-text">{ex.after}</span>
        </span>
      )}
      {/* SepRow, so a wrapped line never opens on a separator. A row has no
          strip to decode, so the proof reads as its one sentence
          (proofSummary.evidence): green when every failing case now passes,
          amber when some still fail, red when the change broke one, so the
          label never shares the ink of a red dot beside it. Passing checks
          are quiet news a short row drops (cc-line-quiet); a failing check
          always shows, and so does the risk, low in dim words. */}
      <SepRow
        className="cc-line-row"
        items={[
          { key: "proof", className: "items-center", node: <span className="cc-line-proof">{dots && <ProofDots card={card} />}<span className={!summary.red ? "text-sol-text" : summary.broke.length ? "cc-text-red" : summary.stillRed.length ? "cc-text-yellow" : "cc-text-green"} data-cc-line-proof>{folded && summary.red ? `${summary.fixed} of ${summary.red} fixed` : summary.evidence}</span></span> },
          // A folded card keeps the proof; checks and risk are said when it opens.
          ...(checks.length && !folded ? [{ key: "checks", className: `cc-nowrap ${checksOk ? "text-sol-text-muted cc-line-quiet" : "cc-text-red"}`, node: checksLabel(checks) }] : []),
          ...(folded ? [] : [{ key: "risk", className: `cc-nowrap ${card.risk.class === "low" ? "text-sol-text-dim" : `cc-text-${riskTone}`}`, title: card.risk.reason ? `${riskLabel(card.risk)}: ${card.risk.reason}` : riskLabel(card.risk), node: <span className="cc-line-risk" data-cc-line-risk><span className={`cc-risk-dot cc-tone-${riskTone}`} aria-hidden />{riskLabel(card.risk, true)}</span> }]),
          ...(recommend ? [{ key: "verdict", plain: true, end: true, node: <span className={`cc-line-verdict cc-tone-${tone}`}>recommends {verdictLabel(card.recommend.verdict)}</span> }] : []),
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
 * Whether a window key may reach answer controls: no modifier, no modal, no
 * focus in another region that owns its keys, and,
 * when the surface scoped its keys, focus inside that surface. A card that
 * shares a window with a transcript answers only while it is the thing in
 * focus, so a digit typed anywhere else never answers it.
 */
export function answerKeyAllowed(e: KeyboardEvent, scope?: RefObject<HTMLElement | null>): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return false;
  // Shift and a digit belongs to the page (the line jumps stations with it),
  // even on a layout where that chord still reports a bare digit.
  if (e.shiftKey && /^(Digit|Numpad)\d$/.test(e.code)) return false;
  // A focused region that owns its keys (the branch map, an active review)
  // keeps them, scoped surface or not: its Enter, digits and x are never an
  // answer.
  const root = scope?.current ?? null;
  if (keysOwnedElsewhere(e.target, root)) return false;
  if (!scope) return true;
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
  useWatchEffect(() => { if (!keys) setArmed(null); }, [keys]);
  const recommended = decision.card?.recommend.verdict;
  const why = decision.card?.recommend.why;
  // Any failing check (the proof counts as one, cardChecks) leaves Ship the
  // weak answer, unless the card itself recommends it anyway. Its badge says
  // the same number as the card's Checks cell.
  const failing = decision.card ? cardFailing(decision.card) : 0;
  const weakShip = failing > 0 && recommended !== "ship";
  // Keycaps show only while the keys are live: on a scoped surface (a card in
  // a transcript), while focus is inside it, and that surface wears a ring
  // so it is plain which card the digits answer.
  const live = useFocusWithin(keyScope, keys);
  const showKeys = keys && live;
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
    // Ship on a line run's card is the One Ship control's press (ship.ts):
    // the same action the task, session and PR buttons run, which answers
    // the card on its own rail and records the ship run against it.
    if (v === "ship" && decision.task_id && decision.workflow_run_id) {
      useInboxStore.getState().startShip({ kind: "task", id: decision.task_id }, `ship-${Date.now().toString(36)}`, decision._id);
    } else onAnswer({ index: indexes[v] });
    // The row leaves the list as it answers, so a toast says what was sent.
    if (line) toast.success(`${verdictLabel(v)} sent`, { description: decision.card?.cause.title });
  }, [onAnswer, indexes, openNote, line, decision.card, decision.task_id, decision.workflow_run_id, decision._id]);
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
      {/* Which is recommended, and on a full surface why, in one muted line
          above the row; the button itself wears only a ring. */}
      {showCaption && <RecommendCaption verdict={recommended!} why={compact ? undefined : why} />}
      {(wentAhead || current) && !line && (
        <p className="cc-course" data-cc-course>
          {wentAhead ? <>The agent went ahead with <span className="cc-course-verdict">{verdictLabel(wentAhead)}</span>. Pick another to change course.</> : <>{record ? `${record}. ` : ""}Pick another to change course.</>}
        </p>
      )}
      <div ref={rowRef} className={`cc-verdicts ${compact ? "is-compact" : ""} ${line ? "is-line" : ""}`}>
        {/* The row has no course line, so the course the agent took is said
            beside the chips, or the check on its chip reads as a verdict. */}
        {line && (wentAhead || current) && (
          <span className="cc-course-short" data-cc-course-short>{wentAhead ? <>Agent goes with <span className="cc-course-verdict">{verdictLabel(wentAhead)}</span> unless you pick</> : <>on record: <span className="cc-course-verdict">{verdictLabel(current)}</span></>}</span>
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
            {showKeys && indexes[v] < 9 && current !== v && <KeyCap size="xs">{String(indexes[v] + 1)}</KeyCap>}
            <span>{verdictLabel(v)}</span>
            {/* The row has no caption, so the tint and ring on the card's own
                answer say it; the word stays for screen readers and the tooltip. */}
            {line && recommended === v && !current && !wentAhead && <span className="sr-only" data-cc-suggested>suggested</span>}
            {/* A weak Ship still works: it says why it is risky, in the button,
                on every surface, with the Checks cell's own count. */}
            {v === "ship" && weakShip && !current && <span className="cc-verdict-fails" data-cc-fails>{failing} {failing === 1 ? "check fails" : "checks fail"}</span>}
            {/* The answer on record cannot be pressed again; a small check
                marks why. The agent's own course is said once, in words. */}
            {current === v && <Check className="cc-verdict-check w-3 h-3" aria-label="on record" />}
          </button>
        ))}
        {/* Closing with no verdict is not a fourth answer: it says what it
            does and sits at the row's far end, away from Drop. */}
        {onDismiss && !line && (
          <button onClick={onDismiss} className="cc-dismiss" title="Close with no verdict: nothing goes back to the agent, and a line run stops here" aria-label="Close without answering">
            {showKeys ? <KeyCap size="xs">x</KeyCap> : null}<span>close without answering</span>
          </button>
        )}
      </div>
      {line && armed && (
        <p className={`cc-armed cc-tone-${armed === "dismiss" ? "red" : VERDICT_TONE[armed]}`} data-cc-armed>
          <KeyCap size="xs">return</KeyCap><span>{armed === "dismiss" ? "close without answering" : verdictLabel(armed)}</span>
          <KeyCap size="xs">esc</KeyCap><span className="text-sol-text-dim">cancel</span>
        </p>
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
              {current === v && <Check className="cc-verdict-check w-3 h-3" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Whether focus is inside `scope` (always true with no scope), tracked while
 * `on` holds. The scope element carries data-keys-live meanwhile, so the
 * surface the keys answer draws a ring (changeCard.css).
 */
function useFocusWithin(scope: RefObject<HTMLElement | null> | undefined, on: boolean) {
  const [inside, setInside] = useState(false);
  useWatchEffect(() => {
    if (!scope || !on) return;
    const read = () => {
      const root = scope.current;
      const now = !!root && root.contains(document.activeElement);
      setInside(now);
      if (root) root.toggleAttribute("data-keys-live", now);
    };
    // Focus leaving lands on its next element a tick later.
    const later = () => setTimeout(read, 0);
    read();
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", later);
      scope.current?.removeAttribute("data-keys-live");
    };
  }, [scope, on]);
  return !scope || inside;
}

/** Whether an element has scrolled up out of view (above it, not below), for as long as `on` holds. */
function useScrolledPast(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [past, setPast] = useState(false);
  useWatchEffect(() => {
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
