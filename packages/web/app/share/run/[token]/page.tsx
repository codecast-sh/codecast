"use client";
// /share/run/<token>: a workflow run: its goal, its phases and every agent
// step with how it ended.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { fmtDuration } from "../../../../components/triggerCadence";
import { Callout, Pill, Row, Rows, Section, ShareHead, SharedObjectPage, StatusPill, humanize, statusTone } from "../../SharedObjectPage";

type Shared = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedRun>>;

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export default function SharedRunPage() {
  return (
    <SharedObjectPage<Shared> kind="run" query={api.publicShare.getSharedRun} noun="workflow run">
      {(run) => {
        // Steps grouped under their phase, in the order phases first appear.
        const groups = new Map<string, Shared["nodes"]>();
        for (const n of run.nodes) {
          const key = n.phase ?? "";
          groups.set(key, [...(groups.get(key) ?? []), n]);
        }
        const done = run.nodes.filter((n) => n.status === "completed").length;
        return (
          <>
            <ShareHead
              badges={
                <>
                  <StatusPill status={run.status} />
                  <Pill quiet>{humanize(run.kind)}</Pill>
                </>
              }
              title={run.name}
              user={run.user}
              at={run.created_at}
              meta={
                <>
                  <span>{done} of {run.nodes.length} steps done</span>
                  {run.agent_count != null && <span>{run.agent_count} agents</span>}
                  {run.total_tokens != null && <span>{fmtTokens(run.total_tokens)} tokens</span>}
                  <span>{fmtDuration(Math.max(1000, run.updated_at - run.created_at))}</span>
                </>
              }
            />
            {run.goal && <Callout label="Goal">{run.goal}</Callout>}
            {run.fail_reason && <Callout label="Why it stopped" tone="red">{run.fail_reason}</Callout>}
            {[...groups.entries()].map(([phase, nodes]) => (
              <Section key={phase || "steps"} title={phase || "Steps"} count={nodes.length}>
                <Rows>
                  {nodes.map((n, i) => (
                    <Row
                      key={i}
                      lead="●"
                      tone={statusTone(n.status)}
                      trail={n.started_at && n.completed_at ? fmtDuration(Math.max(1000, n.completed_at - n.started_at)) : humanize(n.status)}
                      note={n.outcome ?? undefined}
                    >
                      {n.label}
                    </Row>
                  ))}
                </Rows>
              </Section>
            ))}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
