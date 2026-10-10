// vendorReplay.importLinked (external-data.md X5, X7): a replay row the caller
// may read is imported from its vendor once, through the adapter its provider
// names; our own recordings and imported ones are answered as they are.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import { deferVendorRefresh, recordingForImport } from "../replays";
import { VendorCallError, importLinked, vendorRefreshRetryAt } from "./vendorReplay";
import { VENDOR_CONVERTER_VERSION, VENDOR_REFRESH_RETRY, needsVendorImport } from "@codecast/shared/contracts/replay";

const h = (fn: any) => fn._handler;

function world() {
  const replay = (over: Record<string, unknown>) => ({
    workspace: "team:team_1",
    team_id: "team_1",
    source_id: "src_row",
    started_at: 1,
    counts: { clicks: 0, errors: 0, failed_requests: 0 },
    group_ids: [],
    chunk_keys: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  });
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      replays: [
        replay({ _id: "r_sentry", short_id: "rp-1", provider: "sentry", external_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }),
        replay({ _id: "r_posthog", short_id: "rp-2", provider: "posthog", external_id: "0193abc" }),
        replay({ _id: "r_done", short_id: "rp-3", provider: "sentry", external_id: "ffff", imported_at: 5, converter_version: VENDOR_CONVERTER_VERSION, chunk_keys: ["k"] }),
        replay({ _id: "r_old", short_id: "rp-5", provider: "posthog", external_id: "0ld", imported_at: 5, chunk_keys: ["k"] }),
        replay({ _id: "r_sdk", short_id: "rp-4", provider: "sdk", external_id: "own" }),
      ],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const actions: Array<{ name: string; args: any }> = [];
  const state = { failActions: false, failWith: "PostHog answered 429" };
  const ctx = (userId: string) =>
    ({
      runQuery: async (fn: any, args: any) => {
        expect(getFunctionName(fn)).toBe("replays:recordingForImport");
        return h(recordingForImport)({ db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) } }, args);
      },
      runAction: async (fn: any, args: any) => {
        actions.push({ name: getFunctionName(fn), args });
        if (state.failActions) throw new Error(state.failWith);
        return { replay_id: "x", short_id: "rp-x", imported: true, truncated: false };
      },
      runMutation: async (fn: any, args: any) => {
        expect(getFunctionName(fn)).toBe("replays:deferVendorRefresh");
        return h(deferVendorRefresh)({ db }, args);
      },
    }) as any;
  return { ctx, actions, db, state, set failActions(on: boolean) { state.failActions = on; } };
}

describe("importLinked", () => {
  test("a mirrored recording goes to its own adapter, by source and external id", async () => {
    const w = world();
    await h(importLinked)(w.ctx("u1"), { replay: "rp-1" });
    await h(importLinked)(w.ctx("u1"), { replay: "rp-2" });
    expect(w.actions).toEqual([
      { name: "sources/sentry:importReplay", args: { source_id: "src_row", external_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90" } },
      { name: "sources/posthog:importForSource", args: { source_id: "src_row", external_id: "0193abc" } },
    ]);
  });

  test("an imported recording and our own SDK recording are answered without a vendor call", async () => {
    const w = world();
    expect(await h(importLinked)(w.ctx("u1"), { replay: "rp-3" })).toEqual({ replay_id: "r_done", short_id: "rp-3", imported: false, truncated: false });
    expect(await h(importLinked)(w.ctx("u1"), { replay: "rp-4" })).toMatchObject({ short_id: "rp-4", imported: false });
    expect(w.actions).toEqual([]);
  });

  test("an older copy still answers when the vendor refuses the refresh", async () => {
    const w = world();
    w.failActions = true;
    expect(await h(importLinked)(w.ctx("u1"), { replay: "rp-5" })).toMatchObject({ short_id: "rp-5", imported: false });
  });

  test("a failed refresh is not retried on every read: the copy waits an hour, or a month once the vendor says it is gone", async () => {
    const w = world();
    w.failActions = true;
    const before = Date.now();
    await h(importLinked)(w.ctx("u1"), { replay: "rp-5" });
    await h(importLinked)(w.ctx("u1"), { replay: "rp-5" });
    expect(w.actions.length).toBe(1);
    const row = await (w.db as any).get("r_old");
    expect(row.vendor_refresh_after).toBeGreaterThanOrEqual(before + VENDOR_REFRESH_RETRY.failed_ms);
    expect(needsVendorImport(row, row.vendor_refresh_after + 1)).toBe(true);

    expect(vendorRefreshRetryAt(new Error("PostHog answered 404: not found"), 0)).toBe(VENDOR_REFRESH_RETRY.gone_ms);
    expect(vendorRefreshRetryAt(new Error("Sentry has nothing at https://sentry.io/x"), 0)).toBe(VENDOR_REFRESH_RETRY.gone_ms);
    expect(vendorRefreshRetryAt(new VendorCallError({ error: "x", status: 410 }), 0)).toBe(VENDOR_REFRESH_RETRY.gone_ms);
    expect(vendorRefreshRetryAt(new VendorCallError({ error: "slow down", status: 429, retry_after_ms: 3 * 60 * 60_000 }), 0)).toBe(3 * 60 * 60_000);
    expect(vendorRefreshRetryAt(new Error("PostHog answered 503"), 0)).toBe(VENDOR_REFRESH_RETRY.failed_ms);
  });

  test("a copy made by an older converter is imported again", async () => {
    const w = world();
    await h(importLinked)(w.ctx("u1"), { replay: "rp-5" });
    expect(w.actions).toEqual([{ name: "sources/posthog:importForSource", args: { source_id: "src_row", external_id: "0ld" } }]);
  });

  test("someone outside the replay's workspace reads it as missing, and nothing is imported", async () => {
    const w = world();
    await expect(h(importLinked)(w.ctx("u2"), { replay: "rp-1" })).rejects.toThrow(/Replay not found/);
    expect(w.actions).toEqual([]);
  });
});
