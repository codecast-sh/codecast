"use client";
// /share/plan/<token>: a plan's goal, criteria, progress, body and tasks.
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { Bullets, Callout, Pill, Prose, Row, Rows, Section, ShareHead, SharedObjectPage, StatusPill, humanize, statusTone } from "../../SharedObjectPage";

export default function SharedPlanClient() {
  return (
    <SharedObjectPage<any> kind="plan" query={(api as any).plans.getShared} noun="plan">
      {(plan) => {
        const progress = plan.progress;
        const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
        return (
          <>
            <ShareHead
              badges={
                <>
                  <StatusPill status={plan.status} />
                  {plan.short_id && <Pill quiet>{plan.short_id}</Pill>}
                </>
              }
              title={plan.title}
              user={plan.user}
              at={plan.created_at}
              meta={pct !== null ? <span>{progress.done} of {progress.total} tasks done</span> : null}
            />
            {plan.goal && <Callout label="Goal">{plan.goal}</Callout>}
            {pct !== null && (
              <div style={{ margin: "-12px 0 36px", height: 6, borderRadius: 99, background: "var(--rule)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, #859900, #2aa198)" }} />
              </div>
            )}
            {plan.acceptance_criteria?.length > 0 && (
              <Section title="Done when">
                <Bullets items={plan.acceptance_criteria} tone="green" />
              </Section>
            )}
            {plan.doc_content && (
              <Section title="The plan">
                <Prose content={plan.doc_content} />
              </Section>
            )}
            {plan.tasks?.length > 0 && (
              <Section title="Tasks" count={plan.tasks.length}>
                <Rows>
                  {plan.tasks.map((t: any) => (
                    <Row key={t._id} lead="●" tone={statusTone(t.status)} trail={t.short_id}>
                      {t.title}
                    </Row>
                  ))}
                </Rows>
              </Section>
            )}
            {plan.comments?.length > 0 && (
              <Section title="Timeline" count={plan.comments.length}>
                <Rows>
                  {plan.comments.map((e: any, i: number) => (
                    <Row
                      key={i}
                      trail={<span title={formatDateFull(e.timestamp)}>{formatDateSmart(e.timestamp)}</span>}
                      note={e.rationale ? `${humanize(e.type)}: ${e.rationale}` : humanize(e.type)}
                    >
                      {e.content}
                    </Row>
                  ))}
                </Rows>
              </Section>
            )}
          </>
        );
      }}
    </SharedObjectPage>
  );
}
