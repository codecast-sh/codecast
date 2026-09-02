import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { resolveReachableRunnerDevice } from "./devices";

// When may a viewer treat the machine a session runs on as their own? Their
// own device, or an agent box: a bot account's daemon running a session the
// viewer owns, on the viewer's team. A person's machine never.
const ME = "u".repeat(31) + "m";
const BOT = "u".repeat(31) + "b";
const JASON = "u".repeat(31) + "j";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "t".repeat(32);

function fixtures(opts: { runner?: string; owners?: string[]; botTeam?: string | null; member?: boolean } = {}) {
  const runner = opts.runner ?? BOT;
  const owners = opts.owners ?? [ME];
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me" },
      { _id: JASON, name: "Jason" },
      { _id: STRANGER, name: "Stranger" },
      { _id: BOT, name: "Mr Bot", is_bot: true, team_id: opts.botTeam === undefined ? TEAM : opts.botTeam },
    ],
    team_memberships: opts.member === false ? [] : [{ _id: "tm1", user_id: ME, team_id: TEAM, role: "member" }],
    devices: [
      { _id: "d1", user_id: ME, device_id: "mydev", label: "macOS - MacBook-Pro-168", platform: "darwin", last_seen: 0, ssh_host: "laptop" },
      { _id: "d2", user_id: BOT, device_id: "botdev", label: "macOS - Mac-mini", platform: "darwin", last_seen: 0, ssh_host: "mini" },
      { _id: "d3", user_id: JASON, device_id: "jasondev", label: "macOS - Jason", platform: "darwin", last_seen: 0 },
    ],
    conversations: [
      {
        _id: "conv1",
        session_id: "sess1",
        user_id: runner,
        owner_user_id: owners[0],
        owner_device_id: runner === BOT ? "botdev" : runner === ME ? "mydev" : "jasondev",
      },
    ],
    session_owners: owners.map((u, i) => ({ _id: `so${i}`, conversation_id: "conv1", user_id: u })),
  });
}
const conv = (db: any) => db._tables.conversations[0];

describe("resolveReachableRunnerDevice", () => {
  test("your own device: reachable, answers under you", async () => {
    const db = fixtures({ runner: ME });
    const r = await resolveReachableRunnerDevice({ db }, ME as any, conv(db));
    expect(r).toMatchObject({ runnerUserId: ME, via_bot: false });
    expect(r!.device.device_id).toBe("mydev");
  });

  test("an agent box running a session you own, on your team: reachable under the bot", async () => {
    const db = fixtures();
    const r = await resolveReachableRunnerDevice({ db }, ME as any, conv(db));
    expect(r).toMatchObject({ runnerUserId: BOT, via_bot: true });
    expect(r!.device.device_id).toBe("botdev");
  });

  test("owner via the session_owners set (not just the primary cache) counts", async () => {
    const db = fixtures({ owners: [JASON, ME] });
    const r = await resolveReachableRunnerDevice({ db }, ME as any, conv(db));
    expect(r?.via_bot).toBe(true);
  });

  test("a bot's session you do NOT own stays out of reach", async () => {
    const db = fixtures({ owners: [JASON] });
    expect(await resolveReachableRunnerDevice({ db }, ME as any, conv(db))).toBeNull();
  });

  test("a bot on a team you are not a member of stays out of reach", async () => {
    const db = fixtures({ member: false });
    expect(await resolveReachableRunnerDevice({ db }, ME as any, conv(db))).toBeNull();
    const db2 = fixtures({ botTeam: null });
    expect(await resolveReachableRunnerDevice({ db: db2 }, ME as any, conv(db2))).toBeNull();
  });

  test("a PERSON's machine is never reachable, even for a session you own", async () => {
    const db = fixtures({ runner: JASON, owners: [ME] });
    expect(await resolveReachableRunnerDevice({ db }, ME as any, conv(db))).toBeNull();
  });

  test("a stranger reaches nothing", async () => {
    const db = fixtures();
    expect(await resolveReachableRunnerDevice({ db }, STRANGER as any, conv(db))).toBeNull();
  });
});
