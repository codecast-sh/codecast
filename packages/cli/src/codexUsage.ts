// Codex (ChatGPT) usage snapshots — the OpenAI half of the top bar's model
// usage meter. Two sources, merged:
//
// 1. `codex app-server` → `account/rateLimits/read`: the authoritative live
//    reading — every limit window (base weekly + model-scoped ids), credits
//    balance, plan, and available rate-limit reset credits. A short-lived
//    app-server is spawned per refresh (one JSON-RPC round trip, then killed).
// 2. Rollout logs (~/.codex/sessions/**/rollout-*.jsonl): the API has no
//    per-model breakdown, so the week's model mix — what lets the web
//    emphasize the user's frontier model (e.g. GPT-5.6-Sol) the way the
//    Claude meter emphasizes its model-scoped window — is aggregated from
//    each session's `token_count` events. The same events carry `rate_limits`
//    blocks, which double as the fallback when the RPC fails (binary missing,
//    logged out, transient error).
//
// Cost discipline: a week of rollouts can be hundreds of MB. We keep a
// per-file cache (~/.codecast/codex-usage-cache.json) keyed by mtime+size and
// only tail-read files that changed since the last refresh.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { agentSpawnPath } from "./agentSpawnPath.js";

export interface CodexUsageWindow {
  percent: number;
  resets_at?: number; // epoch ms
}

export interface CodexModelUsage {
  model: string; // raw slug, e.g. "gpt-5.6-sol"
  label: string; // display, e.g. "Sol"
  tokens: number; // cumulative total_tokens over the window
  share: number; // 0-100 share of all Codex tokens in the window
}

export interface CodexUsageSnapshot {
  fetched_at: number;
  plan_type?: string; // e.g. "prolite"
  session?: CodexUsageWindow; // sub-24h window when the plan has one
  weekly?: CodexUsageWindow; // 7d window (limit_id "codex" primary)
  scoped?: { label: string; percent: number; resets_at?: number }[]; // model-scoped limits (limit_name set)
  credits?: { has_credits: boolean; unlimited?: boolean; balance?: string };
  reset_credits?: { available: number }; // grantable "full reset" credits
  models?: CodexModelUsage[]; // trailing 7d, sorted by tokens desc
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A window under a day is the "session" bar; anything longer is weekly-ish.
const SESSION_WINDOW_MAX_MINUTES = 24 * 60;
// How much of a rollout file's tail we scan. token_count events recur every
// turn, so the info we need is always near the end.
const TAIL_BYTES = 256 * 1024;
// How many most-recent files to scan for rate_limits (the newest event wins,
// but a just-started session may not have emitted one yet).
const RATE_LIMIT_FILE_CANDIDATES = 4;

function codexHome(): string {
  return process.env.CODECAST_CODEX_HOME || path.join(os.homedir(), ".codex");
}

function cachePath(): string {
  const dir = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  return path.join(dir, "codex-usage-cache.json");
}

/** "gpt-5.6-sol" → "Sol", "GPT-5.3-Codex-Spark" → "Spark", "gpt-5.4" → "GPT-5.4".
 * Codename suffixes (Sol, Luna, Terra, Spark…) are how users refer to these
 * models, so a bare codename beats the full slug in a 5px meter row. */
export function prettyCodexModel(name: string): string {
  const parts = name.split(/[-\s]+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? name;
  const generic = new Set(["codex", "mini", "auto", "review", "high", "low"]);
  if (/^[a-zA-Z]+$/.test(last) && !generic.has(last.toLowerCase())) {
    return last[0].toUpperCase() + last.slice(1).toLowerCase();
  }
  return parts.map((p) => (/^gpt$/i.test(p) ? "GPT" : p[0].toUpperCase() + p.slice(1))).join("-");
}

// ---- account/rateLimits/read (app-server RPC) ------------------------------

/** Parse the `account/rateLimits/read` result (camelCase wire shape) into the
 * limit-window half of a snapshot. `rateLimitsByLimitId` carries every window
 * at once; the top-level `rateLimits` is the base "codex" limit and the only
 * field older binaries return. */
export function parseRateLimitsReadResult(
  result: any,
  now: number,
): Omit<CodexUsageSnapshot, "models"> | null {
  if (!result || typeof result !== "object") return null;
  const byId: Record<string, any> =
    result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object"
      ? result.rateLimitsByLimitId
      : result.rateLimits
        ? { [result.rateLimits.limitId ?? "codex"]: result.rateLimits }
        : {};
  if (Object.keys(byId).length === 0) return null;

  const snap: Omit<CodexUsageSnapshot, "models"> = { fetched_at: now };
  const toWindow = (w: any) => ({
    percent: Math.max(0, Math.min(100, w.usedPercent ?? 0)),
    ...(w.resetsAt ? { resets_at: w.resetsAt * 1000 } : {}),
  });
  for (const rl of Object.values(byId)) {
    if (!rl || typeof rl !== "object") continue;
    if (rl.planType && !snap.plan_type) snap.plan_type = rl.planType;
    const windows = [rl.primary, rl.secondary].filter((w) => w && typeof w.usedPercent === "number");
    if (rl.limitName) {
      const w = windows[0];
      if (w) (snap.scoped ??= []).push({ label: prettyCodexModel(rl.limitName), ...toWindow(w) });
    } else {
      for (const w of windows) {
        const mins = w.windowDurationMins ?? 0;
        if (mins > 0 && mins <= SESSION_WINDOW_MAX_MINUTES) snap.session = toWindow(w);
        else if (!snap.weekly || rl.limitId === "codex") snap.weekly = toWindow(w);
      }
    }
    const c = rl.credits;
    if (c && (c.hasCredits || c.unlimited || (c.balance && c.balance !== "0"))) {
      snap.credits = {
        has_credits: c.hasCredits === true,
        ...(c.unlimited !== undefined ? { unlimited: c.unlimited } : {}),
        ...(c.balance != null ? { balance: c.balance } : {}),
      };
    }
  }
  const available = result.rateLimitResetCredits?.availableCount;
  if (typeof available === "number" && available > 0) snap.reset_credits = { available };
  snap.scoped?.sort((a, b) => b.percent - a.percent);
  return snap;
}

/** One JSON-RPC round trip against a short-lived `codex app-server`:
 * initialize → account/rateLimits/read → kill. Resolves null on any failure
 * (missing binary, logged out, timeout) — callers fall back to rollout logs. */
export function fetchRateLimitsViaAppServer(
  opts: { codexBinary?: string; timeoutMs?: number } = {},
): Promise<any | null> {
  const binary = opts.codexBinary ?? "codex";
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: {
          ...process.env,
          PATH: agentSpawnPath(),
        },
      });
    } catch {
      return resolve(null);
    }
    let buf = "";
    let done = false;
    const finish = (value: any | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout!.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            child.stdin!.write(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n",
            );
          } else if (msg.id === 2) {
            finish(msg.error ? null : (msg.result ?? null));
          }
        } catch {
          /* notification or partial line */
        }
      }
    });
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "codecast", title: "Codecast Daemon", version: "1.0.0" } },
      }) + "\n",
    );
  });
}

