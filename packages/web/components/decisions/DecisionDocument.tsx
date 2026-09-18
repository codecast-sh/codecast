"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { ArrowLeft, Check, Layers, ShieldCheck, Undo2, User } from "lucide-react";
import { useInboxStore, useTrackedStore, type SessionDecisionItem, type DecisionDetailItem, type DecisionAnswerInput } from "../../store/inboxStore";
import { useSyncDecisionDetail, useDecisionDetail } from "../../hooks/useSyncDecisionDetail";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { AppLoader } from "../AppLoader";
import { DecisionAnswerControls, DecisionRecordedAnswer } from "./DecisionAnswerControls";
import { DecisionOptionList } from "./DecisionOptionList";
import { AskingSession, CategoryNote, HolderLine, PersonChip } from "./DecisionParties";
import { GateRunChip } from "./DecisionCompactCard";
import { OptionPages } from "./OptionPages";
import { ladderRecommendation } from "../../lib/decisionLinks";
import "./decisions.css";
import { DecisionProposalOrigin } from "../org/ProposalAuthorPill";
import { proposalRefInContext } from "../org/staffingModel";

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
  if (!detail) {
    if (missing && ready) return <Empty text="This decision does not exist, or it is not yours to read." />;
    return <AppLoader />;
  }
  // The store row is the one the viewer may answer; the detail's copy is the
  // server's read for viewers who only have read access.
  const decision: SessionDecisionItem = liveRow ?? detail.decision;
  return <DocumentBody decision={decision} detail={detail} answerable={!!liveRow} />;
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
  const pending = decision.status === "pending";
  const rec = ladderRecommendation(decision);
  // Single, multi and rank answer on the option rows themselves; a form
  // answers on its fields in the footer.
  const answerInOptions = pending && answerable && (decision.kind ?? "single") !== "form";
  const chosen = new Set<number>(
    Array.isArray(decision.answer_json) ? decision.answer_json : decision.answer_index !== undefined ? [decision.answer_index] : [],
  );

  const onAnswer = useCallback((input: DecisionAnswerInput) => answerDecision(decision._id, input), [answerDecision, decision._id]);
  const onDismiss = useCallback(() => answerDecision(decision._id, { dismiss: true }), [answerDecision, decision._id]);
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

  const answeredBy = decision.answered_by;
  const answeredPerson = answeredBy?.kind === "user" ? detail.asked_users.find((u) => u._id === answeredBy.id) : undefined;
  const answeredByLine = !answeredBy
    ? null
    : answeredBy.kind === "policy"
      ? <>answered by policy: stack {detail.stack?.short_id ?? answeredBy.id.replace(/^stack:/, "")} default</>
      : answeredBy.kind === "role"
        ? <>answered by {detail.holder_role?.name ?? detail.ladder.find((h) => h.role_id === answeredBy.id)?.role?.name ?? "a role"} under a grant</>
        : <span className="inline-flex items-center gap-1.5">answered by <PersonChip userId={answeredBy.id} fallbackName={answeredPerson?.name ?? (answeredBy.id === meId ? "you" : "a person")} fallbackImage={answeredPerson?.avatar_url} /></span>;

  // Reopen is the people's (asked_users): gate on the detail's people set, not
  // on whether the 24 hour queue cache still holds the row.
  const isPerson = detail.asked_users.some((u) => u._id === meId);
  const canReopen = decision.status === "answered" && answeredBy?.kind === "role" && !!decision.grant_id && isPerson && answerable;

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Link href="/questions" className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors no-underline">
          <ArrowLeft className="w-3 h-3" /> The queue
        </Link>

        {/* ── Header ── */}
        <header className="mt-4">
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
            <span className="font-mono px-1.5 py-0.5 rounded border border-sol-border/60">{decision.short_id ?? "decision"}</span>
            <span className={`px-1.5 py-0.5 rounded border ${pending ? (decision.blocking ? "border-sol-yellow/40 text-sol-yellow" : "border-sol-blue/30 text-sol-blue") : "border-sol-border text-sol-text-dim"}`}>
              {pending ? (decision.blocking ? "blocking · the session is parked" : "advisory · the agent proceeded") : decision.status}
            </span>
            <span>asked {formatTimeAgo(decision.created_at, now)}</span>
            {decision.resolved_at && <span>· resolved {formatTimeAgo(decision.resolved_at, now)}</span>}
            {/* A gate on the line (the-line.md L4): the run this question pauses. */}
            {decision.workflow_run_id && <GateRunChip runId={decision.workflow_run_id} nodeId={decision.gate_node_id} />}
          </div>
          <h1 className="mt-3 decision-question text-sol-text">{decision.question}</h1>
          <dl className="mt-4 decision-meta text-[12px]">
            <dt>asked by</dt>
            <dd><AskingSession decision={decision} /></dd>
            {proposalRefInContext(decision.context_md) && (
              <>
                <dt>proposal</dt>
                <dd><DecisionProposalOrigin contextMd={decision.context_md} size="md" /></dd>
              </>
            )}
            {(detail.task || decision.task_id) && (
              <>
                <dt>task</dt>
                <dd>
                  <Link href={`/tasks/${detail.task?.short_id ?? decision.task_id}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-violet/30 text-sol-violet hover:bg-sol-violet/10">
                    {detail.task?.short_id ?? "task"}<span className="text-sol-text truncate max-w-[20rem]">{detail.task?.title}</span>
                  </Link>
                  {decision.station && <span className="text-sol-text-dim"> held at <span className="text-sol-text">{decision.station}</span></span>}
                </dd>
              </>
            )}
            <dt title="A category decides who may answer a question like this one">who may answer</dt>
            <dd><CategoryNote category={decision.category} proposed={decision.category_proposed} /></dd>
            {detail.stack && (
              <>
                <dt>stack</dt>
                <dd>
                  <Link href={`/decisions/stacks/${detail.stack.short_id ?? detail.stack._id}`} className="inline-flex items-center gap-1 text-sol-cyan hover:underline">
                    <Layers className="w-3 h-3" />{detail.stack.title}
                  </Link>
                  <span className="text-sol-text-dim"> · {detail.stack.decision_ids.indexOf(decision._id) + 1} of {detail.stack.decision_ids.length}</span>
                </dd>
              </>
            )}
            <dt>holder</dt>
            <dd><HolderLine people={detail.asked_users} roleName={decision.holder?.kind === "role" ? (detail.holder_role?.name ?? "a role") : undefined} /></dd>
          </dl>
        </header>

        {/* ── Body ── */}
        {(detail.doc?.content || decision.context_md || decision.report_slug) && (
          <section className="mt-8">
            {detail.doc?.content && (
              <div className="decision-body text-sol-text-muted"><MarkdownRenderer content={detail.doc.content} /></div>
            )}
            {!detail.doc?.content && decision.context_md && (
              <div className="decision-body text-sol-text-muted border-l-2 border-sol-border pl-4"><MarkdownRenderer content={decision.context_md} /></div>
            )}
            {detail.doc?.content && decision.context_md && (
              <details className="mt-3 text-sm text-sol-text-dim">
                <summary className="cursor-pointer hover:text-sol-text">The short context</summary>
                <div className="mt-2 border-l-2 border-sol-border pl-4"><MarkdownRenderer content={decision.context_md} /></div>
              </details>
            )}
            {decision.report_slug && <div className="mt-4"><PublishedPageEmbed slug={decision.report_slug} /></div>}
          </section>
        )}

        {/* ── Options ── */}
        <section className="mt-8">
          <h2 className="decision-kicker">Options{decision.kind && decision.kind !== "single" ? ` · ${decision.kind === "multi" ? "pick several" : decision.kind === "rank" ? "rank them" : "a form"}` : ""}</h2>
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
              <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys recommendation={rec} />
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
        </section>

        {/* ── Ladder ── */}
        <section className="mt-8">
          <h2 className="decision-kicker">The ladder</h2>
          <ol className="mt-3 decision-ladder">
            {detail.ladder.length === 0 && (
              <li className="text-sm text-sol-text-dim">No roles between the asker and its people. It went straight to {detail.asked_users.map((u) => u.name).join(", ") || "its people"}.</li>
            )}
            {detail.ladder.map((hop, i) => {
              const skipped = hop.note?.startsWith("skipped");
              const holds = decision.holder?.kind === "role" && decision.holder.id === hop.role_id;
              return (
                <li key={i} className={`decision-hop ${skipped ? "opacity-60" : ""}`}>
                  <span className={`decision-hop-dot ${holds ? "bg-sol-green" : hop.recommendation !== undefined ? "bg-sol-cyan" : skipped ? "bg-sol-text-dim" : "bg-sol-yellow"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap text-sm">
                      {hop.role ? (
                        <Link href={`/org/${hop.role.short_id ?? hop.role._id}`} className="text-sol-text hover:text-sol-blue">{hop.role.name}</Link>
                      ) : (
                        <span className="text-sol-text-dim">a retired role</span>
                      )}
                      {holds && <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-sol-green/40 text-sol-green"><ShieldCheck className="w-3 h-3" />holds it</span>}
                      <span className="text-[11px] text-sol-text-dim">{formatTimeAgo(hop.at, now)}</span>
                    </div>
                    <div className="text-[12px] text-sol-text-muted mt-0.5">
                      {hop.recommendation !== undefined
                        ? <>recommends <span className="text-sol-cyan">{decision.options[hop.recommendation]?.label ?? `option ${hop.recommendation + 1}`}</span></>
                        : skipped ? "skipped" : pending && now - hop.at < 5 * 60_000 ? "recommendation pending" : "passed it up without a recommendation"}
                      {hop.note && !skipped && <span className="text-sol-text-dim"> — {hop.note}</span>}
                      {skipped && hop.note && <span className="text-sol-text-dim"> ({hop.note.replace(/^skipped:?\s*/, "")})</span>}
                    </div>
                  </div>
                </li>
              );
            })}
            <li className="decision-hop">
              <span className={`decision-hop-dot ${decision.holder?.kind !== "role" ? "bg-sol-green" : "bg-sol-text-dim"}`} />
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <User className="w-3.5 h-3.5 text-sol-text-dim" />
                <span className="text-sol-text">{detail.asked_users.map((u) => u.name).join(", ") || "its people"}</span>
                {decision.holder?.kind !== "role" && pending && <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-green/40 text-sol-green">holds it</span>}
              </div>
            </li>
          </ol>
        </section>

        {/* ── Answer ── */}
        {(!pending || !answerInOptions) && <section className="mt-8 mb-16 decision-footer rounded-xl border border-sol-border/70 bg-sol-card/50 p-4 sm:p-5">
          {pending ? (
            answerable ? (
              <>
                <h2 className="decision-kicker mb-3">Your answer</h2>
                <DecisionAnswerControls decision={decision} onAnswer={onAnswer} onDismiss={onDismiss} keys recommendation={rec} />
              </>
            ) : (
              <div className="text-sm text-sol-text-dim">{holderLine[0].toUpperCase() + holderLine.slice(1)}. You can read it, not answer it.</div>
            )
          ) : (
            <>
              <h2 className="decision-kicker mb-2">{decision.status === "answered" ? "The answer" : decision.status === "dismissed" ? "Dismissed without an answer" : "Withdrawn by the agent"}</h2>
              <DecisionRecordedAnswer decision={decision} />
              {answeredByLine && <div className="mt-2 text-[12px] text-sol-text-dim">{answeredByLine}</div>}
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
      {trust === "understand" && (
        <div className="mt-1 text-[12px] text-sol-text-dim">
          Grants take effect once {offer.role_name} is at trust <span className="text-sol-text">decide</span>.{" "}
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
