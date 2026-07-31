import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  prettyCodexModel,
  snapshotFromRateLimits,
  parseRateLimitsReadResult,
  refreshCodexUsageSnapshot,
  scanRolloutText,
  collectCodexUsageSnapshot,
  getCodexUsageHeartbeatPayload,
  resetCodexUsageCacheForTests,
} from "./codexUsage";

const NOW = Date.parse("2026-07-31T12:00:00Z");

// Real shapes captured from ~/.codex/sessions rollout files.
function tokenCountLine(opts: {
  ts: string;
  total?: number;
  rateLimits?: any;
}): string {
  return JSON.stringify({
    timestamp: opts.ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      ...(opts.total !== undefined
        ? { info: { total_token_usage: { total_tokens: opts.total }, model_context_window: 258400 } }
        : {}),
      ...(opts.rateLimits ? { rate_limits: opts.rateLimits } : {}),
    },
  });
}

function turnContextLine(ts: string, model: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: "turn_context",
    payload: { turn_id: "t1", cwd: "/tmp", model },
  });
}

const CODEX_WEEKLY = {
  limit_id: "codex",
  limit_name: null,
  primary: { used_percent: 63.0, window_minutes: 10080, resets_at: 1786011679 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "prolite",
};

const SPARK_SCOPED = {
  limit_id: "codex_bengalfox",
  limit_name: "GPT-5.3-Codex-Spark",
  primary: { used_percent: 12.0, window_minutes: 10080, resets_at: 1786064044 },
  secondary: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "prolite",
};

describe("prettyCodexModel", () => {
  it("uses the codename suffix when present", () => {
    expect(prettyCodexModel("gpt-5.6-sol")).toBe("Sol");
    expect(prettyCodexModel("gpt-5.6-luna")).toBe("Luna");
    expect(prettyCodexModel("GPT-5.3-Codex-Spark")).toBe("Spark");
  });

  it("title-cases generic slugs", () => {
    expect(prettyCodexModel("gpt-5.4")).toBe("GPT-5.4");
    expect(prettyCodexModel("gpt-5.2-codex")).toBe("GPT-5.2-Codex");
    expect(prettyCodexModel("gpt-5.4-mini")).toBe("GPT-5.4-Mini");
  });
});

describe("snapshotFromRateLimits", () => {
  it("maps the base weekly window, scoped limits, and plan", () => {
    const latest = new Map([
      ["codex", { at: NOW, rl: CODEX_WEEKLY }],
      ["codex_bengalfox", { at: NOW, rl: SPARK_SCOPED }],
    ]);
    const snap = snapshotFromRateLimits(latest, NOW);
    expect(snap.weekly).toEqual({ percent: 63, resets_at: 1786011679 * 1000 });
    expect(snap.session).toBeUndefined();
    expect(snap.scoped).toEqual([{ label: "Spark", percent: 12, resets_at: 1786064044 * 1000 }]);
    expect(snap.plan_type).toBe("prolite");
    // Zero balance + has_credits false → no credits row.
    expect(snap.credits).toBeUndefined();
  });

  it("maps sub-24h windows to session and keeps a real credits balance", () => {
    const rl = {
      limit_id: "codex",
      primary: { used_percent: 41, window_minutes: 300, resets_at: 1786011679 },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1786058624 },
      credits: { has_credits: true, unlimited: false, balance: "1250" },
      plan_type: "pro",
    };
    const snap = snapshotFromRateLimits(new Map([["codex", { at: NOW, rl }]]), NOW);
    expect(snap.session).toEqual({ percent: 41, resets_at: 1786011679 * 1000 });
    expect(snap.weekly).toEqual({ percent: 10, resets_at: 1786058624 * 1000 });
    expect(snap.credits).toEqual({ has_credits: true, unlimited: false, balance: "1250" });
  });

  it("ignores a credits-only limit with nothing to show", () => {
    const rl = { limit_id: "premium", primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: "0" } };
    const snap = snapshotFromRateLimits(new Map([["premium", { at: NOW, rl }]]), NOW);
    expect(snap.weekly).toBeUndefined();
    expect(snap.credits).toBeUndefined();
  });
});

// Real response captured from `codex app-server` → account/rateLimits/read.
const RATE_LIMITS_READ_RESULT = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1786058624 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    planType: "prolite",
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1786095741 },
      secondary: null,
      credits: null,
      planType: "prolite",
    },
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1786058624 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "prolite",
    },
  },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [{ id: "RateLimitResetCredit_x", resetType: "codexRateLimits", status: "available" }],
  },
};

