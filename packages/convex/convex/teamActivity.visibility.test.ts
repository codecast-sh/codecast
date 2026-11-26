// The team activity feed names sessions by title. It is recorded for every
// session routed to a team, so the read shows a teammate only the sessions
// shared with the team, and the author their own.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getTeamActivityFeed } from "./teamActivity";

const ADA = "u".repeat(31) + "a";
const BEN = "u".repeat(31) + "b";
const TEAM = "t".repeat(32);

function world(viewer: string) {
  const db = makeFakeDb({
    users: [{ _id: ADA, name: "Ada" }, { _id: BEN, name: "Ben" }],
    team_memberships: [ADA, BEN].map((id) => ({ _id: `m-${id}`, team_id: TEAM, user_id: id, role: "member", visibility: "full" })),
    conversations: [
      { _id: "c".repeat(31) + "p", user_id: ADA, team_id: TEAM, is_private: true, team_visibility: "private", title: "Salary review" },
      { _id: "c".repeat(31) + "s", user_id: ADA, team_id: TEAM, is_private: false, title: "Fix the login race" },
    ],
    team_activity_events: [
      { _id: "e1", team_id: TEAM, actor_user_id: ADA, event_type: "session_started", title: "Salary review", timestamp: 2, related_conversation_id: "c".repeat(31) + "p" },
      { _id: "e2", team_id: TEAM, actor_user_id: ADA, event_type: "session_started", title: "Fix the login race", timestamp: 1, related_conversation_id: "c".repeat(31) + "s" },
    ],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${viewer}|session`, tokenIdentifier: "t" }) } };
}

const titles = (r: any) => (r.events ?? r.page ?? r).map((e: any) => e.title);

describe("team activity feed", () => {
  test("a teammate sees shared sessions only", async () => {
    const r = await (getTeamActivityFeed as any)._handler(world(BEN), { team_id: TEAM });
    expect(titles(r)).toEqual(["Fix the login race"]);
  });
  test("the author sees their own private session", async () => {
    const r = await (getTeamActivityFeed as any)._handler(world(ADA), { team_id: TEAM });
    expect(titles(r)).toEqual(["Salary review", "Fix the login race"]);
  });
});
