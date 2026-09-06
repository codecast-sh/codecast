import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CODEX_RESET_CREDITS_CONSUME_URL,
  CODEX_RESET_CREDITS_URL,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  offerRevision,
  parseResetCreditsResponse,
  readResetCreditLedger,
  redeemCodexResetCredit,
  resetCreditLedgerPath,
  writeResetCreditLedger,
  type ResetCreditOffer,
  type ResetCreditOutcome,
} from "./codexResetCredit.js";
import { CodexUsageHttpError } from "./codexBackendUsage.js";

// Nothing in this file may reach the network. Every fetch is a fake that
// records what it was asked and answers from a fixture — a real POST here would
// spend one of the developer's actual reset credits.
// The ledger tests publish through a real fsynced atomic write. On a loaded
// machine one of those can take seconds, so the whole file gets a longer leash
// than bun's five-second default rather than going flaky.
setDefaultTimeout(60_000);

let sandbox: string;
let codexHome: string;
const prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reset-credit-"));
  codexHome = path.join(sandbox, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "tok", account_id: "acct-1" } }),
  );
  for (const key of ["HOME", "CODECAST_DIR"]) prevEnv[key] = process.env[key];
  process.env.HOME = sandbox;
  process.env.CODECAST_DIR = path.join(sandbox, ".codecast");
  fs.mkdirSync(process.env.CODECAST_DIR, { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OFFER_BODY = {
  available_count: 1,
  total_earned_count: 3,
  credits: [
    { status: "available", expires_at: "2026-09-20T00:00:00Z", granted_at: "2026-09-01T00:00:00Z" },
    { status: "redeemed", expires_at: null, granted_at: "2026-08-01T00:00:00Z" },
  ],
};

/** A fake fetch that answers the GET with `offer` and the POST with `code`,
 *  recording every request for assertions. */
function fakeBackend(opts: { offer?: any; code?: ResetCreditOutcome; postStatus?: number }) {
  const calls: Array<{ url: string; body?: any }> = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(init.body) : undefined });
    if (href === CODEX_RESET_CREDITS_URL) return jsonResponse(opts.offer ?? OFFER_BODY);
    if (href === CODEX_RESET_CREDITS_CONSUME_URL) {
      if (opts.postStatus && opts.postStatus >= 400) {
        return jsonResponse({ detail: "nope" }, opts.postStatus);
      }
      return jsonResponse({ code: opts.code ?? "reset" });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseResetCreditsResponse", () => {
  it("reads the balance, normalizes timestamps and picks the soonest expiry", () => {
    const offer = parseResetCreditsResponse(OFFER_BODY)!;
    expect(offer.available).toBe(1);
    expect(offer.total_earned).toBe(3);
    expect(offer.credits[0].granted_at).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(offer.next_expires_at).toBe(Date.parse("2026-09-20T00:00:00Z"));
  });

  it("normalizes epoch seconds and milliseconds alike", () => {
    const offer = parseResetCreditsResponse({
      available_count: 1,
      credits: [{ status: "AVAILABLE", expires_at: 1_790_000_000, granted_at: 1_790_000_000_000 }],
    })!;
    expect(offer.credits[0].status).toBe("available");
    expect(offer.credits[0].expires_at).toBe(1_790_000_000_000);
    expect(offer.credits[0].granted_at).toBe(1_790_000_000_000);
    expect(offer.next_expires_at).toBe(1_790_000_000_000);
  });

  it("counts available rows when the endpoint sends no count", () => {
    const offer = parseResetCreditsResponse({
      credits: [{ status: "available" }, { status: "available" }, { status: "expired" }],
    })!;
    expect(offer.available).toBe(2);
  });

  it("returns null for a body that is not a credits reading", () => {
    expect(parseResetCreditsResponse(null)).toBeNull();
    expect(parseResetCreditsResponse({ detail: "sign in" })).toBeNull();
  });
});

describe("offerRevision", () => {
  const offer: ResetCreditOffer = {
    available: 1,
    total_earned: 3,
    next_expires_at: 1_790_000_000_000,
    credits: [{ status: "available", expires_at: 1_790_000_000_000, granted_at: null }],
  };

  it("is stable across credit-row ordering", () => {
    const shuffled: ResetCreditOffer = {
      ...offer,
      credits: [
        { status: "expired", expires_at: 1, granted_at: null },
        offer.credits[0],
      ],
    };
    const other: ResetCreditOffer = {
      ...offer,
      credits: [offer.credits[0], { status: "expired", expires_at: 1, granted_at: null }],
    };
    expect(offerRevision(shuffled)).toBe(offerRevision(other));
  });

  it("moves when the balance moves", () => {
    expect(offerRevision({ ...offer, available: 2 })).not.toBe(offerRevision(offer));
  });

  it("moves when the usage windows move", () => {
    const a = offerRevision(offer, { session: { percent: 100, resets_at: 10 } });
    const b = offerRevision(offer, { session: { percent: 0, resets_at: 10 } });
    expect(a).not.toBe(b);
    expect(a).not.toBe(offerRevision(offer));
  });

  it("is a bounded v1 token no matter how many rows the account has", () => {
    const many: ResetCreditOffer = {
      ...offer,
      credits: Array.from({ length: 500 }, (_, i) => ({
        status: "expired",
        expires_at: i,
        granted_at: i,
      })),
    };
    expect(offerRevision(many)).toMatch(/^v1:[0-9a-f]{32}$/);
  });
});

