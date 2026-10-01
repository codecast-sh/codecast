// A seeded world of several people and teams for the multiplayer sim harness
// (docs/architecture/multiplayer-sim-harness.md, section 3.6). Each user's
// sessions come from the unchanged single-user `genWorld`, so the legacy
// convergence suites keep their pinned worlds byte for byte. Pure data with no
// convex imports: the harness inserts these rows through the real handlers.

import type { TeamFeatures } from "../teamFeatures";
import { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, genWorld, type GenWorld } from "./inboxProjectionGen";

export type WorldRow = Record<string, any>;

export interface TeamWorldSpec {
  users: string[];
  // The first member listed is the team's creator (admin), as teams.create
  // makes it; every later member joins as a member.
  teams: { name: string; members: string[]; features?: TeamFeatures }[];
  rowsPerUser: number;
  seed: number;
  // The projection minute the sessions are dated against (inboxEpoch).
  epoch: number;
}

export interface TeamWorld {
  users: WorldRow[];
  teams: WorldRow[];
  team_memberships: WorldRow[];
  // Keyed by user name; each world's rows belong to that user's id.
  perUser: Record<string, GenWorld>;
  // One armed trigger behind every session genWorld stamps with an
  // armed_trigger_kind, so the denormalized kind agrees with agent_tasks
  // (refreshArmedTriggerKind) from genesis on.
  agent_tasks: WorldRow[];
}

// A user's world seed is `seed * 16 + userIndex`, so up to 16 users keep
// disjoint seeds within one world and across every world seed.
export const TEAM_WORLD_MAX_USERS = 16;

export const userIdFor = (name: string): string => convexIdFor(`user:${name}`);
export const teamIdFor = (name: string): string => convexIdFor(`team:${name}`);
export const membershipIdFor = (team: string, user: string): string => convexIdFor(`member:${team}:${user}`);
// A trigger is named after its home session, whose id is already unique.
export const triggerIdFor = (conversationId: string): string => convexIdFor(`trg${conversationId}`);

// The trigger that makes a session's armed kind true: a recurring loop for
// "standing", a single follow-up for "once" (dormancy.armedTriggerKindFor).
function backingTrigger(user: string, session: number, conv: WorldRow, epoch: number): WorldRow | null {
  const kind = conv.armed_trigger_kind;
  if (kind !== "standing" && kind !== "once") return null;
  return {
    _id: triggerIdFor(conv._id),
    user_id: conv.user_id,
    title: `${user} trigger ${session}`,
    prompt: "check in",
    originating_conversation_id: conv._id,
    target_conversation_id: conv._id,
    schedule_type: kind === "standing" ? "recurring" : "once",
    ...(kind === "standing" ? { interval_ms: GEN_HOUR } : {}),
    run_at: epoch + GEN_HOUR,
    mode: "apply",
    status: "scheduled",
    retry_count: 0,
    created_at: Math.min(conv.started_at ?? epoch, epoch) - GEN_MIN,
  };
}

export function genTeamWorld(spec: TeamWorldSpec): TeamWorld {
  if (spec.users.length > TEAM_WORLD_MAX_USERS) {
    throw new Error(`genTeamWorld: ${spec.users.length} users, at most ${TEAM_WORLD_MAX_USERS} keep per-user seeds disjoint`);
  }
  const known = new Set(spec.users);
  for (const t of spec.teams) {
    for (const m of t.members) {
      if (!known.has(m)) throw new Error(`genTeamWorld: team "${t.name}" lists "${m}", who is not in users`);
    }
    if (new Set(t.members).size !== t.members.length) throw new Error(`genTeamWorld: team "${t.name}" lists a member twice`);
  }

  const teamCreatedAt = spec.epoch - 60 * GEN_DAY;
  const teams: WorldRow[] = spec.teams.map((t) => ({
    _id: teamIdFor(t.name),
    name: t.name,
    created_at: teamCreatedAt,
    invite_code: `sim-${t.name}`,
    ...(t.features ? { features: { ...t.features } } : {}),
  }));

  const team_memberships: WorldRow[] = [];
  const firstTeam = new Map<string, { teamId: string; role: "admin" | "member" }>();
  for (const t of spec.teams) {
    t.members.forEach((m, i) => {
      const role = i === 0 ? "admin" : "member";
      team_memberships.push({
        _id: membershipIdFor(t.name, m),
        user_id: userIdFor(m),
        team_id: teamIdFor(t.name),
        role,
        joined_at: teamCreatedAt + i * GEN_MIN,
      });
      if (!firstTeam.has(m)) firstTeam.set(m, { teamId: teamIdFor(t.name), role });
    });
  }

  const users: WorldRow[] = [];
  const perUser: Record<string, GenWorld> = {};
  spec.users.forEach((name, i) => {
    const _id = userIdFor(name);
    // A joiner's first team becomes both its default and its active team,
    // as teams.join writes them.
    const first = firstTeam.get(name);
    users.push({
      _id,
      name,
      email: `${name}@sim.invalid`,
      created_at: spec.epoch - 90 * GEN_DAY,
      ...(first ? { team_id: first.teamId, active_team_id: first.teamId, role: first.role } : {}),
    });
    perUser[name] = genWorld(spec.seed * TEAM_WORLD_MAX_USERS + i, spec.rowsPerUser, spec.epoch, _id);
  });
  const agent_tasks = spec.users.flatMap((name) =>
    perUser[name].conversations.flatMap((conv, i) => backingTrigger(name, i, conv, spec.epoch) ?? []));

  // convexIdFor folds case and punctuation and truncates at 32 characters, so
  // two distinct names can mint one id. Refuse that instead of merging rows.
  const seen = new Map<string, string>();
  for (const [table, rows] of [["users", users], ["teams", teams], ["team_memberships", team_memberships], ["agent_tasks", agent_tasks]] as const) {
    for (const r of rows) {
      const prior = seen.get(r._id);
      if (prior) throw new Error(`genTeamWorld: ${table} id ${r._id} collides with ${prior}; pick distinct names`);
      seen.set(r._id, `${table} ${r.name ?? r._id}`);
    }
  }

  return { users, teams, team_memberships, perUser, agent_tasks };
}
