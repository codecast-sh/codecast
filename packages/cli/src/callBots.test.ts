import { describe, expect, test } from "bun:test";
import { parseJoinAt, runCallJoin, runCallLeave, type MeetingBotRow } from "./callBots";

const bot = (meet_id: string, status: string): MeetingBotRow => ({
  meet_id,
  meeting_url: "https://meet.google.com/abc-defg-hij",
  platform_name: "Google Meet",
  status,
  status_words: null,
  join_at: null,
  transcript_id: null,
});

function fakePost(rows: MeetingBotRow[]) {
  const calls: Array<{ route: string; body: any }> = [];
  const post = async (route: string, body: any) => {
    calls.push({ route, body: structuredClone(body) });
    if (route.endsWith("/list")) return rows;
    if (route.endsWith("/cancel")) return { ...rows.find((r) => r.meet_id === body.meet_id)!, status: "cancelled" };
    return bot("aaaa1111-new", "requested");
  };
  return { post, calls };
}

describe("cast call join", () => {
  test("from a session the meeting feeds it, unless --no-feed", async () => {
    const { post, calls } = fakePost([]);
    await runCallJoin("meet.google.com/abc-defg-hij", {}, { post, session: "jx7abc", log: () => {} });
    await runCallJoin("meet.google.com/abc-defg-hij", { noFeed: true }, { post, session: "jx7abc", log: () => {} });
    expect(calls.map((c) => c.body.session)).toEqual(["jx7abc", undefined]);
  });

  test("--at reads relative and absolute times", () => {
    expect(parseJoinAt("15m", 1_000)).toBe(1_000 + 15 * 60_000);
    expect(parseJoinAt("in 2h", 0)).toBe(2 * 3_600_000);
    expect(parseJoinAt("2026-11-14T18:00:00Z")).toBe(Date.parse("2026-11-14T18:00:00Z"));
    expect(() => parseJoinAt("tomorrowish")).toThrow(/15m/);
  });
});

describe("cast call leave", () => {
  test("with no id it takes out the only bot still going", async () => {
    const { post, calls } = fakePost([bot("aaaa1111-x", "ended"), bot("bbbb2222-y", "recording")]);
    await runCallLeave(undefined, { post, log: () => {} });
    expect(calls.at(-1)).toEqual({ route: "/cli/calls/bots/cancel", body: { meet_id: "bbbb2222-y" } });
  });

  test("with several going it names them instead of guessing", async () => {
    const { post } = fakePost([bot("aaaa1111-x", "recording"), bot("bbbb2222-y", "waiting_room")]);
    await expect(runCallLeave(undefined, { post, log: () => {} })).rejects.toThrow(/Several/);
  });
});