describe("parseRateLimitsReadResult", () => {
  it("maps every limit window, the plan, and reset credits", () => {
    const snap = parseRateLimitsReadResult(RATE_LIMITS_READ_RESULT, NOW)!;
    expect(snap.weekly).toEqual({ percent: 15, resets_at: 1786058624 * 1000 });
    expect(snap.scoped).toEqual([{ label: "Spark", percent: 7, resets_at: 1786095741 * 1000 }]);
    expect(snap.plan_type).toBe("prolite");
    expect(snap.credits).toBeUndefined(); // zero balance, hasCredits false
    expect(snap.reset_credits).toEqual({ available: 1 });
  });

  it("falls back to the top-level rateLimits for older binaries", () => {
    const snap = parseRateLimitsReadResult({ rateLimits: RATE_LIMITS_READ_RESULT.rateLimits }, NOW)!;
    expect(snap.weekly?.percent).toBe(15);
    expect(snap.scoped).toBeUndefined();
  });

  it("returns null on empty or malformed results", () => {
    expect(parseRateLimitsReadResult(null, NOW)).toBeNull();
    expect(parseRateLimitsReadResult({}, NOW)).toBeNull();
  });
});

describe("scanRolloutText", () => {
  it("extracts the newest rate limits, last total, and model", () => {
    const text = [
      "not-json-partial-line",
      turnContextLine("2026-07-31T10:00:00Z", "gpt-5.6-sol"),
      tokenCountLine({ ts: "2026-07-31T10:00:05Z", total: 1000, rateLimits: { ...CODEX_WEEKLY, primary: { ...CODEX_WEEKLY.primary, used_percent: 50 } } }),
      tokenCountLine({ ts: "2026-07-31T10:01:00Z", total: 46626, rateLimits: CODEX_WEEKLY }),
    ].join("\n");
    const res = scanRolloutText(text);
    expect(res.totalTokens).toBe(46626);
    expect(res.model).toBe("gpt-5.6-sol");
    expect(res.rateLimits.get("codex")?.rl.primary?.used_percent).toBe(63);
  });
});

