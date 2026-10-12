"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";
import { Layers, ShieldCheck, User } from "lucide-react";
import type { SessionDecisionItem, DecisionDetailItem } from "../../store/inboxStore";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { PublishedPageEmbed } from "../PublishedPageEmbed";
import { AskingSession, CategoryNote, HolderLine } from "./DecisionParties";
import { DecisionProposalOrigin } from "../org/ProposalAuthorPill";
import { proposalRefInContext } from "../org/staffingModel";

// A decision reads the same wherever it is answered: the queue's sheet
// (SessionDecisionCard) and the decision page (DecisionDocument) both draw
// these sections from the getWithDoc detail, so neither one holds something
// the other has to link out to.

/** Who must answer, in one plain line ("Waiting on Jason Benn (a person must
 *  answer)"), then everything else behind Details: who asked, the task, the
 *  rule for who may answer, its stack, its holder, and `ladder` when the
 *  question climbed through roles. A newcomer reads the line; the rest is for
 *  whoever needs the provenance. */
export function DecisionFacts({ decision, detail, className = "mt-4", ladder }: { decision: SessionDecisionItem; detail: DecisionDetailItem; className?: string; ladder?: ReactNode }) {
  const people = detail.asked_users.map((u) => u.name).join(", ") || "its people";
  const role = decision.holder?.kind === "role" ? (detail.holder_role?.name ?? "a role") : null;
  const personOnly = isHumanOnlyCategory(decision.category);
  const who = decision.status === "pending"
    ? role ? `Waiting on ${role}, answering for ${people}` : `Waiting on ${people}${personOnly ? " (a person must answer)" : ""}`
    : `Asked of ${people}`;
  return (
    <div className={`${className} decision-facts text-[12px]`} data-decision-facts>
      <p className="decision-facts-line text-sol-text-muted" data-decision-who>
        {who}
        <span className="text-sol-text-dim"> · asked by </span><AskingSession decision={decision} />
      </p>
      <details className="decision-details mt-1.5" data-decision-details>
        <summary className="cursor-pointer text-sol-text-dim hover:text-sol-text w-fit">Details</summary>
        <dl className="mt-2 decision-meta">
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
                <Link href={`/tasks/${detail.task?.short_id ?? decision.task_id}`} className="inline-flex items-center gap-1 max-w-full min-w-0 align-bottom px-1.5 py-0.5 rounded border border-sol-violet/30 text-sol-violet hover:bg-sol-violet/10 [overflow-wrap:normal]">
                  <span className="whitespace-nowrap shrink-0">{detail.task?.short_id ?? "task"}</span><span className="text-sol-text truncate min-w-0 max-w-[20rem]">{detail.task?.title}</span>
                </Link>
                {decision.station && <span className="text-sol-text-dim"> asked while the task was <span className="text-sol-text">{decision.station.replace(/_/g, " ")}</span></span>}
              </dd>
            </>
          )}
          <dt title="A category decides who may answer a question like this one">who may answer</dt>
          <dd><CategoryNote category={decision.category} proposed={decision.category_proposed} /></dd>
          {detail.stack && (
            <>
              <dt>part of</dt>
              <dd>
                <Link href={`/decisions/stacks/${detail.stack.short_id ?? detail.stack._id}`} className="inline-flex items-center gap-1 text-sol-cyan hover:underline">
                  <Layers className="w-3 h-3" />{detail.stack.title}
                </Link>
                <span className="text-sol-text-dim"> · {detail.stack.decision_ids.indexOf(decision._id) + 1} of {detail.stack.decision_ids.length}</span>
              </dd>
            </>
          )}
          <dt>holder</dt>
          <dd><HolderLine people={detail.asked_users} roleName={role ?? undefined} /></dd>
        </dl>
        {ladder && <div className="mt-3"><div className="decision-kicker">How it reached them</div>{ladder}</div>}
      </details>
    </div>
  );
}

/** Whether the decision carries anything for DecisionBody to draw. */
export function hasDecisionBody(decision: SessionDecisionItem, detail: DecisionDetailItem): boolean {
  return !!(detail.doc?.content || decision.context_md || (decision.report_slug && !decision.card));
}

/** The attached document, the short context and the report. */
export function DecisionBody({ decision, detail }: { decision: SessionDecisionItem; detail: DecisionDetailItem }) {
  const doc = detail.doc?.content;
  if (!hasDecisionBody(decision, detail)) return null;
  return (
    <>
      {doc && (
        <div className="decision-body text-sol-text-muted" data-decision-doc><MarkdownRenderer content={doc} /></div>
      )}
      {!doc && decision.context_md && (
        <div className="decision-body text-sol-text-muted border-l-2 border-sol-border pl-4" data-decision-context><MarkdownRenderer content={decision.context_md} /></div>
      )}
      {doc && decision.context_md && (
        <details className="mt-3 text-sm text-sol-text-dim">
          <summary className="cursor-pointer hover:text-sol-text">The short context</summary>
          <div className="mt-2 border-l-2 border-sol-border pl-4" data-decision-context><MarkdownRenderer content={decision.context_md} /></div>
        </details>
      )}
      {decision.report_slug && !decision.card && <div className="mt-4"><PublishedPageEmbed slug={decision.report_slug} /></div>}
    </>
  );
}

/** The roles the question climbed through on its way to its people. */
export function DecisionLadder({ decision, detail, now }: { decision: SessionDecisionItem; detail: DecisionDetailItem; now: number }) {
  const pending = decision.status === "pending";
  return (
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
                  : skipped ? "skipped" : hop.passed_at ? "passed it up" : pending && now - hop.at < 5 * 60_000 ? "recommendation pending" : "passed it up without a recommendation"}
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
  );
}
