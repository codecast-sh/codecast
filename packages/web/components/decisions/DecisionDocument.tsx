"use client";

import { gateDoc } from "@codecast/shared/contracts/changeCard";
import { useRef, useState, type WheelEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Check, MessageSquare, MessagesSquare } from "lucide-react";
import type { SessionDecisionItem, DecisionDetailItem } from "../../store/inboxStore";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../hooks/useSyncTaskEvidence";
import { useDecisionDiscussion } from "../../hooks/useDecisionDiscussion";
import { useJumpToDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { DoubtChip } from "../line/DoubtChip";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { AppLoader } from "../AppLoader";
import { DecisionAnswerControls } from "./DecisionAnswerControls";
import { DecisionOptionList } from "./DecisionOptionList";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { DecisionBody, DecisionFacts, DecisionLadder, LeadRecommendation, hasDecisionBody } from "./DecisionSections";
import { GateRunChip } from "./DecisionCompactCard";
import { DeployedIn } from "../line/widgets/DeployedIn";
import { OptionPages } from "./OptionPages";
import { HandoffNote } from "./DecisionParties";
import { ChangeCardHeadline, ChangeCardVerdictBar, ChangeCardView } from "./ChangeCardView";
import { ShareControl } from "../ShareControl";
import { decisionWaitLabel } from "../../lib/decisionLinks";
import { DecisionAnswerPanel, restatesCard, useDecisionAnswering, useDecisionPage } from "./DecisionAnswering";
import "./decisions.css";

// The decision document page (docs/architecture/decisions-as-documents.md
// D4). Reads the store: the live row from sessionDecisions (optimistic
// answers land there first) and the page context from decisionDetails, which
// useSyncDecisionDetail feeds from getWithDoc. The answer footer is the same
// store action the compact card and the transcript card use.
export function DecisionDocument({ id }: { id: string }) {
  const page = useDecisionPage(id);
  if (!page.detail || !page.decision) {
    if (page.missing && page.ready) return <Empty text="This decision does not exist, or it is not yours to read." />;
    return <AppLoader />;
  }
  return <DocumentBody decision={page.decision} detail={page.detail} answerable={page.answerable} />;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <div className="text-lg text-sol-text">{text}</div>
      <Link href="/questions" className="text-sm text-sol-text-dim hover:text-sol-text">Back to the queue</Link>
    </div>
  );
}

