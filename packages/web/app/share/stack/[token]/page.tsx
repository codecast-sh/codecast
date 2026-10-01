"use client";
// /share/stack/<token>: a stack of decisions taken together, each with its
// options and outcome.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { Pill, Section, ShareHead, SharedObjectPage, StatusPill } from "../../SharedObjectPage";
import { DecisionBody, decisionOutcome } from "../../decision/DecisionView";

type Shared = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedStack>>;

export default function SharedStackPage() {
  return (
    <SharedObjectPage<Shared> kind="stack" query={api.publicShare.getSharedStack} noun="decision stack">
      {(stack) => {
        const decided = stack.decisions.filter((d) => d.status === "answered").length;
        return (
          <>
            <ShareHead
              badges={
                <>
                  <StatusPill status={stack.status} />
                  <Pill quiet>{stack.short_id}</Pill>
                </>
              }
              title={stack.title}
              user={stack.user}
              at={stack.created_at}
              meta={<span>{decided} of {stack.decisions.length} decided</span>}
            />
            {stack.decisions.map((d, i) => (
              <Section key={i} title={`${i + 1}. ${d.question}`}>
                {decisionOutcome(d) && (
                  <div className="share-meta" style={{ marginTop: 0, marginBottom: 14 }}>
                    <Pill tone="green">Decided</Pill>
                    <strong>{decisionOutcome(d)}</strong>
                  </div>
                )}
                <DecisionBody d={d} />
              </Section>
            ))}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
