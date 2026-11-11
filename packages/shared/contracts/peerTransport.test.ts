import { describe, expect, test } from "bun:test";
import { heartbeatTailnetField, normalizePeerTailnet, peerLinkState, reportedPeerTailnet, samePeerTailnet, type PeerTailnet } from "./peerTransport";

const self: PeerTailnet = { ip: "100.64.0.1", name: "mbp.tail1.ts.net.", tailnet: "tail1.ts.net", ts_user_id: "42", bindable: true };
const peer: PeerTailnet = { ip: "100.64.0.2", name: "mini.tail1.ts.net.", tailnet: "tail1.ts.net", ts_user_id: "42", bindable: true };

describe("normalizePeerTailnet", () => {
  test("keeps ts_user_id and bindable, numeric user ids become strings", () => {
    expect(normalizePeerTailnet({ ip: "100.64.0.1", name: "mbp.", tailnet: "t.ts.net", ts_user_id: 42, bindable: false }))
      .toEqual({ ip: "100.64.0.1", name: "mbp.", tailnet: "t.ts.net", ts_user_id: "42", bindable: false });
  });

  test("drops malformed optional fields and refuses a malformed record", () => {
    expect(normalizePeerTailnet({ ip: "100.64.0.1", name: "mbp.", ts_user_id: "", bindable: "yes" }))
      .toEqual({ ip: "100.64.0.1", name: "mbp.", tailnet: null });
    expect(normalizePeerTailnet({ ip: "fd7a::1", name: "mbp." })).toBeNull();
    expect(normalizePeerTailnet({ ip: "100.64.0.1", name: "x".repeat(256) })).toBeNull();
    expect(normalizePeerTailnet(null)).toBeNull();
  });

  test("only an IPv4 in Tailscale's 100.64.0.0/10 is a tailnet address", () => {
    for (const ip of ["100.64.0.1", "100.127.255.255", "100.100.1.2"]) expect(normalizePeerTailnet({ ip, name: "m." })?.ip).toBe(ip);
    for (const ip of ["999.1.1.1", "127.0.0.1", "192.168.1.5", "100.63.255.255", "100.128.0.1", "100.64.0.256"]) {
      expect(normalizePeerTailnet({ ip, name: "m." })).toBeNull();
    }
  });
});

describe("heartbeatTailnetField", () => {
  test("a read that outlasts the wait says nothing; a prompt read returns without waiting", async () => {
    const field = heartbeatTailnetField();
    const started = Date.now();
    expect(await field(new Promise(() => {}), 5)).toBeUndefined();
    expect(await field(Promise.resolve(self), 60_000)).toEqual(self);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("one null read says nothing; two in a row report off the tailnet; a value resets the count", async () => {
    const field = heartbeatTailnetField();
    expect(await field(Promise.resolve(null), 1_000)).toBeUndefined();
    expect(await field(Promise.resolve(null), 1_000)).toBeNull();
    expect(await field(Promise.resolve(null), 1_000)).toBeNull();
    expect(await field(Promise.resolve(self), 1_000)).toEqual(self);
    expect(await field(Promise.resolve(null), 1_000)).toBeUndefined();
    expect(await field(new Promise(() => {}), 5)).toBeUndefined();
    expect(await field(Promise.resolve(null), 1_000)).toBeNull();
  });
});

describe("reportedPeerTailnet", () => {
  const me = { ip: "100.64.0.1", name: "mbp.tail1.ts.net.", tailnet: "tail1.ts.net" };
  test("carries Self's UserID and whether its IP is on a local interface", () => {
    expect(reportedPeerTailnet(me, { Self: { UserID: 42 } }, ["127.0.0.1", "100.64.0.1"]))
      .toEqual({ ...me, ts_user_id: "42", bindable: true });
  });

  test("userspace networking (IP on no interface) is not bindable; a missing UserID is left out", () => {
    expect(reportedPeerTailnet(me, {}, ["127.0.0.1"])).toEqual({ ...me, bindable: false });
    expect(reportedPeerTailnet(me, null, [])).toEqual({ ...me, bindable: false });
  });

  test("off the tailnet reports null", () => {
    expect(reportedPeerTailnet(null, { Self: { UserID: 1 } }, [])).toBeNull();
  });
});

describe("samePeerTailnet", () => {
  test("a changed user or bindability is a change", () => {
    expect(samePeerTailnet(self, { ...self })).toBe(true);
    expect(samePeerTailnet(self, { ...self, ts_user_id: "7" })).toBe(false);
    expect(samePeerTailnet(self, { ...self, bindable: false })).toBe(false);
    expect(samePeerTailnet(null, undefined)).toBe(true);
  });
});

describe("peerLinkState", () => {
  test("untested but every precondition holds: direct, not proven", () => {
    expect(peerLinkState({ self, peer, peerOnline: true })).toEqual({ state: "direct", tailnet: "tail1.ts.net", proven: false });
  });

  test("a direct success newer than the last failure is proven", () => {
    expect(peerLinkState({ self, peer, peerOnline: true, last: { last_direct_ok_at: 20, last_direct_failure: { at: 10, reason: "timeout" } } }))
      .toEqual({ state: "direct", tailnet: "tail1.ts.net", proven: true });
  });

  test("a failure at or after the last success relays with its reason", () => {
    expect(peerLinkState({ self, peer, peerOnline: true, last: { last_direct_ok_at: 10, last_direct_failure: { at: 20, reason: "connect refused" } } }))
      .toEqual({ state: "relayed", why: "last_failed", reason: "connect refused" });
    expect(peerLinkState({ self, peer, peerOnline: true, last: { last_direct_failure: { at: 1, reason: "x" } } }).state).toBe("relayed");
  });

  test("another Tailscale account relays", () => {
    expect(peerLinkState({ self, peer: { ...peer, ts_user_id: "43" }, peerOnline: true })).toEqual({ state: "relayed", why: "other_account" });
    expect(peerLinkState({ self: { ...self, ts_user_id: undefined }, peer, peerOnline: true }).state).toBe("direct");
  });

  test("a source that cannot bind its tailnet IP relays", () => {
    expect(peerLinkState({ self, peer: { ...peer, bindable: false }, peerOnline: true })).toEqual({ state: "relayed", why: "not_bindable" });
  });

  test("off, missing, offline, other tailnet", () => {
    expect(peerLinkState({ self, peer, peerOnline: true, directLinks: false })).toEqual({ state: "relayed", why: "disabled" });
    expect(peerLinkState({ self: null, peer, peerOnline: true })).toEqual({ state: "relayed", why: "self_off" });
    expect(peerLinkState({ self, peer: null, peerOnline: true })).toEqual({ state: "relayed", why: "peer_off" });
    expect(peerLinkState({ self, peer, peerOnline: false })).toEqual({ state: "relayed", why: "peer_offline" });
    expect(peerLinkState({ self, peer: { ...peer, tailnet: "tail2.ts.net" }, peerOnline: true })).toEqual({ state: "relayed", why: "different_tailnet" });
  });
});
