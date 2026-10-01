import { describe, expect, test } from "bun:test";
import { buildChannelRoster, isInRoom } from "../channelRoster";

const team = [
  { _id: "u1", name: "Ada" },
  { _id: "u2", name: "Bo" },
  { _id: "u3", name: "Cy" },
  { _id: "bot", name: "Anchor", is_bot: true },
];
const person = (slack_user_id: string, name: string, codecast_user_id: string | null = null) => ({
  _id: slack_user_id, team_id: "t", slack_user_id, name, handle: null, real_name: null,
  avatar_url: null, email: null, codecast_user_id, codecast_user_name: null, mapped_by: null,
});
const link = (ids?: string[]) => ({ _id: "l", chat_channel_id: "c", slack_member_ids: ids } as any);

describe("buildChannelRoster", () => {
  test("a public room's audience is the team, locked, with agents left out", () => {
    const rows = buildChannelRoster({ teamMembers: team, slackPeople: [], link: null });
    expect(rows.map((r) => [r.name, r.here, r.slack])).toEqual([
      ["Ada", "team", "none"], ["Bo", "team", "none"], ["Cy", "team", "none"],
    ]);
  });

  test("a private room splits members from teammates who could join", () => {
    const rows = buildChannelRoster({ kind: "private", memberIds: ["u2"], teamMembers: team, slackPeople: [], link: null });
    expect(rows.filter(isInRoom).map((r) => r.name)).toEqual(["Bo"]);
    expect(rows.find((r) => r.name === "Ada")?.here).toBe("out");
  });

  test("a mirror joins a mapped teammate into one row and lists Slack-only people", () => {
    const rows = buildChannelRoster({
      kind: "private",
      memberIds: ["u1"],
      teamMembers: team,
      slackPeople: [person("S1", "ada.slack", "u1"), person("S2", "Dee"), person("S3", "Eve"), person("S4", "Bo in Slack", "u2")],
      link: link(["S1", "S2", "S9"]),
    });
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(rows.filter((r) => r.userId === "u1")).toHaveLength(1);
    expect([by("Ada").here, by("Ada").slack]).toEqual(["in", "in"]);
    expect([by("Dee").here, by("Dee").slack]).toEqual(["none", "in"]);
    expect([by("Eve").here, by("Eve").slack]).toEqual(["none", "out"]);
    expect([by("Bo").here, by("Bo").slack]).toEqual(["out", "out"]);
    expect(by("Cy").slack).toBe("none");
    // A Slack member the people table has not met yet still counts.
    expect(by("Someone in Slack").slack).toBe("in");
    // Both sides first, then one side, then nobody.
    expect(rows[0].name).toBe("Ada");
    expect(isInRoom(rows[rows.length - 1])).toBe(false);
  });

  test("a teammate with two Slack accounts is in Slack when either one is", () => {
    const rows = buildChannelRoster({
      teamMembers: team,
      slackPeople: [person("S1", "bo", "u2"), person("S2", "bo.alt", "u2")],
      link: link(["S1"]),
    });
    expect(rows.find((r) => r.userId === "u2")?.slack).toBe("in");
    expect(rows.some((r) => r.slackUserId === "S2")).toBe(false);
  });
});