// ---- rate_limits parsing (rollout-log fallback) ----------------------------

interface RawRateLimit {
  limit_id?: string;
  limit_name?: string | null;
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  plan_type?: string | null;
}

/** Fold the newest rate_limits reading per limit_id into a snapshot. */
export function snapshotFromRateLimits(
  latest: Map<string, { at: number; rl: RawRateLimit }>,
  now: number,
): Omit<CodexUsageSnapshot, "models"> {
  const snap: Omit<CodexUsageSnapshot, "models"> = { fetched_at: now };
  const toWindow = (w: { used_percent?: number; window_minutes?: number; resets_at?: number }) => ({
    percent: Math.max(0, Math.min(100, w.used_percent ?? 0)),
    // resets_at arrives in epoch seconds; 0 means "unknown".
    ...(w.resets_at ? { resets_at: w.resets_at * 1000 } : {}),
  });
  for (const { rl } of latest.values()) {
    if (rl.plan_type && !snap.plan_type) snap.plan_type = rl.plan_type;
    const windows = [rl.primary, rl.secondary].filter(
      (w): w is NonNullable<typeof w> => !!w && typeof w.used_percent === "number",
    );
    if (rl.limit_name) {
      // Model-scoped limit (e.g. "GPT-5.3-Codex-Spark"): one labeled row.
      const w = windows[0];
      if (w) {
        (snap.scoped ??= []).push({ label: prettyCodexModel(rl.limit_name), ...toWindow(w) });
      }
      continue;
    }
    for (const w of windows) {
      const mins = w.window_minutes ?? 0;
      if (mins > 0 && mins <= SESSION_WINDOW_MAX_MINUTES) {
        snap.session = toWindow(w);
      } else {
        // Prefer the base "codex" limit for the weekly bar over exotic ids.
        if (!snap.weekly || rl.limit_id === "codex") snap.weekly = toWindow(w);
      }
    }
    const c = rl.credits;
    if (c && (c.has_credits || c.unlimited || (c.balance && c.balance !== "0"))) {
      snap.credits = {
        has_credits: c.has_credits === true,
        ...(c.unlimited !== undefined ? { unlimited: c.unlimited } : {}),
        ...(c.balance != null ? { balance: c.balance } : {}),
      };
    }
  }
  snap.scoped?.sort((a, b) => b.percent - a.percent);
  return snap;
}

