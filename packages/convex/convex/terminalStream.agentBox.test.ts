import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { watchPane, getPane, sendPaneInput } from "./terminalStream";

// The relay for an AGENT BOX: a session owner watches a pane whose daemon
// signs in as a bot account. The stream command must land in the BOT's queue
// (that daemon is the only one that can capture the pane), the frame row must
// live under the bot (cliPushFrame writes under the daemon's own account), and
// none of it may open for someone who merely knows the ids.
const ME = "u".repeat(31) + "m";
const BOT = "u".repeat(31) + "b";
const STRANGER = "u".repeat(31) + "s";
const TEAM = "t".repeat(32);

function fixtures(opts: { owners?: string[] } = {}) {
  const owners = opts.owners ?? [ME];
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me" },
      { _id: STRANGER, name: "Stranger" },
      { _id: BOT, name: "Mr Bot", is_bot: true, team_id: TEAM },
    ],
    team_memberships: [
      { _id: "tm1", user_id: ME, team_id: TEAM, role: "member" },
      { _id: "tm2", user_id: STRANGER, team_id: TEAM, role: "member" },
    ],
    devices: [
      { _id: "d1", user_id: ME, device_id: "mydev", label: "macOS - MacBook", platform: "darwin", last_seen: 0 },
      { _id: "d2", user_id: BOT, device_id: "botdev", label: "macOS - Mac-mini", platform: "darwin", last_seen: 0 },
    ],
    conversations: [
      { _id: "conv1", session_id: "sess1", user_id: BOT, owner_user_id: owners[0], owner_device_id: "botdev" },
    ],
    session_owners: owners.map((u, i) => ({ _id: `so${i}`, conversation_id: "conv1", user_id: u })),
    terminal_frames: [],
    daemon_commands: [],
  });
}

const as = (db: any, userId: string): any => ({
  db,
  auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) },
});
const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);
// Seeded tables receive inserts in place; a table that was never seeded only
// shows up in the insert log.
const inserted = (db: any, table: string) =>
  db._tables[table] ?? db._inserted.filter((i: any) => i.table === table).map((i: any) => i.doc);

describe("agent-box relay", () => {
  test("the session owner watches the bot's pane: command in the BOT's queue, row under the bot", async () => {
    const db = fixtures();
    const res = await run(watchPane, as(db, ME), { device_id: "botdev", target: "cc-resume-1234abcd", conversation_id: "conv1" });
    expect(res.ok).toBe(true);
    const cmds = inserted(db, "daemon_commands").filter((c: any) => c.command === "stream_pane");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].user_id).toBe(BOT);
    expect(cmds[0].target_device_id).toBe("botdev");
    const rows = inserted(db, "terminal_frames");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(BOT);
    // …and reads and keystrokes resolve to that same row.
    expect(await run(getPane, as(db, ME), { device_id: "botdev", target: "cc-resume-1234abcd", conversation_id: "conv1" })).not.toBeNull();
  });

  test("a teammate who does not own the session gets nothing", async () => {
    const db = fixtures();
    const res = await run(watchPane, as(db, STRANGER), { device_id: "botdev", target: "cc-resume-1234abcd", conversation_id: "conv1" });
    expect(res).toEqual({ ok: false, reason: "unknown-device" });
    expect(inserted(db, "daemon_commands")).toHaveLength(0);
    expect(await run(getPane, as(db, STRANGER), { device_id: "botdev", target: "cc-resume-1234abcd", conversation_id: "conv1" })).toBeNull();
    const typed = await run(sendPaneInput, as(db, STRANGER), { device_id: "botdev", target: "cc-resume-1234abcd", conversation_id: "conv1", data: "0a" });
    expect(typed.ok).toBe(false);
  });

  test("the conversation must actually run on that device", async () => {
    const db = fixtures();
    const res = await run(watchPane, as(db, ME), { device_id: "mydev", target: "cc-x", conversation_id: "conv1" });
    // mydev is mine, but conv1 does not run there: the conversation route
    // answers for exactly one device, so this is a mismatch, not a fallback.
    expect(res).toEqual({ ok: false, reason: "unknown-device" });
  });

  test("without a conversation the relay stays own-device only", async () => {
    const db = fixtures();
    expect(await run(watchPane, as(db, ME), { device_id: "botdev", target: "cc-x" })).toEqual({ ok: false, reason: "unknown-device" });
    expect((await run(watchPane, as(db, ME), { device_id: "mydev", target: "cc-x" })).ok).toBe(true);
  });
});
