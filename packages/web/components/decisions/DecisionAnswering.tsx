"use client";
// How a decision is answered wherever its whole page shows: the decision page
// (DecisionDocument) and the line's fix decision (LineDecision) both read the
// same state from useDecisionAnswering and draw the same answer section, so an
// answer, a reopen, a grant or a closed banner reads one way on both.
import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AlertTriangle, ShieldCheck, Undo2 } from "lucide-react";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { advisoryAnswerOpen } from "@codecast/shared/contracts";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { answersForOthers, mayAnswerFromDocument, useInboxStore, useTrackedStore, type SessionDecisionItem, type DecisionDetailItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useDecisionDetail, useSyncDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useWorkflowRun } from "../../hooks/useSyncWorkflows";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { approvalScope, closedDecisionWords, type ReportRun } from "../../lib/line/runReport";
import { lineRefHref } from "../../lib/line/lineWorkspaceUrl";
import { causeDoubt } from "../../lib/line/lineTrace";
import { chosenOptions, ladderRecommendation } from "../../lib/decisionLinks";
import { EntityIdPill } from "../EntityIdPill";
import { Button } from "../ui/button";
import { AskAgain } from "../line/AskAgain";
import { DecisionAnswerControls, DecisionRecordedAnswer } from "./DecisionAnswerControls";
import { PersonChip } from "./DecisionParties";
import { SupersededNote } from "../SupersededNote";
import { answererNameOf, cardAnswerIndexes, cardOutcome, settledAgo } from "./ChangeCardView";

const api = _api as any;

type CauseRow = Parameters<typeof causeDoubt>[0] & { short_id?: string; _id?: string; status?: string; project_id?: string; workflow_run_id?: string };
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

/**
 * One decision's whole page, from the store: the live row from sessionDecisions
 * (optimistic answers land there first) and the page context from
 * decisionDetails, which useSyncDecisionDetail feeds from getWithDoc. `id` is a
 * short id ("sd-N") or a Convex id.
 */
export function useDecisionPage(id: string | undefined) {
  const { ready, missing, error } = useSyncDecisionDetail(id);
  const detail = useDecisionDetail(id);
  // The store holds the row before the page's context arrives (the queue, or the team's line decisions): the decision
  // paints from it at once, and the context (its doc, task, ladder) fills in when getWithDoc answers.
  const liveRow = useInboxStore((s) => s.sessionDecisions[detail?._id ?? id ?? ""] as SessionDecisionItem | undefined);
  const meId = useInboxStore((s) => String(s.currentUser?._id ?? ""));
  // The store row is the queue's or the team's; the detail's copy is the server's read.
  // Any signed-in reader answers either way: a role on the ladder that heard
  // it first, or a decision asked of somebody else, keeps it out of their
  // queue, not out of their hands (onAnswer adopts the detail's copy first).
  const decision: SessionDecisionItem | null = liveRow ?? detail?.decision ?? null;
  const shown = useMemo(() => detail ?? (liveRow ? rowOnlyDetail(liveRow) : null), [detail, liveRow]);
  return { ready, missing, error: error ?? null, detail: shown, decision, answerable: !!liveRow || (!!detail && mayAnswerFromDocument(detail, meId)) };
}

/** A decision's page before its context arrives: the row alone, nothing yet known around it. */
function rowOnlyDetail(row: SessionDecisionItem): DecisionDetailItem {
  return { _id: row._id, decision: row, doc: null, task: null, stack: null, ladder: [], asked_users: [], holder_role: null, grant_offer: null, grant: null };
}

export type DecisionAnswering = ReturnType<typeof useDecisionAnswering>;

/** Everything a full decision surface derives to answer it: the answer actions, who holds it, its outcome and banner. */
/** `trial`: the decision is a trial run's, where the surface knows it beyond the row's own flag (an older row in a trial project). */
/** `act`: false when the host itself carries what to do next (the problem page's new run): a settled decision's banner then
 *  says only its state and when, with no sentence or link of its own. */