/** Scan raw jsonl text for token_count events; returns the newest rate_limits
 * per limit_id plus the last cumulative token total and model slug seen. */
export function scanRolloutText(text: string): {
  rateLimits: Map<string, { at: number; rl: RawRateLimit }>;
  totalTokens?: number;
  model?: string;
} {
  const rateLimits = new Map<string, { at: number; rl: RawRateLimit }>();
  let totalTokens: number | undefined;
  let model: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue; // partial first line from a tail read
    const hasRl = line.includes('"rate_limits"');
    const hasTok = line.includes('"total_token_usage"');
    const hasModel = line.includes('"model"');
    if (!hasRl && !hasTok && !hasModel) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = d?.payload;
    if (!payload) continue;
    const at = Date.parse(d.timestamp ?? "") || 0;
    const rl: RawRateLimit | undefined = payload.rate_limits;
    if (rl?.limit_id !== undefined || rl?.primary || rl?.credits) {
      const key = rl.limit_id ?? "";
      const prev = rateLimits.get(key);
      if (!prev || at >= prev.at) rateLimits.set(key, { at, rl });
    }
    const total = payload.info?.total_token_usage?.total_tokens;
    if (typeof total === "number") totalTokens = total;
    // turn_context / thread_settings carry the session's model slug.
    const m = payload.model ?? payload.thread_settings?.model;
    if (typeof m === "string" && m) model = m;
  }
  return { rateLimits, totalTokens, model };
}

// ---- file walking + cache --------------------------------------------------

interface CachedFile {
  mtime: number;
  size: number;
  model?: string;
  tokens?: number;
}

interface UsageCacheFile {
  files: Record<string, CachedFile>;
}

function readCache(): UsageCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf-8"));
    if (parsed && typeof parsed.files === "object") return parsed;
  } catch {
    /* first run / corrupt cache — rebuild */
  }
  return { files: {} };
}

