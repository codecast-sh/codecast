import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "bun:test";
import Dexie from "dexie";
import { _reopenForTests, _resetPersistedShadow, flushLivenessWrites, setHydrating, writePatchesToIDB } from "../idbCache";
import { noteSnapshotSync } from "../idbCollectionDiff";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);

// A write persists the rows its patches name, at a cost of those rows: a
// 400-cell batch into a sheet beside 80k other rows never walks the 80k. The
// pending map goes to disk with every action (its locks guard outbox rows that are already
// on disk); other meta blobs are written once per quiet spell.
const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;
const ID = (n: number) => `k17row${String(n).padStart(26, "a")}`;
const settle = () => Bun.sleep(30);

describe("incremental persistence", () => {
  it("writes the patched rows, keeps unpatched ones, and still honors a whole-collection replace and snapshot drops", async () => {
    _resetPersistedShadow();
    const rows: Record<string, any> = {};
    for (let i = 0; i < 2000; i++) rows[ID(i)] = { _id: ID(i), doc_id: "d", layer: "main", key: `k${i}`, v: i };
    writePatchesToIDB([{ op: "replace", path: ["liveElements"], value: rows } as any], { liveElements: rows, pending: {} });
    await settle();
    expect(await db().liveElements.count()).toBe(2000);

    // One row changed, read through a collection that would throw if it were enumerated.
    const changed = { ...rows[ID(7)], v: -7 };
    const next = new Proxy({ ...rows, [ID(7)]: changed }, { ownKeys: () => { throw new Error("walked the collection"); } });
    writePatchesToIDB([{ op: "replace", path: ["liveElements", ID(7), "v"], value: -7 } as any], { liveElements: next, pending: {} });
    await settle();
    expect((await db().liveElements.get(ID(7))).v).toBe(-7);

    // A snapshot prune is found by the full diff even though no patch names the row.
    const pruned = { ...rows, [ID(7)]: changed };
    delete pruned[ID(9)];
    noteSnapshotSync("liveElements", Object.keys(pruned), [ID(9)]);
    writePatchesToIDB([{ op: "replace", path: ["liveElements", ID(8), "v"], value: 8 } as any], { liveElements: pruned, pending: {} });
    await settle();
    expect(await db().liveElements.get(ID(9))).toBeUndefined();
    expect(await db().liveElements.count()).toBe(1999);
  });

  it("writes the pending blob with every action, so a page killed right after a write keeps its lock", async () => {
    // The outbox row reaches disk at once; a lock that waited for the 250 ms
    // quiet spell was lost with a page killed in between (no flush), and the
    // reloaded page showed a stale push over its own parked write.
    writePatchesToIDB([{ op: "replace", path: ["pending"], value: {} } as any], { pending: { "liveElements:k:v": { type: "field", value: 1 } } });
    await settle();
    expect((await db().meta.get("pending"))?.value).toEqual({ "liveElements:k:v": { type: "field", value: 1 } });
  });

  it("still writes other meta blobs once for a run of actions, with their last value", async () => {
    let puts = 0;
    const put = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "wallet") puts++; return put(row); };
    for (let i = 0; i < 50; i++) writePatchesToIDB([{ op: "replace", path: ["wallet"], value: {} } as any], { wallet: { n: i } });
    expect(puts).toBe(0);
    await Bun.sleep(400);
    expect(puts).toBe(1);
    expect((await db().meta.get("wallet")).value).toEqual({ n: 49 });
    db().meta.put = put;
  });

  // A working agent's session row changes on every message and model call.
  // Rewriting it each time kept the desktop app's browser process compacting
  // IndexedDB at a core; those ticks now wait for the liveness flush, and the
  // sync cursors wait with them so they never reach disk ahead of the rows.
  it("holds liveness-only session changes and syncMeta for the liveness flush, rows first", async () => {
    _resetPersistedShadow();
    const S = (n: number) => `jx7sess${String(n).padStart(25, "a")}`;
    const base = { _id: S(1), title: "t", agent_status: "working", message_count: 1, updated_at: 1, open_tasks: [{ short_id: "ct-1" }] };
    let sessions: Record<string, any> = { [S(1)]: base, [S(2)]: { ...base, _id: S(2) } };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: sessions } as any], { sessions, pending: {} });
    await settle();
    expect((await db().sessions.get(S(1))).message_count).toBe(1);

    const writes: string[] = [];
    const sessionsPut = db().sessions.bulkPut.bind(db().sessions);
    db().sessions.bulkPut = (rows: any[]) => { writes.push(...rows.map((r) => `row:${r._id}:${r.message_count}`)); return sessionsPut(rows); };
    const metaPut = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "syncMeta") writes.push(`syncMeta:${row.value.s.cursor}`); return metaPut(row); };

    for (let i = 2; i <= 20; i++) {
      // A push brings fresh nested objects even where nothing in them changed.
      sessions = { ...sessions, [S(1)]: { ...sessions[S(1)], message_count: i, updated_at: i, open_tasks: [{ short_id: "ct-1" }] } };
      const syncMeta = { s: { cursor: i } };
      writePatchesToIDB(
        [
          { op: "replace", path: ["sessions", S(1), "message_count"], value: i } as any,
          { op: "replace", path: ["syncMeta", "s"], value: syncMeta.s } as any,
        ],
        { sessions, syncMeta, pending: {} },
      );
    }
    await Bun.sleep(300);
    expect(writes).toEqual([]);
    expect((await db().sessions.get(S(1))).message_count).toBe(1);

    // Any other field goes to disk at once, liveness fields and all.
    sessions = { ...sessions, [S(2)]: { ...sessions[S(2)], agent_status: "idle", message_count: 9 } };
    writePatchesToIDB([{ op: "replace", path: ["sessions", S(2), "agent_status"], value: "idle" } as any], { sessions, syncMeta: { s: { cursor: 20 } }, pending: {} });
    await settle();
    expect(writes).toEqual([`row:${S(2)}:9`]);

    flushLivenessWrites();
    await settle();
    expect(writes).toEqual([`row:${S(2)}:9`, `row:${S(1)}:20`, "syncMeta:20"]);
    expect((await db().sessions.get(S(1))).message_count).toBe(20);
    expect((await db().meta.get("syncMeta")).value).toEqual({ s: { cursor: 20 } });

    db().sessions.bulkPut = sessionsPut;
    db().meta.put = metaPut;
  });

  // The roster is one 17 KB blob, and every teammate's heartbeat or
  // conversation switch changed it; it reached disk about once a second.
  it("holds a roster whose rows changed only in presence for the liveness flush", async () => {
    const member = (id: string, extra = {}) => ({ _id: id, name: id, role: "member", daemon_last_seen: 0, viewing_conversation_id: null, focus_project_ids: ["p"], ...extra });
    let roster = [member("a"), member("b")];
    const writes: string[] = [];
    const metaPut = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "teamMembers") writes.push(JSON.stringify(row.value.map((m: any) => [m.role, m.daemon_last_seen]))); return metaPut(row); };

    writePatchesToIDB([{ op: "replace", path: ["teamMembers"], value: roster } as any], { teamMembers: roster, pending: {} });
    await Bun.sleep(400);
    expect(writes).toHaveLength(1);

    for (let i = 1; i <= 10; i++) {
      // A list push is a fresh roster: new rows and nested arrays, in any order.
      roster = [member("b"), member("a", { daemon_last_seen: i * 60_000, viewing_conversation_id: `c${i}` })];
      writePatchesToIDB([{ op: "replace", path: ["teamMembers", 0, "daemon_last_seen"], value: i } as any], { teamMembers: roster, pending: {} });
    }
    await Bun.sleep(400);
    expect(writes).toHaveLength(1);

    // A role change goes at once, carrying the presence it has.
    roster = [member("b", { role: "admin" }), roster[1]];
    writePatchesToIDB([{ op: "replace", path: ["teamMembers", 0, "role"], value: "admin" } as any], { teamMembers: roster, pending: {} });
    await Bun.sleep(400);
    expect(writes.at(-1)).toBe(JSON.stringify([["admin", 0], ["member", 600_000]]));

    roster = [roster[0], member("a", { daemon_last_seen: 660_000 })];
    writePatchesToIDB([{ op: "replace", path: ["teamMembers", 0, "daemon_last_seen"], value: 11 } as any], { teamMembers: roster, pending: {} });
    await Bun.sleep(400);
    expect(writes).toHaveLength(2);
    flushLivenessWrites();
    await settle();
    expect(writes).toHaveLength(3);
    expect((await db().meta.get("teamMembers")).value[1].daemon_last_seen).toBe(660_000);
    db().meta.put = metaPut;
  });

  it("holds a reordered machine roster and the org tree's tallies the same way, by row key and nested path", async () => {
    const writes: string[] = [];
    const metaPut = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "machineRoster" || row.key === "orgTree") writes.push(row.key); return metaPut(row); };
    const device = (id: string, last_seen: number, extra = {}) => ({ device_id: id, label: id, last_seen, sync_no_progress_ms: last_seen, settings: { a: 1 }, ...extra });
    // Each push is a fresh tree: sessions reorder by updated_at, their states
    // and the roles' day counters and standing lines move with every turn.
    const session = (_id: string, tick: number) => ({ _id, title: _id, updated_at: tick, state: tick % 2 ? "working" : "idle" });
    const person = (id: string, working: number, sessions: string[], tick: number) =>
      ({ user_id: id, name: id, counts: { working, idle: 0 }, total: working, sessions: (tick % 2 ? [...sessions].reverse() : sessions).map((sid) => session(sid, tick)) });
    const tree = (working: number, sessions = ["s1", "s2"], tick = 0) => ({
      people: [person("u1", working, sessions, tick)],
      roles: [{ _id: "r1", name: "Lead", counts: { working: 0 }, total: 0, counters: { day: "d", wakes: tick }, standing: { conversation_id: "c1", state_line: `turn ${tick}` }, sessions: [session("s9", tick)] }],
      workspace: "team",
    });

    const write = (key: string, value: any) => writePatchesToIDB([{ op: "replace", path: [key], value } as any], { [key]: value, pending: {} });
    write("machineRoster", [device("mac", 1), device("box", 0)]);
    write("orgTree", tree(1));
    await Bun.sleep(400);
    expect(writes.sort()).toEqual(["machineRoster", "orgTree"]);

    write("machineRoster", [device("box", 2), device("mac", 1)]);
    write("orgTree", tree(5, undefined, 1));
    await Bun.sleep(400);
    expect(writes).toHaveLength(2);

    // A session joining a parent's list is durable.
    write("machineRoster", [device("box", 2, { label: "renamed" }), device("mac", 1)]);
    write("orgTree", tree(5, ["s1", "s2", "s3"], 1));
    await Bun.sleep(400);
    expect(writes).toHaveLength(4);
    expect((await db().meta.get("machineRoster")).value[0].label).toBe("renamed");
    db().meta.put = metaPut;
  });
});
