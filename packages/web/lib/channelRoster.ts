// Who is in a chat room, on both of its sides. A room's codecast audience is
// its member rows (private, DM) or the whole team (public, agents); a Slack
// mirror adds the Slack channel's own roster. The member panel renders one
// list from both, joined through the Slack people mapping, so a teammate who is
// in the room here and in Slack is one row with two marks, not two rows.

import { memberName, type ChatMember } from "./chatViews";
import type { ChatSlackLinkRow, ChatSlackPersonRow } from "../store/chatSlice";

/** One side of one person. "team": in by being on the team (a public room),
 *  so there is nothing to toggle. "none": they have no identity on that side
 *  (no codecast account, or not matched to a Slack person). */
export type RosterSide = "in" | "out" | "team" | "none";

export type RosterRow = {
  key: string;
  userId: string | null;
  slackUserId: string | null;
  name: string;
  avatar: string | null;
  member: ChatMember | null;
  here: RosterSide;
  slack: RosterSide;
};

export function buildChannelRoster(opts: {
  kind?: string;
  memberIds?: string[];
  teamMembers: ChatMember[];
  slackPeople: ChatSlackPersonRow[];
  link: ChatSlackLinkRow | null;
}): RosterRow[] {
  const { link } = opts;
  const restricted = opts.kind === "private" || opts.kind === "dm";
  const members = new Set((opts.memberIds ?? []).map(String));
  const inSlack = new Set(link?.slack_member_ids ?? []);
  const slackByUser = new Map<string, ChatSlackPersonRow>();
  const slackById = new Map<string, ChatSlackPersonRow>();
  for (const p of opts.slackPeople) {
    slackById.set(p.slack_user_id, p);
    // A teammate with several Slack accounts is represented by the one in
    // the channel, so their row says "in" rather than offering an invite.
    const uid = p.codecast_user_id ? String(p.codecast_user_id) : null;
    if (uid && (!slackByUser.has(uid) || inSlack.has(p.slack_user_id))) slackByUser.set(uid, p);
  }
  const slackSide = (slackId: string | null): RosterSide =>
    !link ? "none" : !slackId ? "none" : inSlack.has(slackId) ? "in" : "out";

  const rows: RosterRow[] = [];
  const seenSlack = new Set<string>();
  const seenUsers = new Set<string>();
  for (const m of opts.teamMembers) {
    const id = String(m._id);
    // Agents speak in rooms but are not members of them; a DM with one keeps
    // its face through the DM headline instead.
    if (m.is_bot && !members.has(id)) continue;
    seenUsers.add(id);
    const sp = slackByUser.get(id) ?? null;
    if (sp) seenSlack.add(sp.slack_user_id);
    rows.push({
      key: `u:${id}`,
      userId: id,
      slackUserId: sp?.slack_user_id ?? null,
      name: memberName(m),
      avatar: m.image || m.github_avatar_url || sp?.avatar_url || null,
      member: m,
      here: restricted ? (members.has(id) ? "in" : "out") : "team",
      slack: slackSide(sp?.slack_user_id ?? null),
    });
  }
  // Members of a restricted room the roster has not loaded (a departed
  // teammate) still count as being in it.
  for (const id of members) {
    if (seenUsers.has(id)) continue;
    rows.push({ key: `u:${id}`, userId: id, slackUserId: null, name: "Former teammate", avatar: null, member: null, here: "in", slack: "none" });
  }
  if (link) {
    // Slack people with no teammate behind them: everyone in the Slack
    // channel, plus the rest of the workspace as people who could be invited.
    const ids = new Set<string>([...inSlack, ...slackById.keys()]);
    for (const sid of ids) {
      if (seenSlack.has(sid)) continue;
      const sp = slackById.get(sid);
      // Mapped to a teammate the roster above already placed.
      if (sp?.codecast_user_id && seenUsers.has(String(sp.codecast_user_id))) continue;
      rows.push({
        key: `s:${sid}`,
        userId: null,
        slackUserId: sid,
        name: sp?.name ?? "Someone in Slack",
        avatar: sp?.avatar_url ?? null,
        member: null,
        here: "none",
        slack: inSlack.has(sid) ? "in" : "out",
      });
    }
  }
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** In the room on any side. */
export function isInRoom(row: RosterRow): boolean {
  return row.here === "in" || row.here === "team" || row.slack === "in";
}

function rank(row: RosterRow): number {
  const here = row.here === "in" || row.here === "team";
  const slack = row.slack === "in";
  return here && slack ? 0 : here ? 1 : slack ? 2 : 3;
}
