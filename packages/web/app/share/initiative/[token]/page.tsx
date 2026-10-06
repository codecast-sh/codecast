"use client";
// /share/initiative/<token>: a goal, how it is going, the projects that carry
// it and the updates its owner wrote.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { fmtDay, Pill, Prose, Row, Rows, Section, ShareHead, SharedObjectPage, StatusPill, humanize, statusTone } from "../../SharedObjectPage";

type SharedInitiative = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedInitiative>>;

export default function SharedInitiativePage() {
  return (
    <SharedObjectPage<SharedInitiative> kind="initiative" query={api.publicShare.getSharedInitiative} noun="goal">
      {(ini) => (
        <>
          <ShareHead
            badges={
              <>
                <StatusPill status={ini.status} />
                {ini.health !== "none" && <Pill tone={statusTone(ini.health)}>{humanize(ini.health)}</Pill>}
                {ini.priority && <Pill tone="orange">{ini.priority.toUpperCase()}</Pill>}
                <Pill quiet>{ini.short_id}</Pill>
              </>
            }
            title={ini.title}
            user={ini.user}
            at={ini.created_at}
            meta={
              <>
                {ini.owner && <span>driven by <strong>{ini.owner}</strong></span>}
                {ini.target_date && <span>target {fmtDay(ini.target_date)}</span>}
              </>
            }
          />
          {ini.description && (
            <Section title="Why">
              <Prose content={ini.description} />
            </Section>
          )}
          {ini.projects.length > 0 && (
            <Section title="Projects" count={ini.projects.length}>
              <Rows>
                {ini.projects.map((p, i) => (
                  <Row key={i} lead="◆" tone={statusTone(p.status)} trail={humanize(p.status)} note={p.description ?? undefined}>
                    {p.title}
                  </Row>
                ))}
              </Rows>
            </Section>
          )}
          {ini.updates.length > 0 && (
            <Section title="Updates" count={ini.updates.length}>
              <div style={{ display: "grid", gap: 28 }}>
                {ini.updates.map((u, i) => (
                  <div key={i}>
                    <div className="share-meta" style={{ marginTop: 0, marginBottom: 8 }}>
                      <Pill tone={statusTone(u.health)}>{humanize(u.health)}</Pill>
                      {u.by && <strong>{u.by}</strong>}
                      <span title={formatDateFull(u.at)}>{formatDateSmart(u.at)}</span>
                    </div>
                    <Prose content={u.body} compact />
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </SharedObjectPage>
  );
}