describe("fetchCodexResetCredits", () => {
  it("sends Codex's own headers for the home it was handed", async () => {
    const { fetchImpl, calls } = fakeBackend({});
    const offer = await fetchCodexResetCredits(codexHome, { fetchImpl });
    expect(offer?.available).toBe(1);
    expect(calls[0].url).toBe(CODEX_RESET_CREDITS_URL);
  });

  it("returns null when the home holds no token", async () => {
    const empty = path.join(sandbox, "empty");
    fs.mkdirSync(empty);
    const { fetchImpl, calls } = fakeBackend({});
    expect(await fetchCodexResetCredits(empty, { fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws CodexUsageHttpError when the endpoint refuses", async () => {
    const fetchImpl = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    await expect(fetchCodexResetCredits(codexHome, { fetchImpl })).rejects.toBeInstanceOf(
      CodexUsageHttpError,
    );
  });
});

describe("consumeCodexResetCredit", () => {
  for (const code of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const) {
    it(`maps the "${code}" outcome`, async () => {
      const { fetchImpl, calls } = fakeBackend({ code });
      expect(await consumeCodexResetCredit(codexHome, "key-1", { fetchImpl })).toBe(code);
      expect(calls[0].url).toBe(CODEX_RESET_CREDITS_CONSUME_URL);
      expect(calls[0].body).toEqual({ redeem_request_id: "key-1" });
    });
  }

  it("refuses an unknown outcome code rather than calling it harmless", async () => {
    const fetchImpl = (async () => jsonResponse({ code: "shrug" })) as unknown as typeof fetch;
    await expect(consumeCodexResetCredit(codexHome, "key-1", { fetchImpl })).rejects.toThrow(
      /Unknown Codex reset outcome/,
    );
  });

  it("requires a redeem request id", async () => {
    const { fetchImpl } = fakeBackend({});
    await expect(consumeCodexResetCredit(codexHome, "  ", { fetchImpl })).rejects.toThrow(
      /required/,
    );
  });
});

describe("the ledger", () => {
  it("starts empty and round-trips", () => {
    expect(readResetCreditLedger()).toEqual({ version: 1, attempts: [] });
    writeResetCreditLedger({
      version: 1,
      attempts: [
        { key: "k", account: "acct-1", offer_revision: "v1:x", state: "settled", outcome: "reset", at: 1 },
      ],
    });
    expect(readResetCreditLedger().attempts[0].outcome).toBe("reset");
  });

  it("fails closed on a corrupt file instead of reminting keys", () => {
    fs.writeFileSync(resetCreditLedgerPath(), JSON.stringify({ version: 1, attempts: [{ key: 1 }] }));
    expect(() => readResetCreditLedger()).toThrow(/corrupt/);
  });

  it("keeps the file bounded", () => {
    writeResetCreditLedger({
      version: 1,
      attempts: Array.from({ length: 500 }, (_, i) => ({
        key: `k${i}`,
        account: "acct-1",
        offer_revision: `v1:${i}`,
        state: "settled" as const,
        outcome: "reset" as const,
        at: i,
      })),
    });
    const kept = readResetCreditLedger().attempts;
    expect(kept).toHaveLength(200);
    expect(kept[kept.length - 1].key).toBe("k499");
  });
});

describe("redeemCodexResetCredit", () => {
  const account = "acct-1";

  it("spends a credit and records the outcome under the key it sent", async () => {
    const { fetchImpl, calls } = fakeBackend({ code: "reset" });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl,
      newKey: () => "key-1",
      now: 1000,
    });
    expect(result).toMatchObject({ status: "redeemed", outcome: "reset", key: "key-1", replayed: false });
    expect(calls[1].body).toEqual({ redeem_request_id: "key-1" });
    const attempts = readResetCreditLedger().attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ key: "key-1", account, state: "settled", outcome: "reset" });
  });

  for (const code of ["nothing_to_reset", "no_credit", "already_redeemed"] as const) {
    it(`settles a "${code}" answer without leaving the attempt pending`, async () => {
      const { fetchImpl } = fakeBackend({ code });
      const result = await redeemCodexResetCredit({
        account,
        codexHomeDir: codexHome,
        fetchImpl,
        newKey: () => "key-1",
      });
      expect(result).toMatchObject({ status: "redeemed", outcome: code });
      expect(readResetCreditLedger().attempts[0].state).toBe("settled");
    });
  }

  it("refuses before the provider call when the account has no credit", async () => {
    const { fetchImpl, calls } = fakeBackend({ offer: { available_count: 0, credits: [] } });
    const result = await redeemCodexResetCredit({ account, codexHomeDir: codexHome, fetchImpl });
    expect(result).toMatchObject({ status: "refused", reason: "no_offer" });
    expect(calls.map((c) => c.url)).toEqual([CODEX_RESET_CREDITS_URL]);
    expect(readResetCreditLedger().attempts).toHaveLength(0);
  });

  it("refuses before the provider call when the offer moved under the confirmation", async () => {
    const { fetchImpl, calls } = fakeBackend({});
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl,
      expectedRevision: "v1:from-ten-minutes-ago",
    });
    expect(result).toMatchObject({ status: "refused", reason: "stale_offer" });
    expect(calls.map((c) => c.url)).toEqual([CODEX_RESET_CREDITS_URL]);
  });

  it("accepts a confirmation whose revision still matches the live offer", async () => {
    const { fetchImpl } = fakeBackend({});
    const offer = await fetchCodexResetCredits(codexHome, { fetchImpl });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl,
      expectedRevision: offerRevision(offer!),
      newKey: () => "key-1",
    });
    expect(result).toMatchObject({ status: "redeemed", outcome: "reset" });
  });

  it("refuses a second redeem of the same offer", async () => {
    const first = fakeBackend({ code: "reset" });
    await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: first.fetchImpl,
      newKey: () => "key-1",
    });
    const second = fakeBackend({ code: "reset" });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: second.fetchImpl,
      newKey: () => "key-2",
    });
    expect(result).toMatchObject({ status: "refused", reason: "offer_spent" });
    expect(second.calls.map((c) => c.url)).toEqual([CODEX_RESET_CREDITS_URL]);
  });

  it("lets a NEW offer through after an earlier one settled", async () => {
    const first = fakeBackend({ code: "reset" });
    await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: first.fetchImpl,
      newKey: () => "key-1",
    });
    const second = fakeBackend({
      code: "reset",
      offer: { available_count: 1, credits: [{ status: "available", granted_at: 5 }] },
    });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: second.fetchImpl,
      newKey: () => "key-2",
    });
    expect(result).toMatchObject({ status: "redeemed", key: "key-2" });
  });

  it("replays the original key after a crash mid-flight, never a second one", async () => {
    // The POST throws, so the attempt stays pending with an unknown outcome.
    const crashed = fakeBackend({ postStatus: 502 });
    await expect(
      redeemCodexResetCredit({
        account,
        codexHomeDir: codexHome,
        fetchImpl: crashed.fetchImpl,
        newKey: () => "key-1",
      }),
    ).rejects.toBeInstanceOf(CodexUsageHttpError);
    expect(readResetCreditLedger().attempts[0]).toMatchObject({ key: "key-1", state: "pending" });

    // The retry re-sends the SAME redeem_request_id, so the provider dedupes and
    // one credit is spent in total.
    const retry = fakeBackend({ code: "already_redeemed" });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: retry.fetchImpl,
      newKey: () => "key-2",
    });
    expect(result).toMatchObject({ status: "redeemed", outcome: "already_redeemed", key: "key-1", replayed: true });
    expect(retry.calls[1].body).toEqual({ redeem_request_id: "key-1" });
    expect(readResetCreditLedger().attempts).toHaveLength(1);
  });

  it("replays a pending key even when the account now shows no credit", async () => {
    const crashed = fakeBackend({ postStatus: 502 });
    await expect(
      redeemCodexResetCredit({
        account,
        codexHomeDir: codexHome,
        fetchImpl: crashed.fetchImpl,
        newKey: () => "key-1",
      }),
    ).rejects.toBeInstanceOf(CodexUsageHttpError);

    const retry = fakeBackend({ code: "already_redeemed", offer: { available_count: 0, credits: [] } });
    const result = await redeemCodexResetCredit({
      account,
      codexHomeDir: codexHome,
      fetchImpl: retry.fetchImpl,
    });
    expect(result).toMatchObject({ status: "redeemed", key: "key-1", replayed: true });
  });

  it("collapses two concurrent redeems for one account into one spend", async () => {
    // The file ledger only protects across restarts: without the in-process
    // gate both calls would read "no pending attempt" and mint their own id.
    const { fetchImpl, calls } = fakeBackend({ code: "reset" });
    let minted = 0;
    const newKey = () => `key-${++minted}`;
    const [a, b] = await Promise.all([
      redeemCodexResetCredit({ account, codexHomeDir: codexHome, fetchImpl, newKey }),
      redeemCodexResetCredit({ account, codexHomeDir: codexHome, fetchImpl, newKey }),
    ]);
    expect(a).toEqual(b);
    const ids = calls.filter((c) => c.body).map((c) => c.body.redeem_request_id);
    expect(ids).toEqual(["key-1"]);
    expect(readResetCreditLedger().attempts).toHaveLength(1);
  });

  it("refuses a home with no login without calling anything", async () => {
    const empty = path.join(sandbox, "empty");
    fs.mkdirSync(empty);
    const { fetchImpl, calls } = fakeBackend({});
    const result = await redeemCodexResetCredit({ account, codexHomeDir: empty, fetchImpl });
    expect(result).toMatchObject({ status: "refused", reason: "signed_out" });
    expect(calls).toHaveLength(0);
  });
});
