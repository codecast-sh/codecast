/**
 * Several Chrome profiles on one bridge host: per-profile keys, one-time
 * codes, the shared token's migration, tab ids that never collide, sessions
 * that stay in their profile, take-back marks that outlive a restart, and
 * the idle-only retire a newer CLI asks for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateCodecastDir } from "../../test-helpers/codecastDir.js";
import { freePort } from "../instance.js";
import { CdpConnection } from "../cdp.js";
import { startBridgeHost, type BridgeState, type RunningHost } from "./host.js";
import { FakeExtension, TEST_TOKEN } from "./host.testutil.js";
import { mintPairingCode, readPairing, revokeProfile, MAX_PAIRING_FAILURES } from "./pairing.js";
import { isNewerBuild, parseBuild, shouldReplaceHost } from "./hostBuild.js";
import { targetIdOfTab, tabIdOfTarget } from "./protocol.js";
import { TabIds } from "./links.js";

let home: { restore(): void };
const hosts: RunningHost[] = [];
const exts: FakeExtension[] = [];

beforeEach(() => {
  home = isolateCodecastDir("cast-profiles-test-");
});
afterEach(async () => {
  for (const e of exts.splice(0)) e.ws?.close();
  for (const h of hosts.splice(0)) await h.close();
  home.restore();
});

type HostOpts = Partial<Parameters<typeof startBridgeHost>[0]>;
async function host(extra: HostOpts = {}): Promise<RunningHost> {
  const port = await freePort();
  const h = await startBridgeHost({ port, token: TEST_TOKEN, profiles: () => readPairing().profiles, ...extra });
  hosts.push(h);
  return h;
}
const ep = (port: number, session?: string, profile?: string) => ({ port, token: TEST_TOKEN, ...(session ? { session } : {}), ...(profile ? { profile } : {}) });
const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

/** A fake profile paired with a fresh code; returns it connected in key mode on a second dial. */
async function pairedProfile(port: number, key: string, tabs: number[], name: string, dir: string): Promise<FakeExtension> {
  const code = mintPairingCode({ dir, name });
  const first = await new FakeExtension(tabs.map((t) => FakeExtension.tab(t, `https://${name.toLowerCase()}.test/${t}`))).connect(port, {}, { mode: "code", key, code });
  expect(first.issued?.secret).toMatch(/^[0-9a-f]{64}$/);
  exts.push(first);
  return first;
}

describe("pairing with a one-time code", () => {
  test("a code is exchanged for a profile key once; the key reconnects; the code does not work twice", async () => {
    const h = await host();
    const code = mintPairingCode({ dir: "Default", name: "Ashot" });
    const ext = await new FakeExtension([]).connect(h.port, {}, { mode: "code", key: KEY_A, code });
    exts.push(ext);
    expect(ext.issued?.profile).toBe("ashot-default");
    const rec = readPairing().profiles[KEY_A];
    expect(rec.id).toBe("ashot-default");
    expect(rec.hash).not.toBe(ext.issued!.secret); // only the hash is stored
    expect(JSON.stringify(readPairing())).not.toContain(ext.issued!.secret);
    ext.ws.close();
    // The same code a second time: used up.
    await expect(new FakeExtension([]).connect(h.port, {}, { mode: "code", key: KEY_B, code })).rejects.toThrow("closed 4401");
    // The key it got works.
    const again = await new FakeExtension([]).connect(h.port, {}, { mode: "key", key: KEY_A, secret: ext.issued!.secret });
    exts.push(again);
    expect(h.profiles()).toEqual(["ashot-default"]);
  });

  test("wrong codes count; at the limit every pending code is thrown away", async () => {
    const h = await host();
    const good = mintPairingCode(null);
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
      await expect(new FakeExtension([]).connect(h.port, {}, { mode: "code", key: KEY_A, code: "ZZZZ-ZZZZ" })).rejects.toThrow("closed 4401");
    }
    expect(readPairing().codes).toHaveLength(0);
    await expect(new FakeExtension([]).connect(h.port, {}, { mode: "code", key: KEY_A, code: good })).rejects.toThrow("closed 4401");
  });

  test("an expired code is refused", async () => {
    const h = await host();
    const code = mintPairingCode(null, Date.now() - 11 * 60_000);
    await expect(new FakeExtension([]).connect(h.port, {}, { mode: "code", key: KEY_A, code })).rejects.toThrow("closed 4401");
  });
});

