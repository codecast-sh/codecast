// Digest policy tests. The eligibility cases are ported from codecast's
// emails/digest.test.ts; the sweep cases exercise the injected hook seam
// that replaces codecast's inline Convex reads and writes.

import { describe, expect, test } from "bun:test";
import {
  ACTIVE_MS,
  COOLDOWN_MS,
  DEFAULT_DIGEST_POLICY,
  GRACE_MS,
  MAX_LOOKBACK_MS,
  WINDOW_MS,
  createEntryCapper,
  digestEligible,
  digestRange,
  generateUnsubscribeToken,
  isValidUnsubscribeToken,
  listUnsubscribeHeaders,
  runDigestSweep,
  sweepWindow,
  unsubscribeByToken,
  type DigestRecipient,
  type DigestSweepHooks,
} from "./policy";

const NOW = 1_800_000_000_000;

describe("digestEligible", () => {
  test("unsubscribed never sends", () => {
    expect(
      digestEligible({ emailPref: false, lastSentAt: undefined, lastInputAt: undefined, now: NOW })
        .send,
    ).toBe(false);
  });
  test("absent preference reads as on", () => {
    expect(
      digestEligible({ emailPref: undefined, lastSentAt: undefined, lastInputAt: undefined, now: NOW })
        .send,
    ).toBe(true);
  });
  test("recent keyboard input suppresses", () => {
    const r = digestEligible({
      emailPref: true,
      lastSentAt: undefined,
      lastInputAt: NOW - ACTIVE_MS + 1000,
      now: NOW,
    });
    expect(r).toEqual({ send: false, reason: "active" });
  });
  test("input older than ACTIVE_MS does not suppress", () => {
    expect(
      digestEligible({
        emailPref: true,
        lastSentAt: undefined,
        lastInputAt: NOW - ACTIVE_MS - 1000,
        now: NOW,
      }).send,
    ).toBe(true);
  });
  test("cooldown suppresses a second digest", () => {
    const r = digestEligible({
      emailPref: true,
      lastSentAt: NOW - COOLDOWN_MS + 60_000,
      lastInputAt: undefined,
      now: NOW,
    });
    expect(r).toEqual({ send: false, reason: "cooldown" });
  });
  test("cooldown elapsed allows", () => {
    expect(
      digestEligible({
        emailPref: true,
        lastSentAt: NOW - COOLDOWN_MS - 1,
        lastInputAt: undefined,
        now: NOW,
      }).send,
    ).toBe(true);
  });
});

describe("windows", () => {
  test("sweep window scans [now-WINDOW, now-GRACE]", () => {
    expect(sweepWindow(NOW)).toEqual({ from: NOW - WINDOW_MS, to: NOW - GRACE_MS });
  });
  test("digest range starts at the last send", () => {
    expect(digestRange(NOW - 60_000, NOW)).toEqual({
      since: NOW - 60_000,
      cutoff: NOW - GRACE_MS,
    });
  });
  test("first ever digest is bounded by max lookback", () => {
    expect(digestRange(undefined, NOW).since).toBe(NOW - MAX_LOOKBACK_MS);
  });
});

describe("entry capper", () => {
  test("caps each list and accumulates the more count", () => {
    const cap = createEntryCapper(2);
    expect(cap.take([1, 2, 3, 4])).toEqual([1, 2]);
    expect(cap.take([5])).toEqual([5]);
    expect(cap.take([6, 7, 8])).toEqual([6, 7]);
    expect(cap.moreCount()).toBe(3);
  });
});

