"use client";
// One trial card as a person decides it: the change card, the proposal card,
// or a bare gate, with its answers. /trial and the /line Inbox both draw this,
// each with its own header around it.
import { useMemo } from "react";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";
import type { TrialCardRow } from "../../hooks/useSyncTrial";
import { useSyncSignals, useWorkspaceSignals } from "../../hooks/useSyncSignals";
import { useInboxStore, type DecisionAnswerInput, type SessionDecisionItem } from "../../store/inboxStore";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { findingGist } from "../../lib/line/loopSteps";
import { cn } from "../../lib/utils";
import { OverturnsLine, SeenQuote, proofTile, type SeenCase } from "../decisions/ChangeCardDecision";
import { ExamplePair } from "../decisions/ChangeCardView";
import { PROPOSAL_VERDICT_TONE, PROPOSAL_VERDICT_WORD } from "../decisions/ProposalCardDecision";
import "../decisions/changeCard.css";
import { JudgeFixCardView } from "./JudgeFixCard";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { TrialFactsStrip } from "./TrialFactsStrip";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { impactLine } from "../tasks/impact";
import { cardAsRead, cardProse, evidenceGone, fateWords, goneWhere, proposalAsRead, proposalCase } from "../../lib/trialEvidence";
import { receivedWords } from "@codecast/shared/contracts/moments";
import { PROPOSAL_VERDICT_KEY } from "@codecast/shared/contracts/proposalCard";
import { problemListName } from "../../lib/line/problemTable";
import { trialWords } from "../../lib/line/fixDecision";

/** The card pieces size to their own column (changeCard.css reads the `cc` container). */
const CARD_BOX = { container: "cc / inline-size" } as const;

const wordSet = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 6)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size || 1); };

/** The card as the queue's answer controls read a decision, in the trial's words (trialWords): bare verbs, the
 * same answers the For you reader shows, with "nothing ships" said once by the page rather than under every option. */
function asDecision(c: TrialCardRow, card = c.card): SessionDecisionItem {
  const index = c.answer ? c.options.findIndex((o) => o.key === c.answer!.key) : -1;
  return trialWords({
    _id: c._id,
    short_id: c.short_id,
    conversation_id: "",
    session_id: "",
    question: c.question,
    context_md: c.context_md,
    options: c.options.map((o) => ({ label: o.label })),
    card,
    blocking: true,
    kind: "single",
    status: c.status === "answered" ? "answered" : c.status === "waiting" ? "pending" : "withdrawn",
    ...(index >= 0 ? { answer_index: index } : {}),
    ...(c.answer?.note ? { answer_text: c.answer.note } : {}),
    gate_node_id: c.node_id,
    workflow_run_id: c.run_id,
    created_at: c.created_at,
  } as SessionDecisionItem);
}

/** A card's answer on the trial rail (trialAnswer): the option pressed, or Revise for a typed note. */
function useTrialAnswer(c: TrialCardRow): (input: DecisionAnswerInput) => void {
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  return (input) => {
    if ("dismiss" in input) return;
    const option = input.index !== undefined ? c.options[input.index] : c.options.find((o) => o.key === "R" || verdictOfOption(o.label) === "revise");
    if (option) trialAnswer(c._id, option.key, input.text ?? null);
  };
}

/** The answers of a card its run asks at its own gate (no session posted it): pressed, the key goes to the paused run. */
export function TrialGateAnswer({ card: c }: { card: TrialCardRow }) {
  const decision = useMemo(() => asDecision(c, cardAsRead(c)), [c]);
  const onAnswer = useTrialAnswer(c);
  return <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys size="compact" />;
}

export function answerTone(c: TrialCardRow): string {
  const v = verdictOfOption(c.answer?.label);
  return v === "ship" || c.answer?.key === "A" ? "text-sol-green" : v === "drop" || c.answer?.key === "D" ? "text-sol-red" : "text-sol-yellow";
}

