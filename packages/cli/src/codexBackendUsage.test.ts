import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CODEX_BACKEND_USAGE_URL,
  CodexUsageHttpError,
  codexBackendAuthHeaders,
  fetchCodexBackendUsage,
  mergeCodexUsage,
  nextUsageRetry,
  parseBackendUsageResponse,
  parseRetryAfter,
} from "./codexBackendUsage";

const NOW = Date.parse("2026-09-07T12:00:00Z");

function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "codex", name), "utf-8"));
}

/** A Response stand-in: bun's fetch types want the whole surface, and these
 *  tests only ever read ok/status/headers/json. */
function response(opts: { status?: number; body?: any; headers?: Record<string, string> }): any {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(opts.headers ?? {}),
    json: async () => opts.body,
  };
}

describe("codexBackendAuthHeaders", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-backend-test-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function writeAuth(tokens: any) {
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens }));
  }

  it("sends the request Codex itself sends, account id included", () => {
    writeAuth({ access_token: "at-1", account_id: "acct-1" });
    expect(codexBackendAuthHeaders(home)).toEqual({
      Authorization: "Bearer at-1",
      "User-Agent": "codex-cli",
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
      "ChatGPT-Account-Id": "acct-1",
    });
  });

  it("omits the account header when auth.json names no account", () => {
    writeAuth({ access_token: "at-1" });
    expect(codexBackendAuthHeaders(home)!["ChatGPT-Account-Id"]).toBeUndefined();
  });

  it("returns null for a missing, unparseable, or token-less home", () => {
    expect(codexBackendAuthHeaders(path.join(home, "nope"))).toBeNull();
    fs.writeFileSync(path.join(home, "auth.json"), "not json");
    expect(codexBackendAuthHeaders(home)).toBeNull();
    writeAuth({ account_id: "acct-1" }); // API-key login: no access token
    expect(codexBackendAuthHeaders(home)).toBeNull();
  });

  it("reads the account whose home it was given, not the machine's login", () => {
    writeAuth({ access_token: "active", account_id: "acct-active" });
    const dormant = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dormant-"));
    fs.writeFileSync(
      path.join(dormant, "auth.json"),
      JSON.stringify({ tokens: { access_token: "dormant", account_id: "acct-dormant" } }),
    );
    try {
      expect(codexBackendAuthHeaders(dormant)!.Authorization).toBe("Bearer dormant");
      expect(codexBackendAuthHeaders(dormant)!["ChatGPT-Account-Id"]).toBe("acct-dormant");
    } finally {
      fs.rmSync(dormant, { recursive: true, force: true });
    }
  });
});

describe("parseBackendUsageResponse", () => {
  it("classifies the recorded pro response by window duration", () => {
    const snap = parseBackendUsageResponse(fixture("wham-usage-pro.json"), NOW)!;
    expect(snap.plan_type).toBe("pro");
    // 18000s = 300 min → the session bar; 604800s = 10080 min → the weekly one.
    expect(snap.session).toEqual({ percent: 37.5, resets_at: 1786011679 * 1000 });
    expect(snap.weekly).toEqual({ percent: 61.2, resets_at: 1786443679 * 1000 });
    expect(snap.reset_credits).toEqual({ available: 2 });
    expect(snap.fetched_at).toBe(NOW);
  });

  // A verbatim recording from a live Pro account (2026-09-07). It is why the
  // duration decides and position only breaks ties: this plan reports its
  // WEEKLY bucket as the primary window and nothing as the secondary, so
  // reading position first would paint a week's usage into the five-hour bar.
  it("routes a weekly-length primary window to the weekly bar, leaving session blank", () => {
    const snap = parseBackendUsageResponse(fixture("wham-usage-weekly-only.json"), NOW)!;
    expect(snap.plan_type).toBe("pro");
    expect(snap.weekly).toEqual({ percent: 3, resets_at: 1789396452 * 1000 });
    expect(snap.session).toBeUndefined();
    // available_count 0 is "no offer", not an offer of nothing.
    expect(snap.reset_credits).toBeUndefined();
  });

  it("falls back to position when a duration is unknown", () => {
    const snap = parseBackendUsageResponse(
      {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 5 },
          secondary_window: { used_percent: 50, limit_window_seconds: 0 },
        },
      },
      NOW,
    )!;
    expect(snap.session?.percent).toBe(5);
    expect(snap.weekly?.percent).toBe(50);
  });

  it("tolerates the one-minute drift older buckets report", () => {
    const snap = parseBackendUsageResponse(
      {
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 5, limit_window_seconds: 299 * 60 },
          secondary_window: { used_percent: 50, limit_window_seconds: 10081 * 60 },
        },
      },
      NOW,
    )!;
    expect(snap.session?.percent).toBe(5);
    expect(snap.weekly?.percent).toBe(50);
  });

  it("refuses a body with no plan type — a redirect is not a reading", () => {
    expect(parseBackendUsageResponse({ rate_limit: { primary_window: { used_percent: 9 } } }, NOW)).toBeNull();
    expect(parseBackendUsageResponse(null, NOW)).toBeNull();
    expect(parseBackendUsageResponse("<html>", NOW)).toBeNull();
  });

  it("drops a zero credit balance rather than showing an empty offer", () => {
    const snap = parseBackendUsageResponse(
      { plan_type: "pro", rate_limit: {}, rate_limit_reset_credits: { available_count: 0 } },
      NOW,
    )!;
    expect(snap.reset_credits).toBeUndefined();
  });
});

