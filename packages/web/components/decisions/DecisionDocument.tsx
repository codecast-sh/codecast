"use client";

import { EntityIdPill } from "../EntityIdPill";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { advisoryAnswerOpen } from "@codecast/shared/contracts";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Check, MessageSquare, ShieldCheck, Undo2 } from "lucide-react";
import { answersForOthers, mayAnswerFromDocument, useInboxStore, useTrackedStore, type SessionDecisionItem, type DecisionDetailItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { useSyncDecisionDetail, useDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../hooks/useSyncTaskEvidence";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWorkflowRun } from "../../hooks/useSyncWorkflows";
import { useDecisionDiscussion } from "../../hooks/useDecisionDiscussion";
import { carriedApproval, earlierApprovalWords, runEnd, shortDay, type ReportRun } from "../../lib/line/runReport";
import { lineTraceHref } from "../../lib/line/lineMapUrl";
import { causeDoubt } from "../../lib/line/lineTrace";
import { DoubtChip } from "../line/DoubtChip";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { AppLoader } from "../AppLoader";
import { DecisionAnswerControls, DecisionRecordedAnswer } from "./DecisionAnswerControls";
import { DecisionOptionList } from "./DecisionOptionList";
import { PersonChip } from "./DecisionParties";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { DecisionBody, DecisionFacts, DecisionLadder, hasDecisionBody } from "./DecisionSections";
import { GateRunChip } from "./DecisionCompactCard";
import { OptionPages } from "./OptionPages";
import { ChangeCardHeadline, ChangeCardVerdictBar, ChangeCardView, answererNameOf, cardAnswerIndexes, cardOutcome, settledAgo } from "./ChangeCardView";
import { ShareControl } from "../ShareControl";
import { chosenOptions, decisionWaitLabel, ladderRecommendation } from "../../lib/decisionLinks";
import "./decisions.css";

const api = _api as any;

// The decision document page (docs/architecture/decisions-as-documents.md
// D4). Reads the store: the live row from sessionDecisions (optimistic
// answers land there first) and the page context from decisionDetails, which
// useSyncDecisionDetail feeds from getWithDoc. The answer footer is the same
// store action the compact card and the transcript card use.
export function DecisionDocument({ id }: { id: string }) {
  const { ready, missing } = useSyncDecisionDetail(id);
  const detail = useDecisionDetail(id);
  const liveRow = useInboxStore((s) => (detail ? s.sessionDecisions[detail._id] : undefined));
  const meId = useInboxStore((s) => String(s.currentUser?._id ?? ""));
  if (!detail) {
    if (missing && ready) return <Empty text="This decision does not exist, or it is not yours to read." />;
    return <AppLoader />;
  }
  // The store row is the queue's; the detail's copy is the server's read.
  // Any signed-in reader answers either way: a role on the ladder that heard
  // it first, or a decision asked of somebody else, keeps it out of their
  // queue, not out of their hands (onAnswer adopts the detail's copy first).
  const decision: SessionDecisionItem = liveRow ?? detail.decision;
  return <DocumentBody decision={decision} detail={detail} answerable={!!liveRow || mayAnswerFromDocument(detail, meId)} />;
}

/** Whether a card's attached doc only says the card's own fields again (the
 *  line's decide step writes "What is wrong: ... What this changes: ..."). */
function restatesCard(doc: string | undefined, card: { wrong?: string; change?: string }): boolean {
  const flat = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const d = flat(doc);
  const wrong = flat(card.wrong).slice(0, 80);
  const change = flat(card.change).slice(0, 80);
  return !!d && ((!!wrong && d.includes(wrong)) || (!!change && d.includes(change)));
}

type CauseRow = Parameters<typeof causeDoubt>[0] & { short_id?: string };
/** One scan per change of the tasks collection, cached by ref: the selector runs on every store change. */
const causeCache = new WeakMap<object, Map<string, CauseRow | null>>();
const causeByShortId = (tasks: Record<string, CauseRow> | undefined, ref: string): CauseRow | null => {
  if (!tasks) return null;
  let byRef = causeCache.get(tasks);
  if (!byRef) { byRef = new Map(); causeCache.set(tasks, byRef); }
  if (byRef.has(ref)) return byRef.get(ref)!;
  let hit: CauseRow | null = null;
  for (const id in tasks) if (tasks[id]?.short_id === ref) { hit = tasks[id]; break; }
  byRef.set(ref, hit);
  return hit;
};

/** When a card's run shipped although the card itself was taken back: the
 *  day it shipped and the approval it carried. Null for any other run. */
function shippedWithoutCard(run: ReportRun | null | undefined): { at: number; approval: ReturnType<typeof carriedApproval> } | null {
  const end = run ? runEnd(run) : null;
  return run && end?.kind === "shipped" ? { at: end.at, approval: carriedApproval(run) } : null;
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
  // AskingSession subscribes to the session row itself; this page needs only
  // who the viewer is.
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = String(s.currentUser?._id ?? "");
  const answerDecision = useInboxStore((st) => st.answerDecision);
  const reopenDecision = useInboxStore((st) => st.reopenDecision);
  const grant = useMutation(api.sessionDecisions.grant);
  const now = useCoarseNow(30_000);
  // A card's cause task may carry the author's change guide; its evidence row holds it.
  const cardTask = decision.card?.cause.task ?? null;
  useSyncTaskEvidence(cardTask);
  const guide = useTaskEvidenceByShortId(cardTask)?.change_guide ?? null;
  const run = useWorkflowRun(decision.workflow_run_id) as ReportRun | null | undefined;
  const discussion = useDecisionDiscussion(decision._id);
  // The card's cause, as the store holds it, for a doubt its grounding or review raised.
  const causeRow = useInboxStore((st) => (cardTask ? causeByShortId(st.tasks as unknown as Record<string, CauseRow>, cardTask) : null));
  const doubt = causeRow ? causeDoubt(causeRow) : null;
  const [discussOpen, setDiscussOpen] = useState(false);
  const pending = decision.status === "pending";
  const rec = ladderRecommendation(decision);
  // Single, multi and rank answer on the option rows themselves; a form
  // answers on its fields in the footer.
  const answerInOptions = pending && answerable && (decision.kind ?? "single") !== "form";
  // A change card's Ship / Revise / Drop sits in a bar pinned under the
  // question, beside its proof line, so the call is above the fold; the
  // options section below then has nothing left to say.
  // An advisory card's answer stays open (advisoryAnswerOpen): the agent went
  // ahead on its default, so the bar stays up under the outcome to change course.
  const changeCourse = answerable && advisoryAnswerOpen(decision);
  const verdictBar = (answerInOptions || changeCourse) && !!cardAnswerIndexes(decision);
  const chosen = new Set<number>(chosenOptions(decision));

  const adoptDecision = useInboxStore((st) => st.adoptDecision);
  const onAnswer = useCallback((input: DecisionAnswerInput) => {
    adoptDecision(decision._id);
    answerDecision(decision._id, input);
  }, [adoptDecision, answerDecision, decision._id]);
  const onDismiss = useCallback(() => onAnswer({ dismiss: true }), [onAnswer]);
  // The store action flips the row on the draft (the page re-renders as
  // pending at once); the reopenDecision side effect does the server write.
  const onReopen = useCallback(() => {
    reopenDecision(decision._id);
    toast.success("Reopened — it is back in your queue.");
  }, [reopenDecision, decision._id]);

  const holderLine = decision.holder?.kind === "role"
    ? `held by ${detail.holder_role?.name ?? "a role"} under a grant`
    : detail.asked_users.length
      ? `held by ${detail.asked_users.map((u) => u.name).join(", ")}`
      : "held by its people";
  // Answering for somebody else is allowed; the page says so where the
  // answer is given, and the server tells the people who answered for them.
  const heldNote = pending && answerable && answersForOthers(detail, meId) ? (
    <div className="mb-3 flex items-start gap-2 rounded-lg border border-sol-yellow/40 bg-sol-yellow/5 px-3 py-2 text-[12px] text-sol-text-muted">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sol-yellow" />
      <span>
        {holderLine[0].toUpperCase() + holderLine.slice(1)}. You can still answer it; {detail.asked_users.map((u) => u.name).join(", ") || "its people"} will be told you answered for them.
      </span>
    </div>
  ) : null;

  const answeredBy = decision.answered_by;
  const answeredPerson = answeredBy?.kind === "user" ? detail.asked_users.find((u) => u._id === answeredBy.id) : undefined;
  const answeredByLine = !answeredBy
    ? null
    : answeredBy.kind === "policy"
      ? <>answered by policy: stack {detail.stack?.short_id ?? answeredBy.id.replace(/^stack:/, "")} default</>
      : answeredBy.kind === "role"
        ? <>answered by {detail.holder_role?.name ?? detail.ladder.find((h) => h.role_id === answeredBy.id)?.role?.name ?? "a role"} under a grant</>
        : <span className="inline-flex items-center gap-1.5 flex-wrap">answered by <PersonChip userId={answeredBy.id} fallbackName={answeredPerson?.name ?? (answeredBy.id === meId ? "you" : "a person")} fallbackImage={answeredPerson?.avatar_url} />{answeredBy.via && <>through their agent in <EntityIdPill id={answeredBy.via} type="session" compact /></>}</span>;

  // A settled change card says what happened once: the verdict, who gave it
  // and when, as the card's last line.
  const answererName = answererNameOf(detail, meId);
  const outcome = decision.card ? cardOutcome(decision, answererName, now) : null;

  // Reopen is the people's (asked_users): gate on the detail's people set, not
  // on whether the 24 hour queue cache still holds the row.
  const isPerson = detail.asked_users.some((u) => u._id === meId);
  const canReopen = decision.status === "answered" && answeredBy?.kind === "role" && !!decision.grant_id && isPerson && answerable;

  // Who asked, who may answer, who holds it. A change card leads with the
  // change and its proof, so for one these facts follow the card.
  const meta = <DecisionFacts decision={decision} detail={detail} ladder={detail.ladder.length ? <DecisionLadder decision={decision} detail={detail} now={now} /> : undefined} />;

  // A card's attached doc that only restates the card ("What is wrong: ...")
  // is said once, by the card.
  const restated = !!decision.card && restatesCard(detail.doc?.content, decision.card);
  const body = hasDecisionBody(decision, detail) && !restated ? <DecisionBody decision={decision} detail={detail} /> : null;
  // Settled without an answer: the banner at the top says it once.
  const closed = decision.status === "withdrawn" || decision.status === "dismissed";
  // A card taken back on a run that shipped anyway says what shipped and on
  // whose approval, the words the trace's Decide row uses.
  const shippedOn = closed && decision.status === "withdrawn" ? shippedWithoutCard(run) : null;
  const banner = !closed ? null
    : shippedOn ? (
      <>
        Withdrawn: the fix shipped {shortDay(shippedOn.at)} on {earlierApprovalWords(shippedOn.approval)}
        {cardTask && <> (<Link href={lineTraceHref(cardTask)} className="underline decoration-dotted underline-offset-2 hover:text-sol-text" data-banner-trace>see trace</Link>)</>}.
      </>
    )
    : `${decision.status === "withdrawn" ? "Withdrawn by the agent" : "Dismissed without an answer"}${decision.resolved_at ? ` ${settledAgo(decision.resolved_at, now)}` : ""}. Nobody needs to answer it.`;

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
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
        </header>

        {/* The doubt the record raised about the cause, where a reviewer cannot miss it. */}
        {doubt && <DoubtChip doubt={doubt} className="mt-3" />}

        {/* Discuss sits by the status as a real button, saying where it goes. */}
        {(discussion.owner || discussion.thread.length > 0) && (
          <div className="mt-4 flex items-center gap-2.5 flex-wrap" data-decision-discuss>
            <button
              type="button"
              onClick={() => { setDiscussOpen(true); requestAnimationFrame(() => document.getElementById("discuss")?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-sol-border px-2.5 py-1 text-[12.5px] text-sol-text hover:border-sol-cyan/60 hover:text-sol-cyan transition-colors"
              data-decision-discuss-button
            >
              <MessageSquare className="w-3.5 h-3.5" />{discussion.thread.length ? "Reply in the discussion" : "Discuss"}
            </button>
            {discussion.owner && <span className="text-[12px] text-sol-text-dim">Opens a thread with {discussion.owner.name ?? "the session that asked"} about this {decision.card ? "card" : "decision"}.</span>}
          </div>
        )}

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
        {(!pending || !answerInOptions) && (!outcome || canReopen || !!detail.grant_offer) && !(closed && !canReopen && !detail.grant_offer) && <section className="mt-8 decision-footer rounded-xl border border-sol-border/70 bg-sol-card/50 p-4 sm:p-5">
          {pending ? (
            answerable ? (
              <>
                <h2 className="decision-kicker mb-3">Your answer</h2>
                {heldNote}
                <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys recommendation={rec} />
              </>
            ) : (
              <div className="text-sm text-sol-text-dim">{holderLine[0].toUpperCase() + holderLine.slice(1)}. Sign in to answer it.</div>
            )
          ) : (
            <>
              {!outcome && (
                <>
                  <h2 className="decision-kicker mb-2">{decision.status === "answered" ? "The answer" : decision.status === "dismissed" ? "Dismissed without an answer" : "Withdrawn by the agent"}</h2>
                  <DecisionRecordedAnswer decision={decision} />
                  {answeredByLine && <div className="mt-2 text-[12px] text-sol-text-dim">{answeredByLine}</div>}
                </>
              )}
              {canReopen && (
                <button onClick={onReopen} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-sol-orange/40 text-[12px] text-sol-orange hover:bg-sol-orange hover:text-sol-bg transition-colors disabled:opacity-50">
                  <Undo2 className="w-3.5 h-3.5" />Disagree and reopen
                </button>
              )}
              {detail.grant_offer && (
                <GrantOffer offer={detail.grant_offer} decisionId={decision._id} ladder={detail.ladder} grant={grant} />
              )}
            </>
          )}
        </section>}
      </div>
    </div>
  );
}

// "Let this role answer questions like this here" (D2): shown when the
// person picked what a role recommended and the role earned it (3 agreements
// from 2 askers, reported by getWithDoc). Who may grant is the server's rule
// (may_grant: the role's host, the personal scope owner, or an admin of the
// role's team); a role below trust stage "decide" earns the grant but it
// takes effect only once the role is promoted.
function GrantOffer({ offer, decisionId, ladder, grant }: {
  offer: NonNullable<DecisionDetailItem["grant_offer"]>;
  decisionId: string;
  ladder: DecisionDetailItem["ladder"];
  grant: (args: any) => Promise<any>;
}) {
  const hop = ladder.find((h) => h.role_id === offer.role_id);
  const mayGrant = offer.may_grant;
  const { data: brief } = useQueryNoThrow(api.org.brief, { role_id: offer.role_id });
  const trust: string | undefined = brief?.role?.trust;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const onGrant = useCallback(async () => {
    setBusy(true);
    try {
      const r = await grant({ role_id: offer.role_id, category: offer.category, scope_key: offer.scope_key, from_decision_id: decisionId });
      if (r?.error) toast.error(r.error);
      else { setDone(true); toast.success(r?.already_granted ? "Already granted" : `${offer.role_name} now answers ${offer.category} questions here for 30 days`); }
    } catch (e: any) {
      toast.error(e?.message ?? "Could not grant");
    } finally {
      setBusy(false);
    }
  }, [grant, offer, decisionId]);
  const scope = offer.scope_key.split(":")[0];
  return (
    <div className="mt-4 rounded-lg border border-sol-cyan/30 bg-sol-cyan/5 p-3">
      <div className="text-sm text-sol-text">
        You agreed with <span className="text-sol-cyan">{offer.role_name}</span> {offer.agreements} times on {offer.category} questions in this {scope}, from {offer.askers} different sessions.
      </div>
      {!autonomyOn(trust) && (
        <div className="mt-1 text-[12px] text-sol-text-dim">
          Grants take effect once {offer.role_name} starts work on its own.{" "}
          {hop?.role && <Link href={`/org/${hop.role.short_id ?? hop.role._id}`} className="text-sol-blue hover:underline">Open its settings</Link>}
        </div>
      )}
      {done ? (
        <div className="mt-2 text-[12px] text-sol-green">Granted.</div>
      ) : mayGrant ? (
        <button onClick={onGrant} disabled={busy} className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-sol-cyan/50 text-[12px] text-sol-cyan hover:bg-sol-cyan hover:text-sol-bg transition-colors disabled:opacity-50">
          <ShieldCheck className="w-3.5 h-3.5" />Let {offer.role_name} answer {offer.category} questions here
        </button>
      ) : (
        <div className="mt-1 text-[12px] text-sol-text-dim">The role's host or a team admin can grant it.</div>
      )}
    </div>
  );
}
