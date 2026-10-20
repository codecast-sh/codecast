// What an ingest transition hands on, as plain values: the finding a promoted
// group files on the line, and the marker a deploy item records. Pure, so
// ingest.ts stays the writes and the tests read these directly.
import type { Doc, Id } from "../_generated/dataModel";
import type { DeployMarker } from "../deploys";
import { transitionSignalKind, type Transition } from "@codecast/shared/contracts/ingest";
import type { ItemPlan } from "./ingestGroups";
import { sourceFilingScope } from "./ingestScope";

/** The signal a promoted transition files: what the line reads to open or grow a cause. */
export function promotionSignal(
  source: Pick<Doc<"event_sources">, "provider" | "name" | "workspace" | "team_id" | "project_id">,
  group: Pick<Doc<"event_groups">, "short_id" | "kind" | "title" | "culprit" | "count" | "first_seen" | "last_seen" | "last_release">,
  transition: Transition,
  fingerprint: string,
) {
  const kind = transitionSignalKind(transition);
  if (!kind) return null;
  const detail = [
    `${transition.replace(/_/g, " ")} in ${source.provider}:${source.name}, group ${group.short_id} (${group.kind}).`,
    group.culprit ? `Culprit: ${group.culprit}` : null,
    // The reader opens the group itself (its stack and samples) from `subject`: the text names no command.
    `Seen ${group.count} ${group.count === 1 ? "time" : "times"}${group.last_release ? `, last in ${group.last_release}` : ""}.`,
  ].filter(Boolean).join("\n");
  return {
    source: `${source.provider}:${source.name}`,
    kind,
    fingerprint,
    title: group.title,
    detail_md: detail,
    subject: group.short_id,
    observed_at: group.last_seen,
    // Explicit, so the signal lands in the source's workspace whatever the
    // filer's active team is.
    ...sourceFilingScope(source),
    ...(source.project_id ? { project: String(source.project_id) } : {}),
  };
}

/** A source's deploy item as a deploy object's marker (deploys.md DP1). */
export function deployMarkerOf(source: Doc<"event_sources">, d: Extract<ItemPlan, { type: "deploy" }>, eventId: Id<"external_events">): DeployMarker {
  return {
    workspace: source.workspace,
    ...(source.team_id ? { team_id: source.team_id } : {}),
    // A deploy ships the code, not one project: it belongs to the whole workspace, whatever project the source files for.
    target: d.environment ?? "deploy",
    ...(d.sha ? { sha: d.sha } : {}),
    version: d.version,
    source: source.name,
    source_id: source._id,
    event_id: eventId,
    ...(d.url ? { url: d.url } : {}),
    ...(d.previous_sha ? { previous_sha: d.previous_sha } : {}),
    ...(d.commits?.length ? { commits: d.commits } : {}),
    started_by: d.actor ? { kind: "person", name: d.actor } : { kind: "source", name: source.name },
    at: d.at,
  };
}
