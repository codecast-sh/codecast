// Deploy markers from a source's batches (ingest.applyBatch): the dedupe key a
// deploy is recorded under, the sha a release was deployed from, and the
// marker with its triggers, once per version and environment.
import type { Doc, Id } from "./_generated/dataModel";
import { scheduleTriggerMatch } from "./lib/triggerMatch";
import { capForeignText, inlineForeignText } from "@codecast/shared/contracts";
import { recordExternalEventOnce } from "./externalEvents";
import { recordDeployMarker } from "./deploys";
import { takeFromWindow } from "./ipRateLimit";
import { SOURCE_CAPS } from "./lib/groupWrite";
import { deployMarkerOf } from "./lib/ingestPayloads";
import { HOUR_MS, type ItemPlan } from "./lib/ingestGroups";

function deployKey(sourceId: Id<"event_sources">, version: string, environment: string | undefined): string {
  return `ingest:${sourceId}:deploy:${version}:${environment ?? ""}`;
}

async function eventByDedupeKey(ctx: any, key: string): Promise<Doc<"external_events"> | null> {
  return await ctx.db.query("external_events").withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", key)).first();
}

/**
 * The sha the envelope's release was deployed from: a deploy item in this
 * batch, else the deploy marker already recorded for that release.
 */
export async function releaseSha(ctx: any, sourceId: Id<"event_sources">, envelope: { release?: string; environment?: string }, deploys: Extract<ItemPlan, { type: "deploy" }>[]): Promise<string | undefined> {
  if (!envelope.release) return undefined;
  const inBatch = deploys.find((d) => d.version === envelope.release && d.sha && (d.environment ?? "") === (envelope.environment ?? ""));
  if (inBatch) return inBatch.sha;
  return (await eventByDedupeKey(ctx, deployKey(sourceId, envelope.release, envelope.environment)))?.sha ?? undefined;
}

/**
 * The deploy's name as an armed trigger's run reads it. Whoever holds the
 * source's key writes the version and environment, and a browser key is public,
 * so the run gets them as identifiers: one line each, capped to what a release
 * name needs. The run reads the deploy itself through the fenced event view.
 */
const DEPLOY_TRIGGER_FIELD_CHARS = 64;
export function deployTriggerTitle(d: { version: string; environment?: string }): string {
  const field = (value: string) => capForeignText(inlineForeignText(value), DEPLOY_TRIGGER_FIELD_CHARS);
  return `Deployed ${field(d.version)}${d.environment ? ` to ${field(d.environment)}` : ""}`;
}

/**
 * A deploy marker and its triggers, once per version and environment: a
 * retried batch or an SDK that reports its version at every boot records and
 * fires nothing again. New markers past SOURCE_CAPS.deploys_per_hour are
 * skipped. Whether this call recorded one.
 */
export async function announceDeploy(ctx: any, source: Doc<"event_sources">, d: Extract<ItemPlan, { type: "deploy" }>): Promise<boolean> {
  const key = deployKey(source._id, d.version, d.environment);
  const seen = await eventByDedupeKey(ctx, key);
  if (seen) {
    // A second report of the same version (the deploy path's own, after an
    // api's boot announced it) adds what it knows: the run, the commit range.
    if (d.url || d.commits?.length || d.previous_sha) await recordDeployMarker(ctx, deployMarkerOf(source, d, seen._id));
    return false;
  }
  const { granted } = await takeFromWindow(ctx.db, `ingest-deploys:${source._id}`, SOURCE_CAPS.deploys_per_hour, HOUR_MS, 1);
  if (!granted) return false;
  const title = `Deployed ${d.version}${d.environment ? ` to ${d.environment}` : ""}`;
  const { id: eventId } = await recordExternalEventOnce(ctx, {
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.provider,
    kind: "deploy",
    title,
    sha: d.sha,
    source_id: source._id,
    data: { transition: "deploy", source_name: source.name, provider: source.provider, release: d.version, environment: d.environment },
    dedupe_key: key,
    created_at: d.at,
  });
  await recordDeployMarker(ctx, deployMarkerOf(source, d, eventId));
  await scheduleTriggerMatch(ctx, {
    event_type: "deploy",
    team_id: source.team_id,
    workspace: source.workspace,
    source: source.name,
    event_ref: { external_event_id: eventId, title: deployTriggerTitle(d) },
  });
  return true;
}
