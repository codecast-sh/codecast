// Load mode for `cast bench daemon`: N stand-in agent panes against the LIVE
// daemon, transcript churn, and delivery round trips sampled on K panes.
//
// The pane runs the doctor's node stub, not the fake claude bash shim. The
// daemon treats only agent binaries and node/bun/deno as live agents; a bash
// pane fails isTmuxAgentAlive, and the health check would then kill the pane
// and launch a real `claude --resume` for every bench session.
//
// The bench never boots a daemon. CONFIG_DIR is fixed to ~/.codecast and a
// daemon boot kills every other daemon it finds.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import {
  STUB_SOURCE,
  resolveStubRuntime,
  pickDoctorProjectDir,
  exportHasToken,
  doctorPost,
  readConversationMapping,
} from "../doctor.js";
import { fetchExport } from "../jsonlGenerator.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { spawnHarness, sweepStaleSessions, type Harness } from "../test-helpers/messagingHarness.js";
import { runLoopLagProbe, runLatencyProbe, type LoopLagResult, type LatencyProbeResult } from "./probes.js";
import { summarizeLatency, type LatencySummary } from "./stats.js";
import type { Config } from "../config/types.js";

export interface LoadDeps {
  config: Config;
  siteUrl: string;
  apiToken: string;
  configDir: string;
  getDaemonPid: () => number | null;
}

export interface LoadOptions {
  n: number;
  sample: number;
  durationMs: number;
  churnIntervalMs: number;
  keep: boolean;
  projectDir?: string;
  /** Loopback port for the concurrent probes; null skips them. */
  port: number | null;
  authHeaders: Record<string, string> | null;
}

export interface RoundTrip {
  sessionId: string;
  conversationId: string;
  /** Transcript append to export visibility. */
  upMs: number | null;
  /** Send to the pane's transcript carrying the token. */
  injectedMs: number | null;
  /** Send to the assistant echo visible in the export. */
  echoedMs: number | null;
}

export interface LoadResult {
  runId: string;
  scratchDir: string;
  n: number;
  spawned: number;
  spawnMs: LatencySummary;
  spawnErrors: string[];
  mapped: number;
  mappingMs: LatencySummary;
  churn: { durationMs: number; intervalMs: number; linesAppended: number };
  roundTrips: RoundTrip[];
  upMs: LatencySummary;
  injectedMs: LatencySummary;
  echoedMs: LatencySummary;
  loopLag: LoopLagResult | null;
  hookStatus: LatencyProbeResult | null;
  termSessions: LatencyProbeResult | null;
  teardown: { kept: boolean; conversationsDeleted: number; warnings: string[] };
}

const MAPPING_TIMEOUT_MS = 45_000;
const UP_TIMEOUT_MS = 60_000;
const ROUNDTRIP_TIMEOUT_MS = 90_000;
const POLL_MS = 750;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The stub's own transcript line shape, so churn looks like the stub wrote it. */
function transcriptLine(sessionId: string, cwd: string, role: "user" | "assistant", text: string): string {
  const base = { uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString() };
  const message = role === "user"
    ? { role, content: text }
    : { role, content: [{ type: "text", text }] };
  return JSON.stringify({ ...base, type: role, message }) + "\n";
}

