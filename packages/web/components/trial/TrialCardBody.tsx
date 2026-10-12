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
import { ChangeCardDecision, type SeenCase } from "../decisions/ChangeCardDecision";
import { ProposalCardDecision } from "../decisions/ProposalCardDecision";
import { JudgeFixCardView } from "./JudgeFixCard";
import { DecisionAnswerControls } from "../decisions/DecisionAnswerControls";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { TrialFactsStrip } from "./TrialFactsStrip";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import type { TrialDecision } from "../../hooks/useSyncTrial";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { impactLine } from "../tasks/impact";
import { cardAsRead, evidenceGone, fateWords, goneWhere, priorArt, proposalAsRead, proposalCase, ruleId } from "../../lib/trialEvidence";
import { receivedWords } from "@codecast/shared/contracts/moments";
import { PROPOSAL_VERDICT_KEY } from "@codecast/shared/contracts/proposalCard";

const wordSet = (t: string) => new Set(t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).map((w) => w.slice(0, 6)));
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size || 1); };

/** The card as the queue's answer controls read a decision. */
function asDecision(c: TrialCardRow, card = c.card): SessionDecisionItem {
  const index = c.answer ? c.options.findIndex((o) => o.key === c.answer!.key) : -1;
  return {
    _id: c._id,
    short_id: c.short_id,
    conversation_id: "",
    session_id: "",
    question: c.question,
    context_md: c.context_md,
    options: c.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    card,
    blocking: true,
    kind: "single",
    status: c.status === "answered" ? "answered" : c.status === "waiting" ? "pending" : "withdrawn",
    ...(index >= 0 ? { answer_index: index } : {}),
    ...(c.answer?.note ? { answer_text: c.answer.note } : {}),
    gate_node_id: c.node_id,
    workflow_run_id: c.run_id,
    created_at: c.created_at,
  } as SessionDecisionItem;
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

export function TrialCardBody({ card: c, now }: { card: TrialCardRow; now: number }) {
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  // A problem left with no findings has nothing behind the change: the card reads stale and recommends Drop.
  const card = useMemo(() => cardAsRead(c), [c]);
  const gone = c.evidence && evidenceGone(c.evidence) ? goneWhere(c.evidence) : undefined;
  const decision = useMemo(() => asDecision(c, card), [c, card]);
  const waiting = c.status === "waiting";
  const onAnswer = (input: DecisionAnswerInput) => {
    if ("dismiss" in input) return;
    const option = input.index !== undefined ? c.options[input.index] : c.options.find((o) => o.key === "R" || verdictOfOption(o.label) === "revise");
    if (option) trialAnswer(c._id, option.key, input.text ?? null);
  };
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
      .filter((s) => !covers || covers.includes(s.short_id))
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
  // A proof run on top of this problem's own earlier branch builds on nothing elsewhere: no "Builds on" row for it.
  const builds = priorArt(c.proposal?.proof?.prior_art);
  const facts = {
    rule: c.rule ? { id: ruleId(c.rule.id), text: c.rule.text } : null,
    builds: builds && builds.ref !== c.task_short_id ? builds : null,
    overlaps: (c.overlaps ?? []).map((o) => ({ ...o, how: c.proposal?.alongside?.find((a) => a.card === o.card)?.line })),
  };
  // With nothing left behind it and no count of its own, a proposal reads Not now, whatever its author recommended.
  const proposal = useMemo(() => proposalAsRead(c.proposal, c.evidence), [c.proposal, c.evidence]);
  const recommendation = proposal?.recommend ? c.options.findIndex((o) => o.key === PROPOSAL_VERDICT_KEY[proposal.recommend!.verdict]) : -1;
  const record = trialRecord(c, now);
  const recordLine = record ? <p className={cn("text-[12.5px]", c.status === "answered" ? answerTone(c) : "text-sol-text-dim")} data-trial-record>{record}{c.answer?.note ? `: ${c.answer.note}` : ""}</p> : null;

  if (c.decision) {
    return <SessionDecision card={c} decision={c.decision} answer={waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys describe /> : recordLine} />;
  }
  if (c.judge_fix) {
    return <JudgeFixCardView card={c.judge_fix} problem={c.task_title || undefined} overlaps={c.overlaps} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />;
  }
  if (card) {
    return <ChangeCardDecision card={card} seen={seen} impact={impact || undefined} live={live} gone={gone} problem={c.task_title || undefined} coverage={c.coverage} owed={c.evals_owed} facts={{ overlaps: c.overlaps }} answer={<DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys={waiting} record={record} describe />} />;
  }
  if (proposal) {
    return (
      <ProposalCardDecision
        card={proposal}
        seen={proposalSeen}
        impact={impact || undefined}
        live={live}
        gone={gone}
        noCase={noCase}
        tooling={c.tooling}
        facts={facts}
        answer={waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys describe recommendation={recommendation >= 0 ? recommendation : undefined} /> : recordLine}
        doc={c.doc_md ? <MarkdownRenderer content={c.doc_md} /> : null}
      />
    );
  }
  return (
    <>
      <h1 className="decision-question text-sol-text">{c.question}</h1>
      <p className="mt-1 text-[12px] text-sol-text-muted">{c.task_title}</p>
      <section className="mt-5">{waiting ? <DecisionAnswerControls decision={decision} onAnswer={onAnswer} keys /> : recordLine}</section>
      {c.doc_md && <section className="mt-8 border-t border-sol-border/30 pt-6"><MarkdownRenderer content={c.doc_md} /></section>}
    </>
  );
}

/**
 * A card its station's session posted: the session's own question, page and
 * answers lead, and the facts the line checked sit beside them as a strip.
 * The session is one click away, to talk it over before answering.
 */
function SessionDecision({ card: c, decision: d, answer }: { card: TrialCardRow; decision: TrialDecision; answer: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start" data-trial-decision={d.short_id ?? d._id}>
      <div className="min-w-0 flex-1">
        <h1 className="decision-question text-sol-text">{c.question}</h1>
        <p className="mt-1 text-[12px] text-sol-text-muted">{c.task_title}</p>
        {c.context_md && <div className="mt-3 text-[13px]"><MarkdownRenderer content={c.context_md} /></div>}
        {d.report_slug ? (
          <section className="mt-5" data-trial-decision-page>
            <PublishedPageEmbed slug={d.report_slug} height={1100} />
          </section>
        ) : c.doc_md ? (
          <section className="mt-5 border-t border-sol-border/30 pt-5"><MarkdownRenderer content={c.doc_md} /></section>
        ) : null}
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-4 lg:sticky lg:top-4 lg:w-80">
        <section data-trial-answer>{answer}</section>
        <div className="rounded-md border border-sol-border/40 p-3">
          {d.session && (
            <Link href={`/conversation/${d.session._id}`} className="mb-3 flex items-center gap-1.5 text-[12px] text-sol-blue hover:underline" data-trial-session title={d.session.title ?? undefined}>
              <MessageSquare className="h-3.5 w-3.5" /> Talk to {d.session.short_id ?? "the session"}
            </Link>
          )}
          <TrialFactsStrip card={c} />
        </div>
      </aside>
    </div>
  );
}
