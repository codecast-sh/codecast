import { test, expect } from "bun:test";
import { peopleOnlyTree } from "./orgPeopleTree";

const T = 1_700_000_000_000;

test("a team with the org feature off: the people on its roster, no bots, no roles", () => {
  const tree = peopleOnlyTree({
    workspace: { kind: "team", id: "t1", name: "Union" },
    roster: [
      { _id: "u1", name: "Ashot", role: "owner", presence_state: "active" },
      { _id: "u2", name: "Samvit", role: "admin", presence_state: "idle", github_avatar_url: "https://x/s.png" },
      { _id: "u3", name: "Cam", role: "member" },
      { _id: "b1", name: "Outbound lead", is_bot: true, bot_kind: "role" },
      { _id: "b2", name: "Slack Jason", is_bot: true, bot_kind: "slack" },
    ],
    me: { _id: "u2", name: "Samvit" },
    now: T,
  });
  expect(tree.roles).toEqual([]);
  expect(tree.anchors).toEqual([]);
  expect(tree.people.map((p) => [p.user_id, p.role, p.is_me, p.presence ?? null])).toEqual([
    ["u1", "owner", false, "online"],
    ["u2", "admin", true, "away"],
    ["u3", "member", false, null],
  ]);
  expect(tree.people[1].image).toBe("https://x/s.png");
  expect(tree.people[0].sessions).toEqual([]);
});

test("a personal workspace is its owner", () => {
  const tree = peopleOnlyTree({ workspace: { kind: "user", id: "u1", name: "Personal" }, roster: [], me: { _id: "u1", name: "Ashot" }, now: T });
  expect(tree.people.map((p) => [p.user_id, p.role, p.is_me])).toEqual([["u1", "owner", true]]);
});
