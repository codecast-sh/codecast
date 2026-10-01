"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Check, GitPullRequest, Target, X } from "lucide-react";
import {
  cardVerdictIndexes,
  proofSummary,
  riskLabel,
  verdictLabel,
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

export function ChangeCardView({ card, density = "full" }: { card: ChangeCard; density?: ChangeCardDensity }) {
  if (density === "line") return <ChangeCardLine card={card} />;
  return <ChangeCardFull card={card} inline={density === "inline"} />;
}

// ── the proof strip: the card's signature ────────────────────────────────────

/** One mark per red check: red on the left, its after on the right. */
function ProofPips({ card }: { card: ChangeCard }) {
  const after = new Map(card.proof.after.map((c) => [c.name, c.ok]));
  const red = card.proof.before.filter((c) => !c.ok);
  return (
    <span className="cc-pips" aria-hidden>
      {red.map((c, i) => (
        <span key={i} className={`cc-pip ${after.get(c.name) ? "cc-pip-fixed" : "cc-pip-red"}`} style={{ ["--i" as any]: i }} />
      ))}
    </span>
  );
}

function ProofStrip({ card }: { card: ChangeCard }) {
  const summary = proofSummary(card.proof);
  const after = new Map(card.proof.after.map((c) => [c.name, c]));
  const red = card.proof.before.filter((c) => !c.ok);
  const broke = card.proof.after.filter((c) => summary.broke.includes(c.name));
  return (
    <section className="cc-section" data-cc-proof>
      <div className="cc-kicker-row">
        <h3 className="cc-kicker">Proof</h3>
        <span className={`cc-proof-label ${summary.stillRed.length || summary.broke.length ? "text-sol-red" : summary.red ? "text-sol-green" : "text-sol-text-dim"}`}>{summary.label}</span>
      </div>
      {red.length === 0 && !broke.length ? (
        <div className="text-[12px] text-sol-text-dim">Nothing was shown failing before the change.</div>
      ) : (
        <ol className="cc-proof">
          {red.map((b, i) => {
            const a = after.get(b.name);
            const fixed = a?.ok === true;
            return (
              <li key={b.name} className={`cc-proof-row ${fixed ? "is-fixed" : "is-red"}`} style={{ ["--i" as any]: i }}>
                <span className="cc-track" aria-hidden>
                  <span className="cc-dot cc-dot-red" />
                  <span className="cc-wire"><span className="cc-wire-fill" /></span>
                  <span className={`cc-dot ${fixed ? "cc-dot-green" : "cc-dot-red"}`} />
                </span>
                <span className="cc-proof-name" title={b.name}>{b.name}</span>
                <span className="cc-proof-detail">
                  <span className="text-sol-red/80">{b.detail || "failed"}</span>
                  <span className="cc-arrow" aria-hidden>→</span>
                  <span className={fixed ? "text-sol-green" : "text-sol-red"}>{a?.detail || (a ? (fixed ? "passes" : "still fails") : "no after recorded")}</span>
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
              <span className="cc-proof-name" title={a.name}>{a.name}</span>
              <span className="cc-proof-detail"><span className="text-sol-red">broke: {a.detail || "fails after the change"}</span></span>
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
      <span className={`cc-check-mark ${check.ok ? "text-sol-green border-sol-green/40" : "text-sol-red border-sol-red/40"}`}>
        {check.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      </span>
      <span className="text-sol-text shrink-0">{check.name}</span>
      {check.detail && <span className="text-sol-text-dim min-w-0">{check.detail}</span>}
    </li>
  );
}

function ChangeCardFull({ card, inline }: { card: ChangeCard; inline: boolean }) {
  const now = useCoarseNow(60_000);
  const [allExamples, setAllExamples] = useState(!inline);
  const examples = allExamples ? card.examples : card.examples.slice(0, 1);
  const hasGoal = card.goal.ref && card.goal.ref !== "none";
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  return (
    <article className={`change-card ${inline ? "cc-inline" : "cc-full"}`} data-change-card={card.cause.task}>
      {/* Cause and goal: why this run exists and what it serves. */}
      <header className="cc-head">
        <div className="cc-cause">
          <Link href={`/tasks/${card.cause.task}`} className="cc-chip text-sol-violet border-sol-violet/30 hover:bg-sol-violet/10">{card.cause.task}</Link>
          <span className="text-sol-text min-w-0">{card.cause.title}</span>
        </div>
        <div className="cc-cause-meta">
          {card.cause.signals > 0 && <span>{card.cause.signals} signal{card.cause.signals === 1 ? "" : "s"}</span>}
          {card.cause.first_seen && <span>first seen {formatTimeAgo(card.cause.first_seen, now)}</span>}
          {card.cause.sources.map((s) => <span key={s} className="cc-source">{s}</span>)}
        </div>
        {hasGoal && (
          <div className="cc-goal">
            <Target className="w-3.5 h-3.5 text-sol-cyan shrink-0 mt-[3px]" />
            <div className="min-w-0">
              <span className="text-sol-text">{card.goal.name || card.goal.ref}</span>
              <span className="font-mono text-[11px] text-sol-text-dim ml-2">{card.goal.ref}</span>
              {card.goal.why && <div className="text-sol-text-dim text-[12px] mt-0.5">{card.goal.why}</div>}
            </div>
          </div>
        )}
      </header>

      {/* The two sentences a person decides on. */}
      <div className="cc-sentences">
        <div className="cc-sentence">
          <h3 className="cc-kicker">What was wrong</h3>
          <p>{card.wrong}</p>
        </div>
        <div className="cc-sentence">
          <h3 className="cc-kicker">What changes</h3>
          <p>{card.change}</p>
        </div>
      </div>

      <ProofStrip card={card} />

      {card.examples.length > 0 && (
        <section className="cc-section">
          <div className="cc-kicker-row"><h3 className="cc-kicker">Examples</h3><span className="text-[11px] text-sol-text-dim">{card.examples.length} before and after</span></div>
          <div className="space-y-3">
            {examples.map((ex, i) => (
              <div key={i} className="cc-example">
                <div className="cc-example-input" title={ex.input}>{ex.input}</div>
                <div className="cc-pair">
                  <div className="cc-side cc-before"><span className="cc-side-label">Before</span><span>{ex.before}</span></div>
                  <div className="cc-side cc-after"><span className="cc-side-label">After</span><span>{ex.after}</span></div>
                </div>
                {ex.note && <div className="cc-example-note">{ex.note}</div>}
              </div>
            ))}
          </div>
          {card.examples.length > examples.length && (
            <button onClick={() => setAllExamples(true)} className="mt-2 text-[11px] text-sol-blue hover:underline">
              Show {card.examples.length - examples.length} more
            </button>
          )}
        </section>
      )}

      {card.checks.length > 0 && (
        <section className="cc-section">
          <h3 className="cc-kicker">Checks</h3>
          <ul className="cc-checks">{card.checks.map((c) => <CheckRow key={c.name} check={c} />)}</ul>
        </section>
      )}

      <dl className="cc-facts">
        <div className="cc-fact">
          <dt>Diff</dt>
          <dd>
            <span className="text-sol-green">+{card.diff.added}</span> <span className="text-sol-red">−{card.diff.removed}</span>
            <span className="text-sol-text-dim"> in {card.diff.files} file{card.diff.files === 1 ? "" : "s"}</span>
            {card.diff.pr && (
              <a href={card.diff.pr} target="_blank" rel="noreferrer" className="cc-pr"><GitPullRequest className="w-3 h-3" />{prLabel(card.diff.pr)}</a>
            )}
          </dd>
        </div>
        <div className="cc-fact">
          <dt>Risk</dt>
          <dd><span className={`text-sol-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span><div className="text-sol-text-dim text-[12px]">{card.risk.reason}</div></dd>
        </div>
        <div className="cc-fact">
          <dt>Cost</dt>
          <dd>${card.cost.usd.toFixed(2)}<span className="text-sol-text-dim"> · {tokensLabel(card.cost.tokens)} tokens · {card.cost.minutes} min</span></dd>
        </div>
      </dl>

      <div className={`cc-recommend cc-tone-${tone}`}>
        <span className="cc-recommend-verdict">Recommends {verdictLabel(card.recommend.verdict)}</span>
        <span className="text-sol-text-muted">{card.recommend.why}</span>
      </div>
    </article>
  );
}

// ── the queue's line ─────────────────────────────────────────────────────────

function ChangeCardLine({ card }: { card: ChangeCard }) {
  const summary = proofSummary(card.proof);
  const okChecks = card.checks.filter((c) => c.ok).length;
  const tone = VERDICT_TONE[card.recommend.verdict] ?? "blue";
  return (
    <div className="change-card cc-line" data-change-card={card.cause.task}>
      {card.change && <div className="cc-line-change" title={card.change}>{card.change}</div>}
      <div className="cc-line-row">
        <ProofPips card={card} />
        <span className={summary.stillRed.length || summary.broke.length ? "text-sol-red" : "text-sol-text"}>{summary.label}</span>
        <span className="cc-sep">·</span>
        <span className={okChecks === card.checks.length ? "text-sol-text-muted" : "text-sol-red"}>{okChecks}/{card.checks.length} checks</span>
        <span className="cc-sep">·</span>
        <span><span className="text-sol-green">+{card.diff.added}</span> <span className="text-sol-red">−{card.diff.removed}</span></span>
        <span className="cc-sep">·</span>
        <span className={`text-sol-${RISK_TONE[card.risk.class]}`}>{riskLabel(card.risk)}</span>
        <span className="cc-sep">·</span>
        <span className="text-sol-text-dim">${card.cost.usd.toFixed(2)}</span>
        <span className={`cc-line-verdict cc-tone-${tone}`}>recommends {verdictLabel(card.recommend.verdict)}</span>
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
 * Keyboard first: the option's digit answers Ship and Drop at once; Revise
 * opens a note, and return sends it. The note travels with the Revise answer,
 * so a gate routes on Revise and hands the note to build.
 */
export function ChangeCardAnswer({
  decision,
  indexes,
  onAnswer,
  onDismiss,
  keys = false,
  size = "full",
}: {
  decision: SessionDecisionItem;
  indexes: Record<ChangeVerdict, number>;
  onAnswer: (input: DecisionAnswerInput) => void;
  onDismiss?: () => void;
  keys?: boolean;
  size?: "full" | "compact";
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const recommended = decision.card?.recommend.verdict;

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
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      const target = e.target as HTMLElement | null;
      if (target === noteRef.current) {
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setNoteOpen(false); setError(false); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); sendRevise(); }
        return;
      }
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT")) return;
      const n = Number(e.key) - 1;
      const verdict = (Object.keys(indexes) as ChangeVerdict[]).find((v) => indexes[v] === n);
      if (verdict) { e.preventDefault(); e.stopImmediatePropagation(); pick(verdict); return; }
      if ((e.key === "x" || e.key === "X") && onDismiss) { e.preventDefault(); e.stopImmediatePropagation(); onDismiss(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys, indexes, pick, sendRevise, onDismiss]);

  const compact = size === "compact";
  const order: ChangeVerdict[] = (["ship", "revise", "drop"] as ChangeVerdict[]).sort((a, b) => indexes[a] - indexes[b]);
  return (
    <div className="change-card-answer" data-card-answer>
      <div className={`cc-verdicts ${compact ? "is-compact" : ""}`}>
        {order.map((v) => (
          <button
            key={v}
            onClick={() => pick(v)}
            data-verdict={v}
            className={`cc-verdict cc-tone-${VERDICT_TONE[v]} ${recommended === v ? "is-recommended" : ""} ${v === "revise" && noteOpen ? "is-open" : ""}`}
            title={decision.options[indexes[v]]?.description}
          >
            {keys && indexes[v] < 9 && <KeyCap size="xs">{String(indexes[v] + 1)}</KeyCap>}
            <span>{verdictLabel(v)}</span>
            {recommended === v && <span className="cc-verdict-tag">recommended</span>}
            {decision.default_option === indexes[v] && !decision.blocking && <span className="cc-verdict-tag">proceeding</span>}
          </button>
        ))}
        {onDismiss && (
          <button onClick={onDismiss} className="ml-auto flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-red transition-colors" title="Dismiss without answering">
            {keys && <KeyCap size="xs">x</KeyCap>}<span>dismiss</span>
          </button>
        )}
      </div>
      {noteOpen && (
        <div className="cc-note">
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => { setNote(e.target.value); if (error) setError(false); }}
            rows={compact ? 2 : 3}
            placeholder="What should change? This goes back to build."
            className={`w-full bg-sol-card border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none ${error ? "border-sol-red/60" : "border-sol-yellow/40 focus:border-sol-yellow/70"}`}
            onKeyDown={(e) => {
              if (keys) return; // the window listener has it
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendRevise(); }
              if (e.key === "Escape") { setNoteOpen(false); setError(false); }
            }}
          />
          <div className="flex items-center gap-3 mt-1 text-[11px] text-sol-text-dim">
            <button onClick={sendRevise} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">return</KeyCap><span>send Revise</span></button>
            <button onClick={() => { setNoteOpen(false); setError(false); }} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">esc</KeyCap><span>cancel</span></button>
            {error && <span className="text-sol-red">Say what should change.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