describe("the shared token's migration", () => {
  test("a profile-aware extension on the shared token is issued its own key, named after the pinned profile", async () => {
    const h = await host({ pinnedProfile: () => "Default", profileName: () => "Ashot" });
    const ext = await new FakeExtension([]).connect(h.port, {}, { mode: "legacy", key: KEY_A });
    exts.push(ext);
    expect(ext.issued?.profile).toBe("ashot-default");
    expect(readPairing().profiles[KEY_A].via).toBe("migrated");
    ext.ws.close();
    const keyed = await new FakeExtension([]).connect(h.port, {}, { mode: "key", key: KEY_A, secret: ext.issued!.secret });
    exts.push(keyed);
    expect(h.profiles()).toEqual(["ashot-default"]);
  });

  test("a store build from before profiles still connects on the shared token, as the legacy link", async () => {
    const h = await host();
    const ext = await new FakeExtension([]).connect(h.port);
    exts.push(ext);
    expect(ext.issued).toBeUndefined();
    expect(h.extensionConnected()).toBe(true);
  });
});

describe("several profiles at once", () => {
  test("tab ids never collide, each session's tabs open and stay in its own profile", async () => {
    const h = await host();
    const a = await pairedProfile(h.port, KEY_A, [7], "Work", "Profile 2");
    const b = await pairedProfile(h.port, KEY_B, [7], "Home", "Default");
    expect(h.profiles()).toEqual(["work-profile-2", "home-default"]);

    // A session-less listing sees both profiles' tab 7 under two ids.
    const all = await CdpConnection.fromPort(ep(h.port));
    const ids = (await (await fetch(`http://127.0.0.1:${h.port}/json/list?token=${TEST_TOKEN}`)).json()) as any[];
    expect(ids.map((t) => t.profile).sort()).toEqual(["home-default", "work-profile-2"]);
    expect(new Set(ids.map((t) => t.id)).size).toBe(2);
    all.close();

    // Session s1 defaults to the first profile; s2 asks for the second.
    const s1 = await CdpConnection.fromPort(ep(h.port, "s1"));
    const s2 = await CdpConnection.fromPort(ep(h.port, "s2", "home-default"));
    const t1 = (await s1.send("Target.createTarget", { url: "https://one.test/" })).targetId;
    const t2 = (await s2.send("Target.createTarget", { url: "https://two.test/" })).targetId;
    expect(a.tabs.map((t) => t.url)).toContain("https://one.test/");
    expect(b.tabs.map((t) => t.url)).toContain("https://two.test/");
    // Both fakes minted Chrome id 100; the host's ids differ.
    expect(t1).not.toBe(t2);

    // Driving each at once reaches only its own profile, with Chrome's own id.
    const att1 = await s1.send("Target.attachToTarget", { targetId: t1, flatten: true });
    const att2 = await s2.send("Target.attachToTarget", { targetId: t2, flatten: true });
    const [r1, r2] = await Promise.all([
      s1.send("Runtime.evaluate", { expression: "1" }, att1.sessionId),
      s2.send("Runtime.evaluate", { expression: "2" }, att2.sessionId),
    ]);
    expect(r1.echo).toEqual({ tabId: 100, method: "Runtime.evaluate", params: { expression: "1" } });
    expect(r2.echo).toEqual({ tabId: 100, method: "Runtime.evaluate", params: { expression: "2" } });
    expect(a.seen.filter((m) => m.op === "cdp").map((m) => m.params.expression)).toEqual(["1"]);
    expect(b.seen.filter((m) => m.op === "cdp").map((m) => m.params.expression)).toEqual(["2"]);

    // Events come back under the right session.
    const got: any[] = [];
    s2.on((ev) => {
      if (ev.method === "Page.loadEventFired") got.push(ev.params);
    });
    s1.on((ev) => {
      if (ev.method === "Page.loadEventFired") got.push({ s1: ev.params });
    });
    b.event(100, "Page.loadEventFired", { from: "home" });
    a.event(100, "Page.loadEventFired", { from: "work" });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContainEqual({ from: "home" }); // s2 hears only its profile's tab 100
    expect(got).toContainEqual({ s1: { from: "work" } });
    expect(got).toHaveLength(2);

    // s1 stays in its profile: asking for the other one is refused while it holds a tab.
    const s1b = await CdpConnection.fromPort(ep(h.port, "s1", "home-default"));
    await expect(s1b.send("Target.createTarget", { url: "https://x.test/" })).rejects.toThrow(/stays there/);
    for (const c of [s1, s2, s1b]) c.close();
  });

  test("revoking one profile cuts only it off; the other keeps working", async () => {
    const h = await host();
    const a = await pairedProfile(h.port, KEY_A, [], "Work", "Profile 2");
    await pairedProfile(h.port, KEY_B, [], "Home", "Default");
    const s2 = await CdpConnection.fromPort(ep(h.port, "s2", "home-default"));
    const closed = new Promise<number>((r) => a.ws.once("close", (code) => r(code)));
    revokeProfile(KEY_A);
    expect(await closed).toBe(4401);
    expect(h.profiles()).toEqual(["home-default"]);
    const t = (await s2.send("Target.createTarget", { url: "https://still.test/" })).targetId;
    expect(tabIdOfTarget(t)).not.toBeNull();
    await expect(new FakeExtension([]).connect(h.port, {}, { mode: "key", key: KEY_A, secret: a.issued!.secret })).rejects.toThrow("closed 4401");
    s2.close();
  });
});