describe("unsubscribe token", () => {
  test("generated tokens are 32 lowercase alphanumerics and unique", () => {
    const a = generateUnsubscribeToken();
    const b = generateUnsubscribeToken();
    expect(a).toMatch(/^[a-z0-9]{32}$/);
    expect(a).not.toBe(b);
    expect(isValidUnsubscribeToken(a)).toBe(true);
  });

  test("short tokens are rejected before any lookup", async () => {
    let lookups = 0;
    const r = await unsubscribeByToken("short", {
      lookup: async () => {
        lookups++;
        return { id: "u1" };
      },
      apply: async () => {},
    });
    expect(r).toEqual({ ok: false });
    expect(lookups).toBe(0);
  });

  test("unknown token returns ok:false, known token applies the opt out", async () => {
    const applied: string[] = [];
    const hooks = {
      lookup: async (token: string) => (token === "k".repeat(32) ? { id: "u1" } : null),
      apply: async (id: string) => {
        applied.push(id);
      },
    };
    expect(await unsubscribeByToken("x".repeat(32), hooks)).toEqual({ ok: false });
    expect(await unsubscribeByToken("k".repeat(32), hooks)).toEqual({ ok: true });
    expect(applied).toEqual(["u1"]);
  });

  test("one click headers follow RFC 8058", () => {
    expect(listUnsubscribeHeaders("https://x/unsub?token=t")).toEqual({
      "List-Unsubscribe": "<https://x/unsub?token=t>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});

describe("runDigestSweep", () => {
  interface FakeUser extends DigestRecipient {
    digest?: string | null;
  }

  function makeHooks(users: FakeUser[], candidateIds: string[]) {
    const log: string[] = [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const hooks: DigestSweepHooks<string> = {
      candidates: async (w) => {
        log.push(`candidates ${w.from}..${w.to}`);
        return candidateIds;
      },
      recipient: async (id) => byId.get(id) ?? null,
      build: async (r, range) => {
        log.push(`build ${r.id} since=${range.since} cutoff=${range.cutoff}`);
        const u = byId.get(r.id)!;
        return u.digest === undefined ? `digest-for-${r.id}` : u.digest;
      },
      saveToken: async (id, token) => {
        log.push(`saveToken ${id} ${token.length}`);
        byId.get(id)!.unsubToken = token;
      },
      markSent: async (id, at) => {
        log.push(`markSent ${id} ${at}`);
      },
      send: async (r, digest, token) => {
        log.push(`send ${r.id} ${digest} ${token}`);
      },
    };
    return { hooks, log };
  }

  test("filters ineligible recipients and sends to the rest", async () => {
    const users: FakeUser[] = [
      { id: "ok", email: "ok@x.co" },
      { id: "noemail" },
      { id: "unsub", email: "u@x.co", emailPref: false },
      { id: "active", email: "a@x.co", lastInputAt: NOW - 1000 },
      { id: "cooldown", email: "c@x.co", lastSentAt: NOW - COOLDOWN_MS + 1000 },
      { id: "empty", email: "e@x.co", digest: null },
    ];
    const { hooks, log } = makeHooks(users, users.map((u) => u.id));
    const r = await runDigestSweep(hooks, NOW);

    expect(r).toEqual({ candidates: 6, sent: 1 });
    expect(log.filter((l) => l.startsWith("send"))).toEqual([
      `send ok digest-for-ok ${users[0].unsubToken}`,
    ]);
    // The empty digest ran build but nothing after.
    expect(log.some((l) => l.startsWith("build empty"))).toBe(true);
    expect(log.some((l) => l.startsWith("markSent empty"))).toBe(false);
  });

  test("mints a token once and reuses an existing one", async () => {
    const users: FakeUser[] = [
      { id: "new", email: "n@x.co" },
      { id: "old", email: "o@x.co", unsubToken: "existingtokenexistingtoken" },
    ];
    const { hooks, log } = makeHooks(users, ["new", "old"]);
    await runDigestSweep(hooks, NOW);

    expect(log.filter((l) => l.startsWith("saveToken"))).toEqual(["saveToken new 32"]);
    expect(log).toContain("send old digest-for-old existingtokenexistingtoken");
  });

  test("marks sent before delivering, so a failed send never double emails", async () => {
    const users: FakeUser[] = [{ id: "u", email: "u@x.co" }];
    const { hooks, log } = makeHooks(users, ["u"]);
    await runDigestSweep(hooks, NOW);
    const sentAt = log.findIndex((l) => l.startsWith("markSent u"));
    const deliveredAt = log.findIndex((l) => l.startsWith("send u"));
    expect(sentAt).toBeGreaterThan(-1);
    expect(sentAt).toBeLessThan(deliveredAt);
  });

  test("dedupes candidates and bounds one sweep's work", async () => {
    const users: FakeUser[] = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@x.co`,
    }));
    const { hooks, log } = makeHooks(users, ["u0", "u0", "u1", "u2", "u3", "u4"]);
    const r = await runDigestSweep(hooks, NOW, { ...DEFAULT_DIGEST_POLICY, maxUsersPerSweep: 3 });

    expect(r.candidates).toBe(5);
    expect(r.sent).toBe(3);
    expect(log.filter((l) => l.startsWith("send")).length).toBe(3);
  });

  test("build receives the range anchored at the recipient's last send", async () => {
    const users: FakeUser[] = [{ id: "u", email: "u@x.co", lastSentAt: NOW - COOLDOWN_MS - 5000 }];
    const { hooks, log } = makeHooks(users, ["u"]);
    await runDigestSweep(hooks, NOW);
    expect(log).toContain(`build u since=${NOW - COOLDOWN_MS - 5000} cutoff=${NOW - GRACE_MS}`);
  });
});
