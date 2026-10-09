// The company without agents (D11). A workspace with the org feature off gets
// no tree from the server (org.tree answers it as it answers a stranger), yet
// its goals, projects and people still belong on the Org screen. This builds
// the tree that screen draws from what the store already holds: the people on
// the team roster, no roles, no seats. Bots are left out, as every people
// surface leaves them out (memberKind). A personal workspace is its owner.
import { isPerson } from "@codecast/shared/team/memberKind";
import { EMPTY_COUNTS, type OrgPerson, type OrgTree } from "./orgTypes";

export type RosterRow = {
  _id: string;
  name?: string | null;
  image?: string | null;
  github_avatar_url?: string | null;
  role?: string | null;
  is_bot?: boolean | null;
  bot_kind?: string | null;
  presence_state?: string | null;
};

const PRESENCE: Record<string, OrgPerson["presence"]> = { active: "online", idle: "away", away: "away", offline: "offline" };

function personOf(m: RosterRow, meId: string | null): OrgPerson {
  const role = m.role === "owner" || m.role === "admin" ? m.role : "member";
  const presence = m.presence_state ? PRESENCE[m.presence_state] : undefined;
  return {
    user_id: String(m._id),
    name: m.name?.trim() || "Someone",
    ...(m.image || m.github_avatar_url ? { image: (m.image || m.github_avatar_url)! } : {}),
    role,
    is_me: !!meId && String(m._id) === meId,
    ...(presence ? { presence } : {}),
    counts: { ...EMPTY_COUNTS },
    sessions: [],
    total: 0,
  };
}

export function peopleOnlyTree(input: {
  workspace: OrgTree["workspace"];
  roster: readonly RosterRow[];
  me: RosterRow | null;
  now: number;
}): OrgTree {
  const meId = input.me ? String(input.me._id) : null;
  const people = input.workspace.kind === "team"
    ? input.roster.filter(isPerson).map((m) => personOf(m, meId))
    : input.me ? [personOf({ ...input.me, role: "owner" }, meId)] : [];
  return { workspace: input.workspace, people, roles: [], anchors: [], generated_at: input.now };
}