export async function runLoadBench(
  deps: LoadDeps,
  opts: LoadOptions,
  say: (line: string) => void,
): Promise<LoadResult> {
  if (deps.getDaemonPid() === null) throw new Error("no live daemon (the bench never boots one); run `cast start` first");
  const runtime = resolveStubRuntime();
  if (!runtime) throw new Error("no node or bun on PATH for the stub agent");
  const runId = `bench-${randomBytes(4).toString("hex")}`;
  const scratch = pickDoctorProjectDir(deps.config, runId, opts.projectDir);
  if (!scratch) throw new Error("no syncable scratch dir: sync_mode is 'selected' and no allowed root accepts a test dir (`cast sync-settings`)");
  fs.mkdirSync(scratch, { recursive: true });
  const realScratch = fs.realpathSync(scratch);
  const stubPath = path.join(realScratch, "stub.cjs");
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const tmuxPrefix = `cc-claude-test-${runId}`;
  const projectDir = path.join(os.homedir(), ".claude", "projects", claudeProjectDirName(realScratch));

  const harnesses: Harness[] = [];
  const registryPaths: string[] = [];
  const spawnMs: number[] = [];
  const spawnErrors: string[] = [];
  const mappings = new Map<string, string>();
  const mappingMs: number[] = [];
  const warnings: string[] = [];
  let linesAppended = 0;
  let conversationsDeleted = 0;
  const roundTrips: RoundTrip[] = [];
  let loopLag: LoopLagResult | null = null;
  let hookStatus: LatencyProbeResult | null = null;
  let termSessions: LatencyProbeResult | null = null;

  const abort = new AbortController();
  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);

  try {
    say(`  spawning ${opts.n} stub panes in ${realScratch}`);
    for (let i = 0; i < opts.n && !abort.signal.aborted; i++) {
      const sessionId = randomUUID();
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      const registryPath = path.join(deps.configDir, "session-registry", `${sessionId}.json`);
      const bootToken = `boot-${randomBytes(4).toString("hex")}`;
      const command = `DOCTOR_BOOT_TOKEN=${q(bootToken)} exec ${q(runtime)} ${q(stubPath)} ${q(sessionId)} ${q(jsonlPath)} ${q(registryPath)}`;
      const start = Date.now();
      try {
        harnesses.push(spawnHarness({ cwd: realScratch, sessionId, jsonlPath, tmuxPrefix, command }));
        registryPaths.push(registryPath);
        spawnMs.push(Date.now() - start);
      } catch (err) {
        spawnErrors.push(`${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if ((i + 1) % 10 === 0) say(`  spawned ${i + 1}/${opts.n}`);
    }

    // The watcher creates one conversation per transcript; wait for the mapping
    // of every pane (this is the doctor's first leg, N times).
    say(`  waiting for ${harnesses.length} conversation mappings`);
    const mapStart = Date.now();
    const pendingIds = new Set(harnesses.map((h) => h.sessionId));
    while (pendingIds.size > 0 && Date.now() - mapStart < MAPPING_TIMEOUT_MS && !abort.signal.aborted) {
      await sleep(POLL_MS);
      for (const id of [...pendingIds]) {
        const conv = readConversationMapping(deps.configDir, id);
        if (conv) {
          mappings.set(id, conv);
          mappingMs.push(Date.now() - mapStart);
          pendingIds.delete(id);
        }
      }
    }
    if (pendingIds.size > 0) warnings.push(`${pendingIds.size} panes never mapped to a conversation within ${MAPPING_TIMEOUT_MS / 1000}s`);
    say(`  mapped ${mappings.size}/${harnesses.length}`);

    // Churn plus the probes, concurrently, for the measurement window.
    say(`  churning ${harnesses.length} transcripts for ${Math.round(opts.durationMs / 1000)}s`);
    const churnDone = (async () => {
      const deadline = Date.now() + opts.durationMs;
      let i = 0;
      while (Date.now() < deadline && !abort.signal.aborted) {
        for (const h of harnesses) {
          try {
            fs.appendFileSync(h.jsonlPath, transcriptLine(h.sessionId, realScratch, "user", `churn ${i} for ${runId}`));
            fs.appendFileSync(h.jsonlPath, transcriptLine(h.sessionId, realScratch, "assistant", `churn reply ${i}`));
            linesAppended += 2;
          } catch {}
        }
        i++;
        await sleep(opts.churnIntervalMs);
      }
    })();
    const probes = opts.port === null
      ? Promise.resolve()
      : (async () => {
          const port = opts.port!;
          const results = await Promise.all([
            runLoopLagProbe({ port, durationMs: opts.durationMs, signal: abort.signal }),
            runLatencyProbe({ url: `http://127.0.0.1:${port}/hook/status`, durationMs: opts.durationMs, signal: abort.signal }),
            opts.authHeaders
              ? runLatencyProbe({ url: `http://127.0.0.1:${port}/term/sessions`, headers: opts.authHeaders, durationMs: opts.durationMs, signal: abort.signal })
              : Promise.resolve(null),
          ]);
          loopLag = results[0];
          hookStatus = results[1];
          termSessions = results[2];
        })();
    await Promise.all([churnDone, probes]);

    // Delivery legs on a sample of K mapped panes, sequentially, like the doctor.
    const sampled = harnesses.filter((h) => mappings.has(h.sessionId)).slice(0, opts.sample);
    say(`  sampling delivery round trips on ${sampled.length} panes`);
    for (const h of sampled) {
      if (abort.signal.aborted) break;
      const conversationId = mappings.get(h.sessionId)!;
      const trip: RoundTrip = { sessionId: h.sessionId, conversationId, upMs: null, injectedMs: null, echoedMs: null };
      roundTrips.push(trip);

      const upToken = `up-${randomBytes(4).toString("hex")}`;
      let legStart = Date.now();
      fs.appendFileSync(h.jsonlPath, transcriptLine(h.sessionId, realScratch, "user", `bench up leg ${upToken}`));
      while (trip.upMs === null && Date.now() - legStart < UP_TIMEOUT_MS && !abort.signal.aborted) {
        await sleep(POLL_MS);
        try {
          const exported = await fetchExport(deps.siteUrl, deps.apiToken, conversationId);
          if (exportHasToken(exported.messages, upToken)) trip.upMs = Date.now() - legStart;
        } catch {}
      }

      const downToken = `pong-${randomBytes(4).toString("hex")}`;
      legStart = Date.now();
      try {
        await doctorPost(deps.siteUrl, deps.apiToken, "/cli/messages/send", { to: conversationId, body: `codecast bench ${runId}: reply with ${downToken}` });
      } catch (err) {
        warnings.push(`send to ${conversationId.slice(0, 12)} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      while (trip.echoedMs === null && Date.now() - legStart < ROUNDTRIP_TIMEOUT_MS && !abort.signal.aborted) {
        await sleep(POLL_MS);
        if (trip.injectedMs === null) {
          try {
            if (fs.readFileSync(h.jsonlPath, "utf-8").includes(downToken)) trip.injectedMs = Date.now() - legStart;
          } catch {}
        }
        if (trip.injectedMs !== null) {
          try {
            const exported = await fetchExport(deps.siteUrl, deps.apiToken, conversationId);
            if (exportHasToken(exported.messages, downToken, "assistant")) trip.echoedMs = Date.now() - legStart;
          } catch {}
        }
      }
      say(`  ${h.sessionId.slice(0, 8)} up=${trip.upMs ?? "timeout"} injected=${trip.injectedMs ?? "timeout"} echoed=${trip.echoedMs ?? "timeout"}`);
    }
  } finally {
    // bun types accept signal names on `on` but not on `off`; the EventEmitter view does.
    (process as unknown as NodeJS.EventEmitter).off("SIGINT", onSigint);
    if (opts.keep) {
      say(`  kept: tmux ${tmuxPrefix}-*, ${realScratch}, ${projectDir}`);
    } else {
      say(`  tearing down ${harnesses.length} panes`);
      for (const h of harnesses) {
        try { h.tearDown(); } catch {}
      }
      sweepStaleSessions(tmuxPrefix);
      for (const p of registryPaths) {
        try { fs.rmSync(p, { force: true }); } catch {}
      }
      try { fs.rmSync(realScratch, { recursive: true, force: true }); } catch {}
      try {
        if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir);
      } catch {}
      // One delete-by-path call caps its mutations; loop until the server says
      // nothing is left. The scratch path is unique to this run.
      try {
        let hasMore = true;
        let guard = 0;
        while (hasMore && guard++ < 50) {
          const result = await doctorPost(deps.siteUrl, deps.apiToken, "/cli/conversations/delete-by-path", { path_prefix: realScratch });
          conversationsDeleted += Number(result?.conversationsDeleted ?? 0);
          hasMore = result?.hasMore === true;
        }
      } catch (err) {
        warnings.push(`delete-by-path failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (conversationsDeleted < mappings.size) {
        warnings.push(`server delete removed ${conversationsDeleted} conversations but ${mappings.size} were mapped; the rest are still in the inbox under ${realScratch}`);
      }
    }
  }

  return {
    runId,
    scratchDir: realScratch,
    n: opts.n,
    spawned: harnesses.length,
    spawnMs: summarizeLatency(spawnMs),
    spawnErrors,
    mapped: mappings.size,
    mappingMs: summarizeLatency(mappingMs),
    churn: { durationMs: opts.durationMs, intervalMs: opts.churnIntervalMs, linesAppended },
    roundTrips,
    upMs: summarizeLatency(roundTrips.map((t) => t.upMs).filter((v): v is number => v !== null)),
    injectedMs: summarizeLatency(roundTrips.map((t) => t.injectedMs).filter((v): v is number => v !== null)),
    echoedMs: summarizeLatency(roundTrips.map((t) => t.echoedMs).filter((v): v is number => v !== null)),
    loopLag,
    hookStatus,
    termSessions,
    teardown: { kept: opts.keep, conversationsDeleted, warnings },
  };
}
