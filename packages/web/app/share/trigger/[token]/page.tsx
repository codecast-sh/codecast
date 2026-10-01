"use client";
// /share/trigger/<token>: a standing instruction to an agent: what it is
// told, when it fires, and how its last run went.
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { fmtDuration, triggerEventLabel } from "../../../../components/triggerCadence";
import { Callout, Pill, Prose, Section, ShareHead, SharedObjectPage, StatusPill } from "../../SharedObjectPage";

type Shared = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedTrigger>>;

function cadence(t: Shared): string {
  if (t.schedule_type === "event") return `on ${triggerEventLabel(t.event ?? undefined)}`;
  if (t.schedule_type === "recurring" && t.interval_ms) return `every ${fmtDuration(t.interval_ms)}`;
  return t.run_at ? `once, ${formatDateFull(t.run_at)}` : "once";
}

export default function SharedTriggerPage() {
  return (
    <SharedObjectPage<Shared> kind="trigger" query={api.publicShare.getSharedTrigger} noun="trigger">
      {(t) => (
        <>
          <ShareHead
            badges={
              <>
                <StatusPill status={t.status} />
                <Pill tone="orange">{cadence(t)}</Pill>
                {t.short_id && <Pill quiet>{t.short_id}</Pill>}
              </>
            }
            title={t.title}
            user={t.user}
            at={t.created_at}
            meta={<span>{t.run_count} run{t.run_count === 1 ? "" : "s"}</span>}
          />
          {t.summary && <Callout label="What it does">{t.summary}</Callout>}
          <Section title="Instructions">
            <Prose content={t.prompt} compact />
          </Section>
          {t.last_run_summary && (
            <Section title="Last run">
              <div className="share-meta" style={{ marginTop: 0, marginBottom: 10 }}>
                <Pill tone={t.last_run_failed ? "red" : "green"}>{t.last_run_failed ? "Failed" : "Completed"}</Pill>
                {t.last_run_at && <span title={formatDateFull(t.last_run_at)}>{formatDateSmart(t.last_run_at)}</span>}
              </div>
              <Prose content={t.last_run_summary} compact />
            </Section>
          )}
        </>
      )}
    </SharedObjectPage>
  );
}
