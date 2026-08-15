import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { reportInventory, reportAppliedOps, sweepCapabilityState, DEVICE_RETENTION_MS } from "./capabilities";

// Retention has two halves and two different owners. Scope rows are retired by
// the INGEST, because only the daemon knows what still exists — and it takes
// two consecutive full reports to say so, since one full omitting a scope may
// be a transient read failure. Device rows are retired by the CRON, because a
// wiped laptop never reports again and only the server can notice silence.

const TOKEN = "cast_retention_token";
const OWNER = "u_owner";
const DEV = "dev_gone";

async function tables(extra: Record<string, any[]> = {}) {
  return {
    users: [{ _id: OWNER, name: "o" }],
    api_tokens: [{ _id: "t1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    capability_state: [],
    capability_observation: [],
    capability_events: [],
    capability_consents: [],
    devices: [],
    ...extra,
  } as Record<string, any[]>;
}

const ctx = (t: Record<string, any[]>) =>
  ({ db: makeFakeDb(t), scheduler: { runAfter: async () => null } }) as any;

const entries = (name: string) =>
  JSON.stringify({ items: [{ kind: "skill", name, scope: "user", enabled: true }], marketplaces: [] });

async function report(
  c: any,
  over: { scope_key?: string; full?: boolean; covered_scopes?: string[]; name?: string } = {},
) {
  return await (reportInventory as any)._handler(c, {
    api_token: TOKEN,
    device_id: DEV,
    entries_json: entries(over.name ?? "deploy"),
    scope_key: over.scope_key,
    full: over.full,
    covered_scopes: over.covered_scopes,
  });
}

const scopeKeys = (t: Record<string, any[]>) =>
  t.capability_state.map((r: any) => r.scope_key).sort();

describe("scope retention on full reports", () => {
  test("a partial report deletes nothing", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, { scope_key: "" , full: true, covered_scopes: ["git:x/a"] });
    await report(c, { scope_key: "git:x/a", name: "proj" });
    // Partial (no full flag): the scope stays, whatever covered_scopes says.
    await report(c, { scope_key: "", covered_scopes: [] });
    expect(scopeKeys(t)).toEqual(["", "git:x/a"]);
  });

  test("one full report omitting a scope is a fluke, not a deletion", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, { scope_key: "git:x/a", name: "proj" });
    // First full: prior machine-wide state was not full, so nothing retires.
    await report(c, { scope_key: "", full: true, covered_scopes: [] });
    expect(scopeKeys(t)).toEqual(["", "git:x/a"]);
  });

  test("two consecutive full reports omitting a scope delete that scope's row", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, { scope_key: "git:x/a", name: "proj" });
    await report(c, { scope_key: "", full: true, covered_scopes: ["git:x/a"] });
    // Second full, scope gone from coverage: now the omission means something.
    await report(c, { scope_key: "", full: true, covered_scopes: [], name: "deploy2" });
    expect(scopeKeys(t)).toEqual([""]);
  });

  test("a covered scope survives any number of full reports", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, { scope_key: "git:x/a", name: "proj" });
    await report(c, { scope_key: "", full: true, covered_scopes: ["git:x/a"] });
    await report(c, { scope_key: "", full: true, covered_scopes: ["git:x/a"], name: "d2" });
    await report(c, { scope_key: "", full: true, covered_scopes: ["git:x/a"], name: "d3" });
    expect(scopeKeys(t)).toEqual(["", "git:x/a"]);
  });

  test("the machine-wide row itself is never retired by coverage", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, { scope_key: "", full: true, covered_scopes: [] });
    await report(c, { scope_key: "", full: true, covered_scopes: [], name: "d2" });
    expect(scopeKeys(t)).toEqual([""]);
  });
});

describe("dead-device sweep", () => {
  const stateRow = (device: string, scope = "") => ({
    _id: `cs_${device}_${scope || "user"}`,
    user_id: OWNER,
    device_id: device,
    client: "claude",
    scope_key: scope,
    entries_json: entries("x"),
    entries_hash: "h",
    entry_count: 1,
    reported_at: 1,
  });

  test("a 91-day-silent device's rows go; a live device is untouched", async () => {
    const now = Date.now();
    const t = await tables({
      devices: [
        { _id: "d1", user_id: OWNER, device_id: "dev_gone", last_seen: now - DEVICE_RETENTION_MS - 86_400_000 },
        { _id: "d2", user_id: OWNER, device_id: "dev_live", last_seen: now - 60_000 },
      ],
      capability_state: [
        stateRow("dev_gone"),
        stateRow("dev_gone", "git:x/a"),
        stateRow("dev_live"),
      ],
    });
    const res = await (sweepCapabilityState as any)._handler(ctx(t), {});
    expect(res.deleted).toBe(2);
    expect(t.capability_state.map((r: any) => r.device_id)).toEqual(["dev_live"]);
  });

  test("a device just inside the window keeps everything", async () => {
    const now = Date.now();
    const t = await tables({
      devices: [
        { _id: "d1", user_id: OWNER, device_id: "dev_edge", last_seen: now - DEVICE_RETENTION_MS + 60_000 },
      ],
      capability_state: [stateRow("dev_edge")],
    });
    const res = await (sweepCapabilityState as any)._handler(ctx(t), {});
    expect(res.deleted).toBe(0);
    expect(t.capability_state).toHaveLength(1);
  });
});

// ----------------------------------------------- owned-ops: server copy wins

describe("owned-ops divergence (ct-42860)", () => {
  const ops = (v: string) => JSON.stringify({ "~/.claude/settings.json": v });

  test("the apply path seeds authority; a matching mirror is silent", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, {});
    const seed = await (reportAppliedOps as any)._handler(c, {
      api_token: TOKEN, device_id: DEV, owned_ops_json: ops("hash-a"),
    });
    expect(seed.status).toBe("recorded");
    const beat = await report(c, {});
    expect(beat.server_owned_ops).toBeUndefined();
    expect(t.capability_events.filter((e: any) => e.kind === "conflict")).toHaveLength(0);
  });

  test("a diverging mirror fires a conflict event and hands the server copy back", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, {});
    await (reportAppliedOps as any)._handler(c, {
      api_token: TOKEN, device_id: DEV, owned_ops_json: ops("hash-a"),
    });
    // The hostile edit: the local sidecar claims different ownership.
    const beat = await (reportInventory as any)._handler(c, {
      api_token: TOKEN, device_id: DEV, entries_json: entries("deploy"),
      local_owned_ops_json: ops("hash-TAMPERED"),
    });
    expect(beat.server_owned_ops).toBe(ops("hash-a")); // server copy wins
    const conflicts = t.capability_events.filter((e: any) => e.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].ops_json).toContain("owned_ops_divergence");
  });

  test("the heartbeat can never launder a tampered sidecar into authority", async () => {
    const t = await tables();
    const c = ctx(t);
    await report(c, {});
    await (reportAppliedOps as any)._handler(c, {
      api_token: TOKEN, device_id: DEV, owned_ops_json: ops("hash-a"),
    });
    await (reportInventory as any)._handler(c, {
      api_token: TOKEN, device_id: DEV, entries_json: entries("deploy"),
      local_owned_ops_json: ops("hash-TAMPERED"),
    });
    // The server copy is unchanged after the tampered beat.
    const row = t.capability_state.find((r: any) => r.scope_key === "");
    expect(row.owned_ops_json).toBe(ops("hash-a"));
  });
});
