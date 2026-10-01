"use client";
// /share/decision/<token>: one question someone had to decide, its options,
// and what they chose.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { Pill, ShareHead, SharedObjectPage, StatusPill } from "../../SharedObjectPage";
import { DecisionBody } from "../DecisionView";

type Shared = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedDecision>>;

export default function SharedDecisionPage() {
  return (
    <SharedObjectPage<Shared> kind="decision" query={api.publicShare.getSharedDecision} noun="decision">
      {(d) => (
        <>
          <ShareHead
            badges={
              <>
                <StatusPill status={d.status === "pending" ? "open" : d.status} />
                {d.category && <Pill quiet>{d.category}</Pill>}
                {d.short_id && <Pill quiet>{d.short_id}</Pill>}
              </>
            }
            title={d.question}
            user={d.user}
            at={d.created_at}
            meta={d.resolved_at ? <span title={formatDateFull(d.resolved_at)}>decided {formatDateSmart(d.resolved_at)}</span> : null}
          />
          <DecisionBody d={d} />
        </>
      )}
    </SharedObjectPage>
  );
}