function DocumentBody({ decision, detail, answerable }: { decision: SessionDecisionItem; detail: DecisionDetailItem; answerable: boolean }) {
  const a = useDecisionAnswering(decision, detail, answerable);
  const { now, pending, rec, answerInOptions, verdictBar, chosen, onAnswer, onDismiss, heldNote, outcome, closed, banner, doubt } = a;
  // A card's cause task may carry the author's change guide; its evidence row holds it.
  useSyncTaskEvidence(a.cardTask);
  const guide = useTaskEvidenceByShortId(a.cardTask)?.change_guide ?? null;
  const discussion = useDecisionDiscussion(decision._id);
  const [discussOpen, setDiscussOpen] = useState(false);

  // The page stands on the thread that asked: scrolling up off its top opens
  // that thread at the ask, the way the sheet in a session hands its pane
  // back. Only a scroll that STARTS at the top counts, so coasting back up a
  // long decision never leaves the page.
  const jumpToAsk = useJumpToDecisionAsk(decision.conversation_id, decision._id, decision.question);
  const pull = useRef({ last: 0, armed: false, sum: 0 });
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = pull.current;
    if (e.timeStamp - p.last > 200) { p.armed = e.currentTarget.scrollTop <= 0; p.sum = 0; }
    p.last = e.timeStamp;
    if (e.deltaY > 0) p.armed = false;
    if (!p.armed) return;
    p.sum -= e.deltaY;
    if (p.sum > 80) { p.armed = false; void jumpToAsk(); }
  };

  // Who asked, who may answer, who holds it. A change card leads with the
  // change and its proof, so for one these facts follow the card.
  const meta = <DecisionFacts decision={decision} detail={detail} ladder={detail.ladder.length ? <DecisionLadder decision={decision} detail={detail} now={now} /> : undefined} />;

  // A card's attached doc that only restates the card ("What is wrong: ...")
  // is said once, by the card.
  const restated = !!decision.card && restatesCard(gateDoc(detail.doc?.content ?? ""), decision.card);
  const body = hasDecisionBody(decision, detail) && !restated ? <DecisionBody decision={decision} detail={detail} /> : null;

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll onWheel={onWheel}>
      {/* One measure for every decision: a change card stacks its proof over its examples, so it needs no wider page. */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-16">
        <Link href="/questions" className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors no-underline">
          <ArrowLeft className="w-3 h-3" /> The queue
        </Link>

        {/* ── Header ── */}
        <header className="mt-4">
          {banner && <div className="decision-status-banner mb-3" role="status" data-decision-banner={decision.status}>{banner}</div>}
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
            {/* The wait leads, as its consequence for the reader; a settled
                card says its verdict once, as the card's last line with who
                and when, so the header keeps only the age. */}
            {!outcome && !banner && (
              // Words in the wait's tone, not a box: the headline under it is the thing to read.
              <span className={pending ? (decision.blocking ? "text-sol-yellow" : "text-sol-blue") : "text-sol-text-dim"}>
                {decisionWaitLabel(decision)}
              </span>
            )}
            <span>{!outcome && !banner && "· "}asked {formatTimeAgo(decision.created_at, now)}</span>
            {decision.resolved_at && !outcome && !banner && <span>· resolved {formatTimeAgo(decision.resolved_at, now)}</span>}
            {/* A gate on the line (the-line.md L4): the run this question pauses. */}
            {decision.workflow_run_id && <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />}
            {/* A line card answered Ship: the deploy that put its fix live (deploys.md). */}
            {decision.workflow_run_id && decision.status === "answered" && <DeployedIn taskId={decision.task_id} />}
            {/* The id is for citing, so it trails the line. */}
            <span className="font-mono opacity-70">{decision.short_id ?? "decision"}</span>
            <ShareControl label="decision" path={`/decisions/${decision.short_id ?? decision._id}`} publicShare={{ kind: "decision", id: decision._id, token: (decision as any).share_token }} className="ml-auto" />
          </div>
          {/* A change card leads with what changed, and its cause and goal under
              it, so the first line says what and the second says why. */}
          {decision.card ? <ChangeCardHeadline card={decision.card} question={decision.question} questionFirst className="mt-3" /> : (
            <>
              <h1 className="mt-3 decision-question text-sol-text">{decision.question}</h1>
              {meta}
            </>
          )}
          <HandoffNote decision={decision} className="mt-3" />
        </header>

        {/* A lead's call and why, before the evidence it was made on. */}
        <LeadRecommendation decision={decision} detail={detail} />

        {/* The doubt the record raised about the cause, where a reviewer cannot miss it. */}
        {doubt && <DoubtChip doubt={doubt} className="mt-3" />}

        {/* Discuss sits by the status as a real button, saying where it goes. */}
        <div className="mt-4 flex items-center gap-2.5 flex-wrap" data-decision-discuss>
          <button
            type="button"
            onClick={() => void jumpToAsk()}
            className="inline-flex items-center gap-1.5 rounded-md border border-sol-border px-2.5 py-1 text-[12.5px] text-sol-text hover:border-sol-blue/60 hover:text-sol-blue transition-colors"
            data-decision-open-thread
          >
            <MessagesSquare className="w-3.5 h-3.5" />Thread
          </button>
          {(discussion.owner || discussion.thread.length > 0) && (<>
            <button
              type="button"
              onClick={() => { setDiscussOpen(true); requestAnimationFrame(() => document.getElementById("discuss")?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-sol-border px-2.5 py-1 text-[12.5px] text-sol-text hover:border-sol-cyan/60 hover:text-sol-cyan transition-colors"
              data-decision-discuss-button
            >
              <MessageSquare className="w-3.5 h-3.5" />{discussion.thread.length ? "Reply in the discussion" : "Discuss"}
            </button>
            {discussion.owner && <span className="text-[12px] text-sol-text-dim">Opens a thread with {discussion.owner.name ?? "the session that asked"} about this {decision.card ? "card" : "decision"}.</span>}
          </>)}
        </div>

        {/* Sticky, so it is a sibling of the page's sections, not inside the header. */}
        {verdictBar && decision.card && heldNote && <div className="mt-4">{heldNote}</div>}
        {verdictBar && decision.card && (
          <ChangeCardVerdictBar card={decision.card}>
            <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={pending ? onDismiss : undefined} keys recommendation={rec} record={outcome?.pill} />
          </ChangeCardVerdictBar>
        )}

        {/* ── The change card (LE11), drawn natively; its page stays on the task ── */}
        {/* The agent's own context reads right under the card, before the facts. */}
        {decision.card && (
          <section className="mt-6">
            <ChangeCardView card={decision.card} density="full" change={false} recommend={!verdictBar} outcome={closed ? undefined : outcome?.line} summarized={verdictBar} guide={guide} />
            {body && <div className="mt-6">{body}</div>}
            {meta}
          </section>
        )}

        {/* ── Body ── */}
        {!decision.card && body && <section className="mt-8">{body}</section>}

        {/* ── Options ── */}
        {/* A settled card's options collapse into its outcome line. */}
        {!verdictBar && !outcome && <section className="mt-8">
          <h2 className="decision-kicker">{decision.card ? "Your call" : "Options"}{decision.kind && decision.kind !== "single" ? ` · ${decision.kind === "multi" ? "pick several" : decision.kind === "rank" ? "rank them" : "a form"}` : ""}</h2>
          {/* Option pages (L6) compare side by side above the list; a card's
              number answers on a single kind, where one option is the answer. */}
          <div className="mt-3 empty:hidden">
            <OptionPages
              decision={decision}
              answerable={pending && answerable && (decision.kind ?? "single") === "single"}
              onAnswer={(index) => onAnswer({ index })}
              chosen={chosen}
            />
          </div>
          {/* While the reader may answer, the option rows ARE the answer
              surface (the same controls the queue card uses), so the page
              never lists the options once to read and again to click. A
              form's options are context for its fields, which sit in the
              footer; a settled or held decision reads its rows plainly. */}
          <div className="mt-3">
            {answerInOptions ? (
              <>
                {heldNote}
                <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys recommendation={rec} />
              </>
            ) : (
              <DecisionOptionList
                options={decision.options}
                tone={(i) => (chosen.has(i) ? "picked" : "plain")}
                leading={(i) => chosen.has(i) ? (
                  <span className="w-6 h-6 rounded-full border border-sol-green text-sol-green flex items-center justify-center"><Check className="w-3.5 h-3.5" /></span>
                ) : undefined}
                tags={(i) => (
                  <>
                    {rec === i && <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-cyan/40 text-sol-cyan">a lead recommends</span>}
                    {decision.default_option === i && !decision.blocking && <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim">the agent's default</span>}
                  </>
                )}
              />
            )}
          </div>
          {decision.kind === "form" && decision.form && (
            <div className="mt-3 text-[12px] text-sol-text-dim">
              Fields: {decision.form.fields.map((f) => `${f.label} (${f.type})`).join(", ")}
            </div>
          )}
        </section>}

        {/* ── Discuss: with the session that owns the decision (ct-58330);
            the button by the status opens it, so it shows once in use ── */}
        {(discussOpen || discussion.thread.length > 0) && (
          <section className="mt-8" id="discuss" data-decision-discuss-section>
            <h2 className="decision-kicker mb-3">Discussion</h2>
            <DecisionDiscussion decisionId={decision._id} open={discussOpen} onOpenChange={setDiscussOpen} bare />
          </section>
        )}

        {/* ── Answer ── */}
        {a.answerSection && <section className="mt-8 decision-footer rounded-xl border border-sol-border/70 bg-sol-card/50 p-4 sm:p-5">
          <DecisionAnswerPanel decision={decision} detail={detail} answerable={answerable} a={a} />
        </section>}
      </div>
    </div>
  );
}
