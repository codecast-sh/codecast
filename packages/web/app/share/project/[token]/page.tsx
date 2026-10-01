"use client";
// /share/project/<token>: a project's charter and the work filed under it.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull } from "@codecast/shared/time";
import { Bullets, Callout, Pill, Prose, Row, Rows, Section, ShareHead, SharedObjectPage, StatusPill, statusTone } from "../../SharedObjectPage";

type SharedProject = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedProject>>;

export default function SharedProjectPage() {
  return (
    <SharedObjectPage<SharedProject> kind="project" query={api.publicShare.getSharedProject} noun="project">
      {(p) => {
        const done = p.tasks.filter((t) => t.status === "done").length;
        return (
          <>
            <ShareHead
              badges={
                <>
                  <StatusPill status={p.status} />
                  {p.priority && <Pill tone="orange">{p.priority.toUpperCase()}</Pill>}
                  {p.short_id && <Pill quiet>{p.short_id}</Pill>}
                  {p.labels.map((l) => (
                    <Pill key={l} quiet>
                      {l}
                    </Pill>
                  ))}
                </>
              }
              title={p.title}
              user={p.user}
              at={p.created_at}
              meta={
                <>
                  {p.tasks.length > 0 && <span>{done} of {p.tasks.length} tasks done</span>}
                  {p.target_date && <span>due {formatDateFull(p.target_date)}</span>}
                </>
              }
            />
            {p.goal && <Callout label="Goal">{p.goal}</Callout>}
            {p.description && (
              <Section title="About">
                <Prose content={p.description} />
              </Section>
            )}
            {p.success_metrics.length > 0 && (
              <Section title="Success looks like">
                <Bullets items={p.success_metrics} tone="green" />
              </Section>
            )}
            {p.non_goals.length > 0 && (
              <Section title="Not doing">
                <Bullets items={p.non_goals} tone="muted" />
              </Section>
            )}
            {p.risks.length > 0 && (
              <Section title="Risks">
                <Bullets items={p.risks} tone="red" />
              </Section>
            )}
            {p.plans.length > 0 && (
              <Section title="Plans" count={p.plans.length}>
                <Rows>
                  {p.plans.map((pl) => (
                    <Row key={pl.short_id} lead="◆" tone={statusTone(pl.status)} trail={pl.short_id}>
                      {pl.title}
                    </Row>
                  ))}
                </Rows>
              </Section>
            )}
            {p.tasks.length > 0 && (
              <Section title="Tasks" count={p.tasks.length}>
                <Rows>
                  {p.tasks.map((t) => (
                    <Row key={t.short_id} lead="●" tone={statusTone(t.status)} trail={t.short_id}>
                      {t.title}
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
