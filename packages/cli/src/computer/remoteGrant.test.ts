import { describe, expect, test } from "bun:test";
import type { CloudHost } from "../browser/cloudHost.js";
import { GRANT_CHECKS, REMOTE_METHODS, newGrant, noticeDue, parseDuration, remoteRefusal, type RemoteRequest } from "./remoteGrant.js";

const host = (patch: Partial<CloudHost> = {}): CloudHost => ({ id: "i-1", provider: "aws", region: "r", user: "u", keyPath: "/k", ...patch } as CloudHost);
const req = (patch: Partial<RemoteRequest> = {}): RemoteRequest => ({ host: "i-1", session: "jx7aaaa", method: "getAppState", params: { app: "com.apple.TextEdit" }, ...patch });
const NOW = 1_800_000_000_000;

describe("whether a cloud host may drive the laptop's apps", () => {
  test("off by default: no grant is refused, with the card that asks the person", () => {
    const why = remoteRefusal(host(), req(), "mbp", NOW)!;
    expect(why).toContain("mbp has not let this host drive its apps");
    expect(why).toContain("cast decide");
    expect(why).toContain("--run 'cast computer remote grant --host i-1' --on laptop");
  });

  test("a host grant admits every session on it until revoked", () => {
    const h = host({ laptopComputer: newGrant({}, NOW) });
    expect(remoteRefusal(h, req(), "mbp", NOW)).toBeNull();
    expect(remoteRefusal(h, req({ session: "jx7bbbb" }), "mbp", NOW + 365 * 86_400_000)).toBeNull();
  });

  test("an unknown or shared host is refused even with a grant on it", () => {
    expect(remoteRefusal(undefined, req(), "mbp", NOW)).toContain("no longer lets host i-1 in");
    expect(remoteRefusal(host({ shared: true, laptopComputer: newGrant({}, NOW) }), req(), "mbp", NOW)).toContain("shared with teammates");
  });

  test("a session grant admits only its sessions", () => {
    const h = host({ laptopComputer: newGrant({ session: ["jx7aaaa"] }, NOW) });
    expect(remoteRefusal(h, req(), "mbp", NOW)).toBeNull();
    expect(remoteRefusal(h, req({ session: "jx7bbbb" }), "mbp", NOW)).toContain("mbp let session jx7aaaa on this host drive its apps, not session jx7bbbb");
    expect(remoteRefusal(h, req({ session: null }), "mbp", NOW)).toContain("not a process outside a session");
  });

  test("an expiring grant ends on its own", () => {
    const h = host({ laptopComputer: newGrant({ forMs: parseDuration("8h")! }, NOW) });
    expect(remoteRefusal(h, req(), "mbp", NOW + 7 * 3_600_000)).toBeNull();
    expect(remoteRefusal(h, req(), "mbp", NOW + 8 * 3_600_000)).toContain("expired");
  });

  test("an app list admits only those apps, and still lists what runs", () => {
    const h = host({ laptopComputer: newGrant({ apps: ["com.apple.TextEdit"] }, NOW) });
    expect(remoteRefusal(h, req({ params: { app: "COM.APPLE.TEXTEDIT" } }), "mbp", NOW)).toBeNull();
    expect(remoteRefusal(h, req({ params: { app: "com.apple.Notes" } }), "mbp", NOW)).toContain("only com.apple.TextEdit");
    expect(remoteRefusal(h, req({ method: "listApps", params: {} }), "mbp", NOW)).toBeNull();
  });

  test("each rule is its own entry, so the person's decision moves one line", () => {
    expect(Object.keys(GRANT_CHECKS).sort()).toEqual(["apps", "expiry", "scope"]);
  });

  test("terminate, setup and a raise never cross from a host, granted or not", () => {
    const h = host({ laptopComputer: newGrant({}, NOW) });
    for (const method of ["terminate", "handshake", "permissions", "openSettings"]) {
      expect(REMOTE_METHODS.has(method as never)).toBe(false);
      expect(remoteRefusal(h, req({ method }), "mbp", NOW)).toContain("not available from a cloud host");
    }
    expect(remoteRefusal(h, req({ method: "click", params: { app: "x", restoreWindow: true } }), "mbp", NOW)).toContain("--restore-window is not available");
  });

  test("durations and the once-a-day notice", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("soon")).toBeNull();
    const seen: Record<string, string> = {};
    const day = new Date(2026, 10, 14, 9);
    expect(noticeDue(seen, "i-1", day)).toBe(true);
    expect(noticeDue(seen, "i-1", new Date(2026, 10, 14, 23))).toBe(false);
    expect(noticeDue(seen, "i-2", day)).toBe(true);
    expect(noticeDue(seen, "i-1", new Date(2026, 10, 15, 0, 1))).toBe(true);
  });
});