describe("tab state across a host restart", () => {
  test("a take-back mark survives the restart and keeps answering 409", async () => {
    let saved: Pick<BridgeState, "sessionTabs" | "takenBack" | "sessionProfiles"> = {};
    const h = await host({ onTabState: (s) => (saved = s) });
    const ext = await new FakeExtension([]).connect(h.port);
    exts.push(ext);
    const s = await CdpConnection.fromPort(ep(h.port, "sx"));
    const { targetId } = await s.send("Target.createTarget", { url: "https://mine.test/" });
    ext.ws.send(JSON.stringify({ op: "detached", tabId: tabIdOfTarget(targetId), reason: "reclaimed" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(saved.takenBack?.sx?.map((t) => t.tabId)).toEqual([tabIdOfTarget(targetId)!]);
    s.close();
    ext.ws.close();
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);

    const h2 = await host({ ...saved });
    const ext2 = await new FakeExtension(ext.tabs).connect(h2.port);
    exts.push(ext2);
    const res = await fetch(`http://127.0.0.1:${h2.port}/grant?token=${TEST_TOKEN}&session=sx&target=${targetId}&own=1`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).takenBack).toBe(true);
  });

  test("a second profile's clashing tab keeps its host id across the restart", async () => {
    let saved: Pick<BridgeState, "sessionTabs" | "takenBack" | "sessionProfiles"> = {};
    const h = await host({ onTabState: (s) => (saved = s) });
    await pairedProfile(h.port, KEY_A, [5], "Work", "Profile 2");
    const b = await pairedProfile(h.port, KEY_B, [], "Home", "Default");
    const s = await CdpConnection.fromPort(ep(h.port, "sb", "home-default"));
    // Both fakes would mint 100; the first one's 100 is unused, so make A list it first.
    const tA = await CdpConnection.fromPort(ep(h.port, "sa"));
    await tA.send("Target.createTarget", { url: "https://a.test/" });
    const { targetId } = await s.send("Target.createTarget", { url: "https://b.test/" });
    expect(tabIdOfTarget(targetId)).toBeGreaterThanOrEqual(0x40000000);
    expect(saved.sessionTabs?.sb?.[0]).toMatchObject({ profile: "home-default", chromeTabId: 100 });
    for (const c of [s, tA]) c.close();
    for (const e of exts.splice(0)) e.ws.close();
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);

    const h2 = await host({ ...saved });
    const keyB = Object.entries(readPairing().profiles).find(([, r]) => r.id === "home-default")!;
    const b2 = await new FakeExtension(b.tabs).connect(h2.port, {}, { mode: "key", key: keyB[0], secret: b.issued!.secret });
    exts.push(b2);
    const res = await fetch(`http://127.0.0.1:${h2.port}/grant?token=${TEST_TOKEN}&session=sb&target=${targetId}&own=1`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("retire for a newer build", () => {
  test("an idle host retires; a busy one says so and stays", async () => {
    let retired = 0;
    const h = await host({ build: "1.0.0", onRetire: () => retired++, idleQuietMs: 50, retireDrainMs: 300 });
    const ext = await new FakeExtension([]).connect(h.port);
    exts.push(ext);
    const health = await (await fetch(`http://127.0.0.1:${h.port}/healthz`)).text();
    expect(health).toContain("build=1.0.0");

    // Busy: a cdp call the fake never answers holds a request in flight.
    const s = await CdpConnection.fromPort(ep(h.port, "busy"));
    const { targetId } = await s.send("Target.createTarget", { url: "https://slow.test/" });
    const { sessionId } = await s.send("Target.attachToTarget", { targetId, flatten: true });
    ext.ws.removeAllListeners("message");
    void s.send("Runtime.evaluate", { expression: "slow" }, sessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const busy = await fetch(`http://127.0.0.1:${h.port}/retire?token=${TEST_TOKEN}`, { method: "POST" });
    expect(busy.status).toBe(409);
    expect(retired).toBe(0);
    s.close();
  });

  test("idle: the retire is granted", async () => {
    let retired = 0;
    const h = await host({ build: "1.0.0", onRetire: () => retired++, idleQuietMs: 50, retireDrainMs: 2_000 });
    const ok = await fetch(`http://127.0.0.1:${h.port}/retire?token=${TEST_TOKEN}`, { method: "POST" });
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(retired).toBe(1);
  });
});

describe("build ordering", () => {
  test("a higher version or a later commit wins; ties and unordered pairs never swap", () => {
    const b = (s: string) => parseBuild(s)!;
    expect(isNewerBuild(b("1.2.0"), b("1.1.9"))).toBe(true);
    expect(isNewerBuild(b("1.1.9"), b("1.2.0"))).toBe(false);
    expect(isNewerBuild(b("1.1.0+aaaaaaaaaaaa.200"), b("1.1.0+bbbbbbbbbbbb.100"))).toBe(true);
    expect(isNewerBuild(b("1.1.0+bbbbbbbbbbbb.100"), b("1.1.0+aaaaaaaaaaaa.200"))).toBe(false);
    expect(isNewerBuild(b("1.1.0+aaaaaaaaaaaa.100"), b("1.1.0+bbbbbbbbbbbb.100"))).toBe(false);
    expect(isNewerBuild(b("1.1.0+aaaaaaaaaaaa.100"), b("1.1.0"))).toBe(false);
    expect(shouldReplaceHost(undefined)).toBe(false);
  });

  test("this process against a host stamped older or newer", () => {
    const prev = process.env.CAST_BRIDGE_BUILD;
    process.env.CAST_BRIDGE_BUILD = "2.0.0+cccccccccccc.500";
    try {
      expect(shouldReplaceHost("2.0.0+dddddddddddd.400")).toBe(true);
      expect(shouldReplaceHost("2.0.0+cccccccccccc.500")).toBe(false);
      expect(shouldReplaceHost("2.0.0+eeeeeeeeeeee.600")).toBe(false);
      expect(shouldReplaceHost("1.9.0")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CAST_BRIDGE_BUILD;
      else process.env.CAST_BRIDGE_BUILD = prev;
    }
  });
});

describe("TabIds", () => {
  test("Chrome's own id unless another profile holds it; seeded ids stay", () => {
    const ids = new TabIds();
    expect(ids.host("a", 7)).toBe(7);
    const clash = ids.host("b", 7);
    expect(clash).toBeGreaterThanOrEqual(0x40000000);
    expect(ids.chrome(clash)).toEqual({ link: "b", tab: 7 });
    const fresh = new TabIds();
    fresh.seed(clash, "b", 7);
    expect(fresh.host("b", 7)).toBe(clash);
    expect(targetIdOfTab(clash)).toHaveLength(8);
  });
});