describe("collectCodexUsageSnapshot", () => {
  let tmp: string;
  const origEnv: Record<string, string | undefined> = {};

  function writeRollout(day: string, name: string, lines: string[], mtime?: Date) {
    const dir = path.join(tmp, "codex", "sessions", ...day.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    if (mtime) fs.utimesSync(p, mtime, mtime);
    return p;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-test-"));
    origEnv.CODECAST_CODEX_HOME = process.env.CODECAST_CODEX_HOME;
    origEnv.CODECAST_DIR = process.env.CODECAST_DIR;
    process.env.CODECAST_CODEX_HOME = path.join(tmp, "codex");
    process.env.CODECAST_DIR = path.join(tmp, "codecast");
    resetCodexUsageCacheForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when there is no codex install", () => {
    expect(collectCodexUsageSnapshot(NOW)).toBeNull();
  });

  it("builds windows + per-model shares from recent rollouts", () => {
    writeRollout("2026/07/30", "rollout-a.jsonl", [
      turnContextLine("2026-07-30T10:00:00Z", "gpt-5.6-sol"),
      tokenCountLine({ ts: "2026-07-30T10:01:00Z", total: 900_000, rateLimits: CODEX_WEEKLY }),
    ]);
    writeRollout("2026/07/31", "rollout-b.jsonl", [
      turnContextLine("2026-07-31T09:00:00Z", "gpt-5.2-codex"),
      tokenCountLine({ ts: "2026-07-31T09:01:00Z", total: 100_000, rateLimits: { ...CODEX_WEEKLY, primary: { ...CODEX_WEEKLY.primary, used_percent: 65 } } }),
    ]);
    const snap = collectCodexUsageSnapshot(NOW)!;
    // Newest event wins the weekly window.
    expect(snap.weekly?.percent).toBe(65);
    expect(snap.plan_type).toBe("prolite");
    expect(snap.models).toEqual([
      { model: "gpt-5.6-sol", label: "Sol", tokens: 900_000, share: 90 },
      { model: "gpt-5.2-codex", label: "GPT-5.2-Codex", tokens: 100_000, share: 10 },
    ]);
  });

  it("ignores rollouts older than a week", () => {
    const old = new Date(NOW - 9 * 24 * 60 * 60 * 1000);
    writeRollout(
      "2026/07/20",
      "rollout-old.jsonl",
      [
        turnContextLine("2026-07-20T10:00:00Z", "gpt-5.4"),
        tokenCountLine({ ts: "2026-07-20T10:01:00Z", total: 500_000, rateLimits: CODEX_WEEKLY }),
      ],
      old,
    );
    expect(collectCodexUsageSnapshot(NOW)).toBeNull();
  });

  it("reuses the per-file cache and still refreshes rate limits", () => {
    writeRollout("2026/07/31", "rollout-a.jsonl", [
      turnContextLine("2026-07-31T09:00:00Z", "gpt-5.6-sol"),
      tokenCountLine({ ts: "2026-07-31T09:01:00Z", total: 50_000, rateLimits: CODEX_WEEKLY }),
    ]);
    const first = collectCodexUsageSnapshot(NOW)!;
    const second = collectCodexUsageSnapshot(NOW + 60_000)!;
    expect(second.weekly).toEqual(first.weekly);
    expect(second.models).toEqual(first.models);
    const cache = JSON.parse(
      fs.readFileSync(path.join(tmp, "codecast", "codex-usage-cache.json"), "utf-8"),
    );
    expect(Object.keys(cache.files)).toHaveLength(1);
  });

  it("refresh merges RPC limit windows with log-derived model shares", async () => {
    writeRollout("2026/07/31", "rollout-a.jsonl", [
      turnContextLine("2026-07-31T09:00:00Z", "gpt-5.6-sol"),
      // Stale log reading (63%) — the RPC's 15% must win.
      tokenCountLine({ ts: "2026-07-31T09:01:00Z", total: 50_000, rateLimits: CODEX_WEEKLY }),
    ]);
    const snap = (await refreshCodexUsageSnapshot({
      now: NOW,
      rpcFetch: async () => RATE_LIMITS_READ_RESULT,
    }))!;
    expect(snap.weekly?.percent).toBe(15);
    expect(snap.reset_credits).toEqual({ available: 1 });
    expect(snap.models).toEqual([{ model: "gpt-5.6-sol", label: "Sol", tokens: 50_000, share: 100 }]);
    // The heartbeat getter serves the refreshed snapshot, not a logs recompute.
    expect(getCodexUsageHeartbeatPayload(NOW + 1000)?.weekly?.percent).toBe(15);
  });

  it("refresh falls back to log-derived windows when the RPC fails", async () => {
    writeRollout("2026/07/31", "rollout-a.jsonl", [
      turnContextLine("2026-07-31T09:00:00Z", "gpt-5.6-sol"),
      tokenCountLine({ ts: "2026-07-31T09:01:00Z", total: 50_000, rateLimits: CODEX_WEEKLY }),
    ]);
    const snap = (await refreshCodexUsageSnapshot({ now: NOW, rpcFetch: async () => null }))!;
    expect(snap.weekly?.percent).toBe(63);
    expect(snap.models).toHaveLength(1);
  });

  it("heartbeat getter self-computes only once; refresh owns freshness", async () => {
    writeRollout("2026/07/31", "rollout-a.jsonl", [
      turnContextLine("2026-07-31T09:00:00Z", "gpt-5.6-sol"),
      tokenCountLine({ ts: "2026-07-31T09:01:00Z", total: 50_000, rateLimits: CODEX_WEEKLY }),
    ]);
    const p1 = getCodexUsageHeartbeatPayload(NOW);
    expect(p1?.weekly?.percent).toBe(63);
    // A later file is invisible to the getter — even well past 5 minutes —
    // so a getter recompute can never clobber an RPC-backed snapshot…
    writeRollout("2026/07/31", "rollout-b.jsonl", [
      turnContextLine("2026-07-31T09:10:00Z", "gpt-5.4"),
      tokenCountLine({ ts: "2026-07-31T09:11:00Z", total: 10_000 }),
    ]);
    expect(getCodexUsageHeartbeatPayload(NOW + 6 * 60_000)?.models).toHaveLength(1);
    // …until the periodic refresh folds it in.
    await refreshCodexUsageSnapshot({ now: NOW + 6 * 60_000, rpcFetch: async () => null });
    expect(getCodexUsageHeartbeatPayload(NOW + 6 * 60_000 + 1)?.models).toHaveLength(2);
  });
});