/** Who answered a card, in a row's few words: the agent session that carried it, else the person. */
export function answererWords(c: TrialCardRow): string {
  const a = c.answer;
  if (!a) return "";
  if (a.via) return `by ${a.via}`;
  if (a.stand_in) return "by an agent";
  return a.by_name ? `by ${a.by_name}` : "";
}

/** How the card was answered, in a few words; undefined while it waits. */
export function trialRecord(c: TrialCardRow, now: number): string | undefined {
  if (c.answer) return `${c.answer.stand_in ? "An agent stood in: " : "Would "}${c.answer.label.toLowerCase()} · ${[answererWords(c), formatTimeAgo(c.answer.at, now)].filter(Boolean).join(" · ")}`;
  if (c.superseded_by) return `Superseded by ${c.superseded_by.card ?? c.superseded_by.task}: its problem was merged there`;
  return c.status === "closed" ? "Closed: the run moved on without an answer" : undefined;
}

/** `answer`: what stands where the answers would, on a surface that only shows the card (a row's read-only preview). */
export function TrialCardBody({ card: c, now, answer }: { card: TrialCardRow; now: number; answer?: React.ReactNode }) {
  // A problem left with no findings has nothing behind the change: the card reads stale and recommends Drop.
  const card = useMemo(() => cardAsRead(c), [c]);
  const gone = c.evidence && evidenceGone(c.evidence) ? goneWhere(c.evidence) : undefined;
  const decision = useMemo(() => asDecision(c, card), [c, card]);
  const waiting = c.status === "waiting" && !c.stale_gate;
  const onAnswer = useTrialAnswer(c);
  // The conversations behind the cause the card's author picked as most central, each with what the contact asked for;
  // an older card without picks reads the two that sound most like its problem.
  useSyncSignals(c.workspace);
  const signals = useWorkspaceSignals(c.workspace);
  const mine = useMemo(() => signals.filter((s) => s.task_id === c.task_id), [signals, c.task_id]);
  const about = useMemo(() => wordSet(`${c.card?.cause.title ?? ""} ${c.card?.wrong ?? ""}`), [c.card]);
  const seen = useMemo<SeenCase[]>(() => {
    // Only a case the change reaches shows it: with none reached, the card says so instead of showing another cause.
    const covers = c.card?.reach?.covers;
    if (c.coverage && c.coverage.covered === 0 && covers) return [];
    const picks = (c.card?.seen ?? []).filter((p) => !covers || covers.includes(p.signal));
    if (picks.length) {
      return picks.flatMap((p) => {
        // The author may cite a finding on the same conversation that grouping has not filed here yet: it is still the case.
        const s = mine.find((x) => x.short_id === p.signal) ?? signals.find((x) => x.short_id === p.signal);
        if (!s) return [];
        // Only words a contact received: an extractor's match tag or cut is never quoted as something Union sent.
        const sent = receivedWords(p.quote ?? "");
        const quote = sent || receivedWords(findingGist(s).says ?? "") || s.title;
        return [{ key: s._id, title: s.title, quote, asked: p.asked, missing: p.missing, at: s.observed_at, finding: !sent }];
      });
    }
    return mine
      .filter((s) => !covers || (!!s.short_id && covers.includes(s.short_id)))
      .map((s) => ({ s, quote: receivedWords(findingGist(s).quote ?? ""), near: overlap(wordSet(s.title), about) }))
      .filter((x): x is { s: typeof x.s; quote: string; near: number } => !!x.quote && x.quote.length > 30)
      .sort((a, b) => b.near - a.near || (b.s.severity ?? 0) - (a.s.severity ?? 0) || b.s.observed_at - a.s.observed_at)
      .filter((x, i, all) => all.findIndex((y) => y.quote === x.quote) === i)
      .slice(0, 2)
      .map(({ s, quote }) => ({ key: s._id, title: s.title, quote, at: s.observed_at }));
  }, [mine, signals, c.card, c.coverage, about]);
  // The problem's conversations now: the server's live count, else the store's (a feed of two weeks), never the card's frozen one.
  const counted = useMemo(() => new Set(mine.map(findingConversation)).size, [mine]);
  const live = c.evidence ? c.evidence.conversations : counted || undefined;
  const impact = useMemo(() => impactLine(mine), [mine]);
  // A proposal card's one conversation, while it is still a finding on this problem: its sent words (an extractor's
  // marks removed), or the finding's own text when none show the miss. A judge-review card reads it as what the judge
  // said, what it read, and what was there.
  const cited = proposalCase(c);
  const caseLive = !cited || cited.state === "live";
  const proposalSeen = useMemo<SeenCase | null>(() => {
    const pc = c.proposal?.case;
    const s = pc ? mine.find((x) => x.short_id === pc.signal) ?? signals.find((x) => x.short_id === pc.signal) : undefined;
    // A case that left this problem is not swapped for another finding: a bare quote with no situation and nothing
    // named missing shows nothing wrong. The card says where its case went and is held to be carded again (trialHold).
    if (!pc || !s || !caseLive) return null;
    const sent = receivedWords(pc.quote ?? "");
    if (c.tooling) return { key: s._id, title: s.title, claim: s.title, quote: sent, asked: pc.asked, missing: pc.missing, at: s.observed_at };
    return { key: s._id, title: s.title, quote: sent || receivedWords(findingGist(s).says ?? "") || s.title, asked: pc.asked, missing: pc.missing, at: s.observed_at, finding: !sent, ...(pc.beats?.length ? { beats: pc.beats } : {}) };
  }, [c.proposal, c.tooling, mine, signals, caseLive]);
  // Why there is no case to show: none was cited, or the one cited left this problem.
  const noCase = !c.proposal || proposalSeen ? null
    : !c.proposal.case ? "no conversation shows the miss"
    : cited?.state === "withdrawn" ? `${cited.signal} ${cited.fate ? fateWords({ fate: cited.fate } as Parameters<typeof fateWords>[0]) : "withdrawn"}`
    : cited?.state === "elsewhere" ? `${cited.signal} sits on ${cited.to ?? "another problem"} now`
    : `${c.proposal.case.signal} is not on this problem`;
  // With nothing left behind it and no count of its own, a proposal reads Not now, whatever its author recommended.
  const proposal = useMemo(() => proposalAsRead(c.proposal, c.evidence), [c.proposal, c.evidence]);
  const recommendation = proposal?.recommend ? c.options.findIndex((o) => o.key === PROPOSAL_VERDICT_KEY[proposal.recommend!.verdict]) : -1;
  const record = trialRecord(c, now);
  const recordLine = record ? <p className={cn("text-[12.5px]", c.status === "answered" ? answerTone(c) : "text-sol-text-dim")} data-trial-record>{record}{c.answer?.note ? `: ${c.answer.note}` : ""}</p> : null;

  // One layout for every card (TrialDecisionFrame): the question, what changes, the case, then the page or the
  // proposal; answers and the checked facts stay in the side column. A card held at a gate its line dropped has no
  // answer to give.
  const controls = (extra?: { caption?: boolean; recommendation?: number }) =>
    answer !== undefined ? answer
    : c.stale_gate ? <StaleGate node={c.node_id} />
    : waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys size="compact" {...extra} />
    : recordLine;
  // A fix that reaches none of the problem's conversations has no case of its own: the problem's plainest one is
  // shown as what it leaves, so the reader sees what still stands.
  const uncovered = !gone && c.coverage?.covered === 0 && !!live ? mine
    .map((s) => ({ s, quote: receivedWords(findingGist(s).quote ?? "") || receivedWords(findingGist(s).says ?? "") }))
    .filter((x) => x.quote.length > 30)
    .sort((a, b) => (b.s.severity ?? 0) - (a.s.severity ?? 0) || b.s.observed_at - a.s.observed_at)
    .slice(0, 1)
    .map(({ s, quote }): SeenCase => ({ key: s._id, title: s.title, quote, at: s.observed_at }))[0] : undefined;
  const leftOut = uncovered ? (
    <section className="cc-section" data-card-uncovered>
      <div className="cc-label-row"><h3 className="cc-label">Not covered by this fix</h3><span className="text-[11px] text-sol-text-dim">{live} {live === 1 ? "conversation" : "conversations"} still open</span></div>
      <ul className="ccd-seen"><SeenQuote c={uncovered} /></ul>
    </section>
  ) : null;

  if (c.judge_fix && !c.decision) {
    return <JudgeFixCardView card={c.judge_fix} problem={c.task_title ? problemListName({ title: c.task_title, name: c.task_name }) : undefined} overlaps={c.overlaps} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} size="compact" />} />;
  }
  if (c.decision) {
    const d = c.decision;
    // The session's own text leads with its recommendation, so the answers do not say it a second time.
    return (
      <TrialDecisionFrame card={c} question={c.question} answer={controls({ caption: !c.context_md })}>
        {c.context_md && <div className="mt-3 text-[13px]" data-trial-lead><MarkdownRenderer content={cardProse(c.context_md, c)} /></div>}
        {/* The session's own text names what its fix leaves; a card with no text of its own shows the plainest case left. */}
        {!c.context_md && leftOut}
        {d.report_slug ? (
          <section className="mt-5" data-trial-decision-page>
            <PublishedPageEmbed slug={d.report_slug} decision={d._id} height={1100} />
          </section>
        ) : c.doc_md ? (
          <section className="mt-5 border-t border-sol-border/30 pt-5"><MarkdownRenderer content={cardProse(c.doc_md, c)} /></section>
        ) : null}
      </TrialDecisionFrame>
    );
  }
  if (card) {
    const proof = proofTile(card);
    return (
      <TrialDecisionFrame card={c} question={card.headline || c.question} answer={controls()}>
        <div className="change-card mt-4 flex flex-col gap-5" style={CARD_BOX} data-change-card={card.cause.task}>
          <div className="ccd-shift" data-card-shift>
            <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{card.wrong}</div>
            {card.change && <div className="ccd-side ccd-after"><span className="ccd-side-label">With this change</span>{card.change}</div>}
          </div>
          {card.overturns && <OverturnsLine o={card.overturns} />}
          {gone && <p className="ccd-nocase" data-card-nocase><b>No current evidence</b> · {gone}</p>}
          {leftOut}
          {seen.length > 0 && card.examples.length === 0 && (
            <section className="cc-section" data-card-seen>
              <div className="cc-label-row"><h3 className="cc-label">What contacts got today</h3></div>
              <ul className="ccd-seen">{seen.map((x) => <SeenQuote key={x.key} c={x} />)}</ul>
            </section>
          )}
          {card.examples.length > 0 && (
            <section className="cc-section ccd-examples" data-card-examples>
              <div className="cc-label-row"><h3 className="cc-label">{gone ? "Earlier cases, no longer counted" : proof.real ? "Real cases, before and after" : "Real cases, and what should happen"}</h3></div>
              <div className="space-y-4">{card.examples.map((ex, i) => <ExamplePair key={i} ex={ex} afterLabel={proof.real ? "After" : "Expected"} />)}</div>
            </section>
          )}
        </div>
      </TrialDecisionFrame>
    );
  }
  if (proposal) {
    const rec = proposal.recommend;
    return (
      <TrialDecisionFrame card={c} question={proposal.question} answer={controls({ recommendation: recommendation >= 0 ? recommendation : undefined })}>
        <div className="change-card mt-4 flex flex-col gap-5" style={CARD_BOX} data-proposal-card>
          <div className="ccd-shift" data-card-shift>
            <div className="ccd-side ccd-today"><span className="ccd-side-label">Today</span>{proposal.today}</div>
            <div className="ccd-side ccd-after"><span className="ccd-side-label">After this fix</span>{proposal.after}</div>
          </div>
          {proposal.overturns && <OverturnsLine o={proposal.overturns} />}
          {rec && (
            <p className={`cc-why cc-tone-${PROPOSAL_VERDICT_TONE[rec.verdict]}`} data-cc-recommended data-proposal-verdict={rec.verdict}>
              <span className="cc-why-lead">{PROPOSAL_VERDICT_WORD[rec.verdict]} recommended:</span> {rec.why}
            </p>
          )}
          {(proposalSeen || noCase) && (
            <section className="cc-section" data-card-seen>
              <div className="cc-label-row"><h3 className="cc-label">{c.tooling ? "What the judge saw vs what was there" : "What the contact got"}</h3></div>
              {proposalSeen ? <ul className="ccd-seen"><SeenQuote c={proposalSeen} /></ul> : <p className="ccd-nocase" data-card-nocase><b>No case on file</b> · {noCase}</p>}
            </section>
          )}
          {c.doc_md && (
            <details className="cc-section ccd-doc" data-proposal-doc>
              <summary className="cc-label cursor-pointer">Full proposal</summary>
              <div className="mt-3"><MarkdownRenderer content={c.doc_md} /></div>
            </details>
          )}
        </div>
      </TrialDecisionFrame>
    );
  }
  return (
    <TrialDecisionFrame card={c} question={c.question} answer={controls()}>
      {c.doc_md && <section className="mt-5 border-t border-sol-border/30 pt-5"><MarkdownRenderer content={c.doc_md} /></section>}
    </TrialDecisionFrame>
  );
}

