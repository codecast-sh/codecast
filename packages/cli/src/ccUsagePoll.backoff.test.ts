import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { invalidateAccountsCache, readUsageCache } from "./ccAccounts.js";
import { refreshUsageSnapshots } from "./ccUsagePoll.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";

describe("refreshUsageSnapshots backoff (isolated CODECAST_DIR, injected fetch)", () => {
  const NOW = 1_781_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  let home: string;
  let sandbox: IsolatedCodecastDir;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backoff-test-"));
    sandbox = isolateCodecastDir("cc-backoff-dir-");
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    // One account: the machine's active login, with a credential live enough to
    // probe. No saved profiles, so each pass makes exactly one usage request.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "at-active", refreshToken: "rt", expiresAt: NOW + 8 * 3600_000, subscriptionType: "max" },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@x.com" } }),
    );
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sandbox.restore();
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  /** A usage endpoint that answers `replies` in order, repeating the last. */
  const server = (...replies: Array<number | { status: number; retryAfter?: string }>) => {
    let served = 0;
    const fetchImpl = (async () => {
      const raw = replies[Math.min(served, replies.length - 1)];
      served++;
      const r = typeof raw === "number" ? { status: raw, retryAfter: undefined } : raw;
      if (r.status === 200) {
        return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 12 }] }), { status: 200 });
      }
      return new Response("refused", {
        status: r.status,
        headers: r.retryAfter ? { "Retry-After": r.retryAfter } : {},
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, served: () => served };
  };

  const retryState = () => readUsageCache().retries?.["uuid-a"];

  it("holds the poll off for the seconds a 429 named, then probes again", async () => {
    const s = server({ status: 429, retryAfter: "120" }, 200);
    const first = await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(first.failed).toEqual([{ name: "active", reason: "usage endpoint 429" }]);
    expect(retryState()).toMatchObject({ retry_at: NOW + 120_000, failures: 1, status: 429, retry_after: true });

    // Inside the window the account is skipped without a request.
    const held = await refreshUsageSnapshots({ now: NOW + 119_000, fetchImpl: s.fetchImpl });
    expect(held.skipped).toEqual(["active"]);
    expect(s.served()).toBe(1);

    // At the named time it is asked again, and success clears the state.
    const after = await refreshUsageSnapshots({ now: NOW + 120_000, fetchImpl: s.fetchImpl });
    expect(after.probed).toEqual(["active"]);
    expect(retryState()).toBeUndefined();
    expect(readUsageCache().accounts["uuid-a"]?.session?.percent).toBe(12);
  });

  it("reads a 429's Retry-After given as an HTTP date", async () => {
    const s = server({ status: 429, retryAfter: new Date(NOW + 45 * 60_000).toUTCString() });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()).toMatchObject({ retry_at: NOW + 45 * 60_000, retry_after: true });
  });

  it("caps a preposterous Retry-After at 24h", async () => {
    const s = server({ status: 429, retryAfter: "999999999" });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()?.retry_at).toBe(NOW + DAY);
  });

  it("falls back to its own backoff for a 429 with no usable header", async () => {
    const s = server({ status: 429, retryAfter: "whenever" });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()).toMatchObject({ retry_at: NOW + 30_000, status: 429 });
    expect(retryState()?.retry_after).toBeUndefined();
  });

  it("doubles the wait on repeated 500s and caps it at 15 minutes", async () => {
    const s = server(500);
    const waits: number[] = [];
    let now = NOW;
    for (let i = 0; i < 7; i++) {
      const res = await refreshUsageSnapshots({ now, fetchImpl: s.fetchImpl });
      expect(res.failed).toHaveLength(1);
      const state = retryState()!;
      waits.push(state.retry_at - now);
      now = state.retry_at;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(s.served()).toBe(7);
    expect(retryState()).toMatchObject({ failures: 7, reason: "usage endpoint 500" });
  });

  it("keeps the last good snapshot through failures and resets the streak on recovery", async () => {
    const ok = server(200);
    await refreshUsageSnapshots({ now: NOW, fetchImpl: ok.fetchImpl });
    const good = readUsageCache().accounts["uuid-a"];
    expect(good?.fetched_at).toBe(NOW);

    const bad = server(503);
    let now = NOW + 10 * 60_000;
    for (let i = 0; i < 3; i++) {
      await refreshUsageSnapshots({ now, fetchImpl: bad.fetchImpl });
      now = retryState()!.retry_at;
    }
    expect(retryState()?.failures).toBe(3);
    // Why: a meter that flapped to empty on a transient failure would read as
    // headroom, and auto-switch would send sessions to a spent account.
    expect(readUsageCache().accounts["uuid-a"]).toEqual(good!);

    const back = server(200, 500);
    await refreshUsageSnapshots({ now, fetchImpl: back.fetchImpl });
    expect(retryState()).toBeUndefined();
    // The next failure starts the ladder over rather than resuming at 8x.
    await refreshUsageSnapshots({ now: now + 10 * 60_000, fetchImpl: back.fetchImpl });
    expect(retryState()).toMatchObject({ failures: 1, retry_at: now + 10 * 60_000 + 30_000 });
  });

  it("lets a human refresh through the backoff", async () => {
    const s = server({ status: 429, retryAfter: "3600" }, 200);
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    // minIntervalMs 0 is the web's refresh button, not the timer.
    const forced = await refreshUsageSnapshots({ now: NOW + 1000, minIntervalMs: 0, fetchImpl: s.fetchImpl });
    expect(forced.probed).toEqual(["active"]);
    expect(s.served()).toBe(2);
  });
});
