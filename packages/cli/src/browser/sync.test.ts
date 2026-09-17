/**
 * `cast browser sync` on the cloud host: what leaves the host (an origin, a
 * live port, never a URL), what is refused before any request, and how the
 * laptop's answer is read. On a laptop the body is the old local carry.
 */

import { describe, expect, test } from "bun:test";
import { runBrowserSync, serverErrorLine, type SyncDeps } from "./sync.js";
import { OWN_LOGIN_REASON } from "./credentials.js";
import { DATACENTER_IP_NOTE } from "../cloud/browserSync.js";

function harness(over: Partial<SyncDeps> & { outcome?: any; mutationError?: string; remote?: boolean } = {}) {
  const calls = { mutations: [] as any[], queries: 0, order: [] as string[], provisions: [] as any[] };
  const out: string[] = [];
  const err: string[] = [];
  let outcome = over.outcome;
  const deps: SyncDeps = {
    ensureBrowser: async () => { calls.order.push("ensureBrowser"); },
    me: () => "sess-1",
    isRemote: () => over.remote ?? true,
    readState: () => { calls.order.push("readState"); return { port: 37121, sourceProfile: "Default", channel: "chrome" } as any; },
    provisionLocalLogins: async (...a) => { calls.provisions.push(a); return { injected: 1, host: "github.com" }; },
    loadSitePolicy: () => null,
    refuseNavigation: () => null,
    convex: async () => ({
      token: "tok",
      api: { cloud: { requestBrowserSync: "cloud:requestBrowserSync", commandOutcome: "cloud:commandOutcome" } },
      client: {
        mutation: async (_fn: any, args: any) => {
          calls.mutations.push(args);
          if (over.mutationError) throw new Error(over.mutationError);
          return { command_id: "cmd_1", device_id: "mac-device", label: "mac" };
        },
        query: async () => { calls.queries++; return outcome ?? null; },
      },
    }),
    deviceId: () => "box-device",
    env: { CODECAST_CONVERSATION_ID: "conv_1" },
    sleep: async () => { calls.order.push("sleep"); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { deps, calls, out, err, setOutcome: (o: any) => { outcome = o; } };
}
const opts = { wait: "150" };

describe("on the cloud host", () => {
  test("no url and no --all: usage line, exit 1, no request", async () => {
    const h = harness();
    expect(await runBrowserSync(undefined, opts, h.deps)).toBe(1);
    expect(h.err[0]).toContain("cast browser sync <site>");
    expect(h.calls.mutations).toEqual([]);
  });
  test("a URL with a path and query sends only its origin, the live port, the conversation and --via", async () => {
    const h = harness({ outcome: { executed_at: 1, result: '{"ok":true,"injected":4,"host":"github.com"}', error: null } });
    expect(await runBrowserSync("https://github.com/settings/tokens?x=1", { ...opts, via: "old-mac" }, h.deps)).toBe(0);
    expect(h.calls.mutations).toEqual([{ api_token: "tok", device_id: "box-device", cdp_port: 37121, origin: "https://github.com", conversation_id: "conv_1", via_device_id: "old-mac" }]);
    expect(JSON.stringify(h.calls.mutations)).not.toContain("tokens");
    expect(h.out.some((l) => l.includes("carried 4 cookies for github.com from your Chrome via mac"))).toBe(true);
    expect(h.out.at(-1)).toContain(DATACENTER_IP_NOTE);
  });
  test("a bare host is https; --all sends all:true and no origin", async () => {
    const h = harness({ outcome: { executed_at: 1, result: '{"ok":true,"injected":0,"host":"every site","reason":"already has the same cookies"}', error: null } });
    expect(await runBrowserSync("github.com", opts, h.deps)).toBe(0);
    expect(h.calls.mutations[0].origin).toBe("https://github.com");
    const all = harness({ outcome: { executed_at: 1, result: '{"ok":true,"injected":0,"host":"every site","reason":"already has the same cookies"}', error: null } });
    expect(await runBrowserSync(undefined, { ...opts, all: true }, all.deps)).toBe(0);
    expect(all.calls.mutations[0]).toEqual({ api_token: "tok", device_id: "box-device", cdp_port: 37121, all: true, conversation_id: "conv_1" });
    expect(all.out.some((l) => l.includes("nothing to carry for every site — already has the same cookies"))).toBe(true);
  });
  test("a site together with --all is refused; a non numeric --wait is refused; neither asks", async () => {
    const both = harness();
    expect(await runBrowserSync("github.com", { ...opts, all: true }, both.deps)).toBe(1);
    expect(both.err[0]).toContain("name a site or --all, not both");
    expect(both.calls.mutations).toEqual([]);
    const typo = harness();
    expect(await runBrowserSync("github.com", { wait: "abc" }, typo.deps)).toBe(1);
    expect(typo.err[0]).toContain("--wait abc is not a number of seconds");
    expect(typo.calls.mutations).toEqual([]);
  });
  test("a Google url exits 0 with OWN_LOGIN_REASON and never asks", async () => {
    const h = harness();
    expect(await runBrowserSync("https://mail.google.com/mail", opts, h.deps)).toBe(0);
    expect(h.out[0]).toContain(OWN_LOGIN_REASON);
    expect(h.out[0]).toContain("no Google account");
    expect(h.calls.mutations).toEqual([]);
    expect(h.calls.order).toEqual([]);
  });
  test("the host's policy refuses before any request; --all is refused under any allowlist", async () => {
    const h = harness({ refuseNavigation: (url, session, via) => ({ message: `refusing to open ${url} — ${url} is not in the site allowlist [${session}/${via}]`, hint: "policy: …" }) });
    expect(await runBrowserSync("gitlab.com", opts, h.deps)).toBe(1);
    expect(h.err[0]).toContain("refusing to carry a login for https://gitlab.com");
    expect(h.err[0]).toContain("[sess-1/sync]");
    expect(h.calls.mutations).toEqual([]);
    const all = harness({ loadSitePolicy: () => ({ sources: [], errors: [] }) });
    expect(await runBrowserSync(undefined, { ...opts, all: true }, all.deps)).toBe(1);
    expect(all.err[0]).toContain("name the site");
    expect(all.calls.mutations).toEqual([]);
  });
  test("ensureBrowser runs BEFORE readState, so the port sent is the live one", async () => {
    const h = harness({ outcome: { executed_at: 1, result: "{}", error: null } });
    await runBrowserSync("github.com", opts, h.deps);
    expect(h.calls.order.slice(0, 2)).toEqual(["ensureBrowser", "readState"]);
  });
  test("'No online laptop' prints the retry line + the datacenter note and exits 1", async () => {
    const h = harness({ mutationError: "[CONVEX M(cloud:requestBrowserSync)] [Request ID: abc] Server Error\nUncaught Error: No online laptop can carry your logins — start the codecast daemon on your laptop (or wake it) and retry\n  at handler (../convex/cloud.ts:400:3)" });
    expect(await runBrowserSync("github.com", opts, h.deps)).toBe(1);
    expect(h.err[0]).toContain("No online laptop can carry your logins");
    expect(h.err[0]).not.toContain("Request ID");
    expect(h.err[1]).toContain("retry once your laptop is awake");
    expect(h.out.at(-1)).toContain(DATACENTER_IP_NOTE);
    expect(h.calls.queries).toBe(0);
  });
  test("a missing server function (old CLI/server pair) names the update", async () => {
    const h = harness({ mutationError: "[CONVEX M(cloud:requestBrowserSync)] Server Error\nCould not find public function for 'cloud:requestBrowserSync'" });
    expect(await runBrowserSync("github.com", opts, h.deps)).toBe(1);
    expect(h.err[0]).toContain("update the host's cast");
  });
  test("an error outcome is explained; a timeout says the request stays valid; --wait 0 returns after asking", async () => {
    const e = harness({ outcome: { executed_at: 1, result: null, error: "expired_ttl" } });
    expect(await runBrowserSync("github.com", opts, e.deps)).toBe(1);
    expect(e.err[0]).toContain("never picked the request up within 5 minutes");
    const t = harness({ outcome: null });
    expect(await runBrowserSync("github.com", { wait: "5" }, t.deps)).toBe(1);
    expect(t.err[0]).toContain("no answer from mac yet");
    expect(t.calls.queries).toBeGreaterThan(1);
    const z = harness();
    expect(await runBrowserSync("github.com", { wait: "0" }, z.deps)).toBe(0);
    expect(z.out[0]).toContain("request cmd_1");
    expect(z.calls.queries).toBe(0);
  });
});

describe("on a laptop", () => {
  test("the body is the old local carry: the mutation is never called", async () => {
    const h = harness({ remote: false });
    expect(await runBrowserSync("github.com", { ...opts, all: true }, h.deps)).toBe(0);
    expect(h.calls.mutations).toEqual([]);
    expect(h.calls.provisions).toEqual([[37121, "https://github.com", { profileDir: "Default", channel: "chrome" }]]);
    expect(h.out.some((l) => l.includes("carried 1 cookie for github.com from your Chrome"))).toBe(true);
    expect(h.out[0]).toContain("ignored here");
  });
  test("no local browser from a profile: the old refusal", async () => {
    const h = harness({ remote: false, readState: () => ({ port: 1, sourceProfile: null, channel: "chrome" } as any) });
    expect(await runBrowserSync(undefined, opts, h.deps)).toBe(1);
    expect(h.err[0]).toContain("no local browser started from your Chrome profile");
  });
});

describe("serverErrorLine", () => {
  test("pulls the server's sentence out of a Convex client error, else the first line", () => {
    expect(serverErrorLine("[CONVEX M(x)] [Request ID: 1] Server Error\nUncaught Error: not your conversation\n  at handler")).toBe("not your conversation");
    expect(serverErrorLine("plain\nsecond")).toBe("plain");
  });
});