function readTail(filePath: string, bytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Rollout files modified within the trailing week, newest first. Sessions are
 * sharded as sessions/YYYY/MM/DD/*.jsonl; we prune by directory date before
 * statting so an old archive costs nothing. */
function listRecentRolloutFiles(now: number): { path: string; mtime: number; size: number }[] {
  const root = path.join(codexHome(), "sessions");
  const cutoff = now - WEEK_MS;
  const out: { path: string; mtime: number; size: number }[] = [];
  let years: string[];
  try {
    years = fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d));
  } catch {
    return out; // no codex install
  }
  for (const y of years) {
    const yDir = path.join(root, y);
    for (const m of safeReaddir(yDir).filter((d) => /^\d{2}$/.test(d))) {
      const mDir = path.join(yDir, m);
      for (const day of safeReaddir(mDir).filter((d) => /^\d{2}$/.test(d))) {
        // Day-directory date + 2d slack vs cutoff — cheap prune, mtime decides.
        const dayMs = Date.parse(`${y}-${m}-${day}T00:00:00Z`);
        if (!Number.isFinite(dayMs) || dayMs < cutoff - 2 * 24 * 60 * 60 * 1000) continue;
        const dDir = path.join(mDir, day);
        for (const f of safeReaddir(dDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const p = path.join(dDir, f);
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs >= cutoff) out.push({ path: p, mtime: st.mtimeMs, size: st.size });
          } catch {
            /* raced a deletion */
          }
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build the full snapshot: newest rate limits + per-model week aggregation.
 * Returns null when there's no Codex install (or no recent activity). */
export function collectCodexUsageSnapshot(now = Date.now()): CodexUsageSnapshot | null {
  const files = listRecentRolloutFiles(now);
  if (files.length === 0) return null;

  const cache = readCache();
  const nextFiles: Record<string, CachedFile> = {};
  const latestRl = new Map<string, { at: number; rl: RawRateLimit }>();

  files.forEach((f, idx) => {
    const cached = cache.files[f.path];
    const fresh = cached && cached.mtime === f.mtime && cached.size === f.size;
    // The newest few files always get a tail read for rate_limits — those are
    // point-in-time readings, not per-file facts, so the cache can't serve them.
    if (fresh && idx >= RATE_LIMIT_FILE_CANDIDATES) {
      nextFiles[f.path] = cached;
      return;
    }
    let scanned: ReturnType<typeof scanRolloutText>;
    try {
      scanned = scanRolloutText(readTail(f.path, TAIL_BYTES));
    } catch {
      if (cached) nextFiles[f.path] = cached;
      return;
    }
    if (idx < RATE_LIMIT_FILE_CANDIDATES) {
      for (const [k, v] of scanned.rateLimits) {
        const prev = latestRl.get(k);
        if (!prev || v.at >= prev.at) latestRl.set(k, v);
      }
    }
    nextFiles[f.path] = {
      mtime: f.mtime,
      size: f.size,
      model: scanned.model ?? cached?.model,
      tokens: scanned.totalTokens ?? cached?.tokens,
    };
  });

  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ files: nextFiles }), { mode: 0o644 });
  } catch {
    /* cache is an optimization; never fail the snapshot over it */
  }

  const snap: CodexUsageSnapshot = snapshotFromRateLimits(latestRl, now);

  // Per-model aggregation over the window. total_token_usage is cumulative per
  // session, so the last reading per file is that session's total.
  const byModel = new Map<string, number>();
  for (const f of Object.values(nextFiles)) {
    if (!f.model || !f.tokens) continue;
    byModel.set(f.model, (byModel.get(f.model) ?? 0) + f.tokens);
  }
  const grand = [...byModel.values()].reduce((a, b) => a + b, 0);
  if (grand > 0) {
    snap.models = [...byModel.entries()]
      .map(([model, tokens]) => ({
        model,
        label: prettyCodexModel(model),
        tokens,
        share: Math.round((tokens / grand) * 100),
      }))
      .sort((a, b) => b.tokens - a.tokens);
  }
  return snap;
}

// ---- daemon-facing refresh + getter ----------------------------------------

let lastComputed: { at: number; snap: CodexUsageSnapshot | null } | null = null;

/** Full refresh: authoritative limit windows from the app-server RPC, model
 * mix (and, on RPC failure, limit windows too) from the rollout logs. Updates
 * the module cache the heartbeat getter reads. Never throws. */
export async function refreshCodexUsageSnapshot(
  opts: {
    now?: number;
    rpcFetch?: () => Promise<any | null>; // test seam
  } = {},
): Promise<CodexUsageSnapshot | null> {
  const now = opts.now ?? Date.now();
  let logsSnap: CodexUsageSnapshot | null = null;
  try {
    logsSnap = collectCodexUsageSnapshot(now);
  } catch {
    /* unreadable logs — RPC alone can still carry the windows */
  }
  let rpcSnap: Omit<CodexUsageSnapshot, "models"> | null = null;
  // No local rollouts AND no probe target → machine doesn't use Codex; skip
  // spawning a binary that would just fail.
  if (logsSnap || fs.existsSync(codexHome())) {
    try {
      const result = await (opts.rpcFetch ?? fetchRateLimitsViaAppServer)();
      rpcSnap = parseRateLimitsReadResult(result, now);
    } catch {
      /* fall back to logsSnap */
    }
  }
  const snap: CodexUsageSnapshot | null = rpcSnap
    ? { ...rpcSnap, ...(logsSnap?.models ? { models: logsSnap.models } : {}) }
    : logsSnap;
  lastComputed = { at: now, snap };
  return snap;
}

/** Heartbeat payload: the latest refreshed snapshot. Freshness is owned by the
 * daemon's periodic refreshCodexUsageSnapshot; the one synchronous fallback
 * here (logs-only) covers the beats before the first async refresh lands, so
 * a just-started daemon isn't empty. Never throws. */
export function getCodexUsageHeartbeatPayload(now = Date.now()): CodexUsageSnapshot | undefined {
  if (!lastComputed) {
    try {
      lastComputed = { at: now, snap: collectCodexUsageSnapshot(now) };
    } catch {
      lastComputed = { at: now, snap: null };
    }
  }
  return lastComputed.snap ?? undefined;
}

/** Test seam. */
export function resetCodexUsageCacheForTests(): void {
  lastComputed = null;
}