export function useDecisionAnswering(decision: SessionDecisionItem, detail: DecisionDetailItem, answerable: boolean, trial = !!decision.trial, act = true) {
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = String(s.currentUser?._id ?? "");
  const answerDecision = useInboxStore((st) => st.answerDecision);
  const reopenDecision = useInboxStore((st) => st.reopenDecision);
  const adoptDecision = useInboxStore((st) => st.adoptDecision);
  const now = useCoarseNow(30_000);
  const run = useWorkflowRun(decision.workflow_run_id) as ReportRun | null | undefined;
  // A card's cause, as the store holds it, for a doubt its grounding or review raised.
  const cardTask = decision.card?.cause.task ?? null;
  const causeRow = useInboxStore((st) => (cardTask ? causeByShortId(st.tasks as unknown as Record<string, CauseRow>, cardTask) : null));
  const doubt = causeRow ? causeDoubt(causeRow) : null;

  // A decision a newer state of its line replaced waits on nobody: it reads as replaced, with no answers to press.
  const pending = decision.status === "pending" && !detail.superseded;
  const rec = ladderRecommendation(decision);
  // Single, multi and rank answer on the option rows themselves; a form answers on its fields in the footer.
  const answerInOptions = pending && answerable && (decision.kind ?? "single") !== "form";
  // An advisory card's answer stays open (advisoryAnswerOpen): the agent went
  // ahead on its default, so the bar stays up under the outcome to change course.
  const changeCourse = answerable && advisoryAnswerOpen(decision);
  const verdictBar = (answerInOptions || changeCourse) && !!cardAnswerIndexes(decision);
  const chosen = new Set<number>(chosenOptions(decision));

  const onAnswer = useCallback((input: DecisionAnswerInput) => {
    adoptDecision(decision._id);
    answerDecision(decision._id, input);
  }, [adoptDecision, answerDecision, decision._id]);
  const onDismiss = useCallback(() => onAnswer({ dismiss: true }), [onAnswer]);
  // The store action flips the row on the draft (the page re-renders as
  // pending at once); the reopenDecision side effect does the server write.
  const onReopen = useCallback(() => {
    reopenDecision(decision._id);
    toast.success("Reopened, back in your queue.");
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

  // A settled change card says what happened once: the verdict, who gave it and when, as the card's last line.
  const answererName = answererNameOf(detail, meId);
  // An approval names what it covered: a proposal's approval approved building the fix, never a ship.
  // A trial answer approved nothing: it has no scope to name.
  const scope = decision.status === "answered" && !trial ? approvalScope(decision.gate_node_id, decision.options?.[chosenOptions(decision)[0] ?? -1]?.label) : null;
  const outcome = decision.card ? cardOutcome(decision, answererName, now, trial) : null;

  // Reopen is the people's (asked_users): gate on the detail's people set, not
  // on whether the 24 hour queue cache still holds the row.
  const isPerson = detail.asked_users.some((u) => u._id === meId);
  const canReopen = decision.status === "answered" && answeredBy?.kind === "role" && !!decision.grant_id && isPerson && answerable;

  // Settled without an answer: the banner names what happened in plain words,
  // then what it means for the work (runReport closedDecisionWords).
  const closed = decision.status === "withdrawn" || decision.status === "dismissed";
  const closedWords = closed ? closedDecisionWords(decision.status as "withdrawn" | "dismissed", run) : null;
  // A card whose run went on without it can be asked again while it is still the cause's newest run.
  const cause = causeRow;
  const askAgain = !!closedWords?.askAgain && !!cause?._id && (cause.status === "open" || cause.status === "backlog") && (!cause.workflow_run_id || cause.workflow_run_id === decision.workflow_run_id);
  const banner: ReactNode = decision.status === "pending" && detail.superseded ? <SupersededNote superseded={detail.superseded} /> : closedWords && !act ? (
    <b className="font-semibold text-sol-text" data-banner-state>{closedWords.headline.split(":")[0]}{decision.resolved_at ? ` · ${settledAgo(decision.resolved_at, now)}` : ""}</b>
  ) : closedWords ? (
    <>
      <b className="font-semibold text-sol-text">{closedWords.headline}{!closedWords.askAgain && decision.resolved_at ? ` ${settledAgo(decision.resolved_at, now)}` : ""}.</b>{" "}
      {closedWords.detail}
      {cardTask && closedWords.askAgain && <> <Link href={lineRefHref(cardTask)} className="underline decoration-dotted underline-offset-2 hover:text-sol-text" data-banner-trace>See its timeline</Link>.</>}
      {askAgain && <div className="mt-2"><AskAgain taskId={cause!._id!} projectId={cause!.project_id ?? null} /></div>}
    </>
  ) : null;

  // The answer section shows unless the answer already sits on the options or the card's outcome line says it all.
  const answerSection = (!pending || !answerInOptions) && (!outcome || canReopen || !!detail.grant_offer) && !(closed && !canReopen && !detail.grant_offer);

  return {
    meId, now, run, cardTask, doubt, pending, rec, answerInOptions, verdictBar, chosen, onAnswer, onDismiss, onReopen,
    holderLine, heldNote, answeredByLine, scope, outcome, canReopen, closed, closedWords, banner, answerSection,
  };
}

/** The answer section: the controls while it waits, else the answer on record, a reopen and a grant offer. */
export function DecisionAnswerPanel({ decision, detail, answerable, a, keys = true, keyScope }: { decision: SessionDecisionItem; detail: DecisionDetailItem; answerable: boolean; a: DecisionAnswering; keys?: boolean; keyScope?: RefObject<HTMLElement | null> }) {
  const grant = useMutation(api.sessionDecisions.grant);
  if (a.pending) {
    return answerable ? (
      <>
        <h2 className="decision-kicker mb-3">Your answer</h2>
        {a.heldNote}
        <DecisionAnswerControls decision={decision} onAnswer={a.onAnswer} onDismiss={a.onDismiss} keys={keys} keyScope={keyScope} recommendation={a.rec} />
      </>
    ) : (
      <div className="text-sm text-sol-text-dim">{a.holderLine[0].toUpperCase() + a.holderLine.slice(1)}. Sign in to answer it.</div>
    );
  }
  return (
    <>
      {!a.outcome && (
        <>
          <h2 className="decision-kicker mb-2">{decision.status === "answered" ? "The answer" : a.closedWords?.headline ?? "Closed without an answer"}</h2>
          <DecisionRecordedAnswer decision={decision} />
          {a.scope && <div className="mt-2 text-[12.5px] text-sol-text-muted" data-decision-approval-scope>{a.scope}{decision.gate_node_id !== CARD_GATE_NODE_ID ? ", not shipping it. Shipping asks again on its own card." : "."}</div>}
          {a.answeredByLine && <div className="mt-2 text-[12px] text-sol-text-dim">{a.answeredByLine}</div>}
        </>
      )}
      {a.canReopen && (
        <Button variant="outline" size="xs" onClick={a.onReopen} className="mt-3">
          <Undo2 />Disagree and reopen
        </Button>
      )}
      {detail.grant_offer && (
        <GrantOffer offer={detail.grant_offer} decisionId={decision._id} ladder={detail.ladder} grant={grant} />
      )}
    </>
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
        <Button variant="cyan" size="xs" onClick={onGrant} disabled={busy} className="mt-2">
          <ShieldCheck />Let {offer.role_name} answer {offer.category} questions here
        </Button>
      ) : (
        <div className="mt-1 text-[12px] text-sol-text-dim">The role's host or a team admin can grant it.</div>
      )}
    </div>
  );
}

/** Whether a card's attached doc only says the card's own fields again (the
 *  line's decide step writes "What is wrong: ... What this changes: ..."). */
export function restatesCard(doc: string | undefined, card: { wrong?: string; change?: string }): boolean {
  const flat = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const d = flat(doc);
  const wrong = flat(card.wrong).slice(0, 80);
  const change = flat(card.change).slice(0, 80);
  return !!d && ((!!wrong && d.includes(wrong)) || (!!change && d.includes(change)));
}