/** A card held at a gate its line dropped: what happened, where an answer would normally be. */
function StaleGate({ node }: { node: string }) {
  return (
    <div className="rounded-md border border-sol-yellow/40 bg-sol-yellow/5 px-3 py-2.5 text-[12.5px]" data-trial-stale-gate={node}>
      <div className="font-medium text-sol-yellow">No answer to give</div>
      <div className="mt-0.5 text-sol-text-muted">The line dropped its <span className="font-mono text-sol-text">{node.replace(/_/g, " ")}</span> step</div>
    </div>
  );
}

/**
 * The one layout a trial card is read in, whoever wrote it: the question and
 * the problem it answers, then what changes, the case and the full page in
 * the reading column; the answers and the facts the line checked stay beside
 * it. A card its station's session posted names that session, to talk it
 * over before answering.
 */
function TrialDecisionFrame({ card: c, question, answer, children }: { card: TrialCardRow; question: string; answer: React.ReactNode; children?: React.ReactNode }) {
  const d = c.decision;
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start" data-trial-decision={d?.short_id ?? d?._id ?? c.short_id} data-trial-frame={d ? "session" : c.card ? "change" : c.proposal ? "proposal" : "gate"}>
      <div className="min-w-0 flex-1">
        <h1 className="decision-question text-sol-text">{question}</h1>
        <p className="mt-1 text-[12px] text-sol-text-muted">{problemListName({ title: c.task_title, name: c.task_name })}</p>
        {children}
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:sticky lg:top-4 lg:w-80">
        <section data-trial-answer>{answer}</section>
        <div className="rounded-md border border-sol-border/40 p-3">
          {d?.session && c.status === "waiting" && (
            <Link href={`/conversation/${d.session._id}`} className="mb-3 flex items-center gap-1.5 text-[12px] text-sol-blue hover:underline" data-trial-session title={[d.session.title, d.session.short_id].filter(Boolean).join(" · ") || undefined}>
              <MessageSquare className="h-3.5 w-3.5" /> Talk to the session presenting this {c.proposal && !c.card ? "proposal" : c.card ? "fix" : "question"}
            </Link>
          )}
          <TrialFactsStrip card={c} />
        </div>
      </aside>
    </div>
  );
}
