// Peer transport plumbing (docs/architecture/peer-transport.md): the beat's
// tailnet report on the device row, the owner-only roster projection, the
// "Accept direct links" switch, and the per-pair transfer outcomes.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { heartbeatTailnetArg, heartbeatTailnetPatch } from "./lib/heartbeatTailnet";

setDefaultTimeout(120_000);

const SECRET = "peer-links-secret";
const TAILNET = { ip: "100.64.0.1", name: "mbp.tail1.ts.net.", tailnet: "tail1.ts.net", ts_user_id: "42", bindable: true };

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(SECRET), name: "mac", created_at: 1, last_used_at: 1, device_id: "here" } as any);
    for (const [user, device_id] of [[owner, "here"], [owner, "there"], [other, "bos-mac"]] as const) {
      await ctx.db.insert("devices", { user_id: user, device_id, label: device_id, platform: "darwin", last_seen: Date.now() } as any);
    }
    return { owner, other };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const token = presentToken(SECRET, "here");
  const device = (id: string) => t.run((ctx) => ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), id)).first());
  const beat = (tailnet?: unknown) =>
    t.mutation(api.users.daemonHeartbeat, { api_token: token, version: "1.0.0", platform: "darwin", pid: 1, device_id: "here", ...(tailnet !== undefined ? { tailnet: tailnet as any } : {}) });
  return { t, ...ids, as, token, device, beat };
}

describe("heartbeat tailnet", () => {
  test("a report writes, an unchanged one does not force a write, null clears", async () => {
    const { t, device, beat } = await setup();
    await beat(TAILNET);
    expect((await device("here"))!.tailnet).toEqual(TAILNET);

    const freshButOld = Date.now() - 10_000;
    const id = (await device("here"))!._id;
    await t.run((ctx) => ctx.db.patch(id, { last_seen: freshButOld }));
    await beat(TAILNET);
    expect((await device("here"))!.last_seen).toBe(freshButOld);
    await beat(undefined);
    expect((await device("here"))!.tailnet).toEqual(TAILNET);

    await beat({ ...TAILNET, bindable: false });
    const changed = (await device("here"))!;
    expect(changed.tailnet).toEqual({ ...TAILNET, bindable: false });
    expect(changed.last_seen).toBeGreaterThan(freshButOld);

    await beat(null);
    expect((await device("here"))!.tailnet).toBeUndefined();
  });

  test("a malformed report changes nothing and never fails the beat", async () => {
    const { device, beat } = await setup();
    await beat(TAILNET);
    const res = (await beat({ ip: "not-an-ip", name: "x" })) as any;
    expect(res.error).toBeUndefined();
    expect((await device("here"))!.tailnet).toEqual(TAILNET);
  });

  test("the http body is shaped to the validator", () => {
    expect(heartbeatTailnetArg(null)).toBeNull();
    expect(heartbeatTailnetArg("x")).toBeUndefined();
    expect(heartbeatTailnetArg({ ip: "100.64.0.1", name: "a.", tailnet: null, ts_user_id: 7, bindable: "no" })).toEqual({ ip: "100.64.0.1", name: "a.", ts_user_id: "7" });
    expect(heartbeatTailnetPatch(TAILNET, { ...TAILNET })).toEqual({});
    expect(heartbeatTailnetPatch(undefined, null)).toEqual({});
  });
});

describe("listDevices and setDeviceDirectLinks", () => {
  test("the owner sees tailnet and direct_links_off; the switch flips only its own machine", async () => {
    const { t, as, owner, other, token, beat } = await setup();
    await beat(TAILNET);
    await as(owner).mutation(api.peerLinks.setDeviceDirectLinks, { device_id: "there", enabled: false });
    const rows = await as(owner).query(api.devices.listDevices, {});
    const here = rows.find((d: any) => d.device_id === "here")!;
    expect(here.tailnet).toEqual(TAILNET);
    expect(here.direct_links_off).toBeUndefined();
    expect(rows.find((d: any) => d.device_id === "there")).toMatchObject({ direct_links_off: true });

    await t.mutation(api.peerLinks.setDeviceDirectLinks, { api_token: token, device_id: "there", enabled: true });
    expect((await as(owner).query(api.devices.listDevices, {})).find((d: any) => d.device_id === "there")!.direct_links_off).toBeUndefined();

    await expect(as(other).mutation(api.peerLinks.setDeviceDirectLinks, { device_id: "there", enabled: false })).rejects.toThrow("Unknown device");
    expect((await as(other).query(api.devices.listDevices, {})).map((d: any) => d.device_id)).toEqual(["bos-mac"]);
  });
});

describe("peer links", () => {
  test("records direct and relay outcomes per ordered pair, owner only", async () => {
    const { t, as, owner, other, token } = await setup();
    const link = { from_device_id: "there", to_device_id: "here" };
    await as(owner).mutation(api.peerLinks.recordPeerLink, { ...link, mode: "direct", ok: true, bytes: 1234 });
    await t.mutation(api.peerLinks.recordPeerLink, { api_token: token, ...link, mode: "direct", ok: false, reason: "x".repeat(500) });
    await as(owner).mutation(api.peerLinks.recordPeerLink, { ...link, mode: "relay", ok: true, bytes: 99 });

    const rows = await as(owner).query(api.peerLinks.listPeerLinks, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...link, last_bytes: 99 });
    expect(rows[0].last_direct_ok_at).toBeNumber();
    expect(rows[0].last_relay_ok_at).toBeNumber();
    expect(rows[0].last_direct_failure!.reason).toHaveLength(200);

    await as(owner).mutation(api.peerLinks.recordPeerLink, { from_device_id: "here", to_device_id: "there", mode: "relay", ok: true });
    expect(await as(owner).query(api.peerLinks.listPeerLinks, {})).toHaveLength(2);
    expect(await as(other).query(api.peerLinks.listPeerLinks, {})).toEqual([]);
  });

  test("refuses a pair that is not both the caller's machines", async () => {
    const { t, as, owner, other } = await setup();
    await expect(as(owner).mutation(api.peerLinks.recordPeerLink, { from_device_id: "bos-mac", to_device_id: "here", mode: "direct", ok: true })).rejects.toThrow("Unknown device");
    await expect(as(other).mutation(api.peerLinks.recordPeerLink, { from_device_id: "bos-mac", to_device_id: "here", mode: "direct", ok: true })).rejects.toThrow("Unknown device");
    await expect(as(owner).mutation(api.peerLinks.recordPeerLink, { from_device_id: "here", to_device_id: "here", mode: "direct", ok: true })).rejects.toThrow("two machines");
    await expect(t.mutation(api.peerLinks.recordPeerLink, { from_device_id: "there", to_device_id: "here", mode: "direct", ok: true })).rejects.toThrow("Authentication required");
    expect(await t.query(api.peerLinks.listPeerLinks, {})).toEqual([]);
  });
});