describe("fetchCodexBackendUsage", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-backend-fetch-"));
    fs.writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "at-1", account_id: "acct-1" } }),
    );
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("GETs the wham endpoint with the auth headers and parses the body", async () => {
    let seen: any;
    const snap = await fetchCodexBackendUsage(home, {
      now: NOW,
      fetchImpl: (async (url: any, init: any) => {
        seen = { url, init };
        return response({ body: fixture("wham-usage-pro.json") });
      }) as any,
    });
    expect(seen.url).toBe(CODEX_BACKEND_USAGE_URL);
    expect(seen.init.headers.Authorization).toBe("Bearer at-1");
    expect(seen.init.headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(snap!.session?.percent).toBe(37.5);
  });

  it("never leaves the machine for a home with no token", async () => {
    let called = false;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
    try {
      const snap = await fetchCodexBackendUsage(empty, {
        fetchImpl: (async () => {
          called = true;
          return response({ body: {} });
        }) as any,
      });
      expect(snap).toBeNull();
      expect(called).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("throws a typed refusal, carrying the wait a 429 named", async () => {
    const err = await fetchCodexBackendUsage(home, {
      now: NOW,
      fetchImpl: (async () => response({ status: 429, headers: { "retry-after": "120" } })) as any,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CodexUsageHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it("reads no wait from a non-429 refusal", async () => {
    const err = await fetchCodexBackendUsage(home, {
      now: NOW,
      fetchImpl: (async () => response({ status: 500, headers: { "retry-after": "120" } })) as any,
    }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
  });

  it("ignores what it cannot use: absent, garbage, or already past", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("  ", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("0", NOW)).toBeUndefined();
    expect(parseRetryAfter(new Date(NOW - 1000).toUTCString(), NOW)).toBeUndefined();
  });

  it("caps a hostile wait at a day", () => {
    expect(parseRetryAfter("99999999", NOW)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("nextUsageRetry", () => {
  it("doubles the wait per consecutive failure, capped at 15 minutes", () => {
    let state = nextUsageRetry(undefined, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(30_000);
    expect(state.failures).toBe(1);
    state = nextUsageRetry(state, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(60_000);
    for (let i = 0; i < 10; i++) state = nextUsageRetry(state, new Error("boom"), NOW);
    expect(state.retry_at - NOW).toBe(15 * 60 * 1000);
  });

  it("prefers the wait the server named over its own backoff", () => {
    const state = nextUsageRetry(
      { retry_at: 0, failures: 4, reason: "x", failed_at: 0 },
      new CodexUsageHttpError(429, 5_000),
      NOW,
    );
    expect(state.retry_at).toBe(NOW + 5_000);
    expect(state.retry_after).toBe(true);
    expect(state.status).toBe(429);
  });

  it("records the status of a refusal that named no wait", () => {
    const state = nextUsageRetry(undefined, new CodexUsageHttpError(503), NOW);
    expect(state.retry_at).toBe(NOW + 30_000);
    expect(state.status).toBe(503);
    expect(state.retry_after).toBeUndefined();
  });
});

describe("mergeCodexUsage", () => {
  const rpc = { fetched_at: NOW, weekly: { percent: 61 }, plan_type: "pro" };
  const backend = {
    fetched_at: NOW + 1,
    session: { percent: 37 },
    weekly: { percent: 99 },
    plan_type: "plus",
    reset_credits: { available: 2 },
  };

  it("fills the app-server's holes and overrides nothing it filled", () => {
    const merged = mergeCodexUsage(rpc, backend)!;
    expect(merged.session).toEqual({ percent: 37 });
    expect(merged.weekly).toEqual({ percent: 61 }); // the RPC spoke; it wins
    expect(merged.plan_type).toBe("pro");
    expect(merged.reset_credits).toEqual({ available: 2 });
    expect(merged.fetched_at).toBe(NOW);
  });

  it("stands in for a missing source on either side", () => {
    expect(mergeCodexUsage(null, backend)).toBe(backend);
    expect(mergeCodexUsage(rpc, null)).toBe(rpc);
    expect(mergeCodexUsage(null, null)).toBeNull();
  });
});
