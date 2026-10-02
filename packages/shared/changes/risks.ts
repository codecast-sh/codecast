// Risk signals (docs/proposals/changes-page.md 7.1 step 8). Code decides every
// risk and its evidence; the prose call only words them.
import { areaOf, isRevert } from "./classify";
import { surfaceCoversArea } from "./surfaces";
import type { ChangeCommit, Risk, ShipEvent, VisibleConversation } from "./types";

/** Changed lines above which a story with no PR, no visible session and no task is flagged. */
export const BULK_LINES = 1500;

/** A commit in a story, whole (`area: null`) or as one area's slice of a batch commit. */
export type RiskUnit = { commit: ChangeCommit; area: string | null };

export type RiskStory = {
  units: readonly RiskUnit[];
  insertions: number;
  deletions: number;
  conversations: readonly VisibleConversation[];
  pr_ids: readonly string[];
  task_ids: readonly string[];
};

export type RiskContext = {
  /** Every ship the build knows of: release bursts, tags and deploy markers. */
  ships: readonly ShipEvent[];
};

const iso = (t: number) => new Date(t).toISOString();

const unitAreas = (u: RiskUnit) => (u.area ? [u.area] : Object.keys(u.commit.areas));

/**
 * `skew`: backend commits landed after the latest backend deploy while a web
 * ship is newer than them, so the client may call functions the backend lacks.
 * Silent for a team that has never posted a backend deploy marker.
 */
function skew(story: RiskStory, ctx: RiskContext): Risk | null {
  const deploys = ctx.ships.filter((s) => s.surface === "backend");
  if (!deploys.length) return null;
  const lastDeploy = Math.max(...deploys.map((s) => s.at));
  const pending = story.units
    .filter((u) => u.commit.timestamp > lastDeploy && unitAreas(u).some((a) => surfaceCoversArea("backend", a)))
    .map((u) => u.commit);
  if (!pending.length) return null;
  const oldest = Math.min(...pending.map((c) => c.timestamp));
  const webShip = ctx.ships
    .filter((s) => (s.surface === "web" || s.surface === "desktop") && s.at > oldest)
    .sort((a, b) => b.at - a.at)[0];
  if (!webShip) return null;
  return {
    code: "skew",
    evidence: [...new Set(pending.map((c) => c.sha)), `backend deployed ${iso(lastDeploy)}`, `${webShip.surface} shipped ${iso(webShip.at)} at ${webShip.version ?? webShip.sha}`],
  };
}

/** Every risk the story carries, in a fixed code order. */
export function computeRisks(story: RiskStory, ctx: RiskContext): Risk[] {
  const out: Risk[] = [];
  const sk = skew(story, ctx);
  if (sk) out.push(sk);
  const schema = [...new Set(story.units.flatMap((u) => (u.commit.schema_paths ?? []).filter((p) => !u.area || areaOf(p) === u.area)))];
  if (schema.length) out.push({ code: "schema", evidence: schema.sort() });
  const reverts = [...new Set(story.units.filter((u) => isRevert(u.commit.subject)).map((u) => u.commit.sha))];
  if (reverts.length) out.push({ code: "revert", evidence: reverts });
  const lines = story.insertions + story.deletions;
  if (lines > BULK_LINES && !story.pr_ids.length && !story.conversations.length && !story.task_ids.length) {
    out.push({ code: "bulk", evidence: [`${lines} lines`, ...new Set(story.units.map((u) => u.commit.sha))] });
  }
  const blocked = story.conversations.filter((c) => c.outcome_type === "blocked").map((c) => c.conversation_id);
  if (blocked.length) out.push({ code: "blocked", evidence: blocked });
  return out;
}
