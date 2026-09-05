import { randomUUID } from "node:crypto";
import { exportHasToken } from "../doctor.js";
import { BenchFixture, type Fixture } from "./fixture.js";
import { benchClock, deadlineSignal, outcomeFor, runRouteProbes, type BenchClock, type LatencyProbeResult, type ProbeFetch, type RouteProbes, type Outcome } from "./probes.js";
import { summarizeLatency, type LatencySummary } from "./stats.js";
import type { Config } from "../config/types.js";

export interface RuntimeIdentity {
  pid: number | null;
  processIdentity: string | null;
  build: string | null;
  runtime: string | null;
  workerSetting: boolean | null;
  workerRouting: string | null;
  configHash: string | null;
}
export interface LoadDeps {
  config: Config;
  siteUrl: string;
  apiToken: string;
  configDir: string;
  getDaemonPid: () => number | null;
  observeRuntime?: () => Promise<RuntimeIdentity>;
}
export interface LoadOptions {
  n: number;
  sample: number;
  durationMs: number;
  churnIntervalMs: number;
  keep: boolean;
  projectDir?: string;
  port: number | null;
  authHeaders: Record<string, string> | null;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  mappingTimeoutMs?: number;
  pollMs?: number;
}
export interface Leg {
  outcome: Outcome;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number | null;
  polls: number;
  reason?: string;
}
export interface RoundTrip {
  sessionId: string | null;
  conversationId: string | null;
  up: Leg;
  injected: Leg;
  echoed: Leg;
  upMs: number | null;
  injectedMs: number | null;
  echoedMs: number | null;
}
export interface Startup {
  sessionId: string;
  startedAt: number;
  spawnedAt: number | null;
  mappedAt: number | null;
  outcome: Outcome;
}
export interface Failure { phase: string; outcome: Outcome; sessionId?: string; reason: string; at: number }
export interface LoadResult {
  runId: string;
  scratchDir: string;
  n: number;
  sampleRequested: number;
  spawned: number;
  spawnMs: LatencySummary;
  spawnErrors: string[];
  mapped: number;
  mappingMs: LatencySummary;
  startup: Startup[];
  window: { start: number; end: number; finishedAt: number; wallStart: string } | null;
  phases: { phase: string; startedAt: number; finishedAt: number }[];
  churn: { durationMs: number; intervalMs: number; linesAppended: number; startedAt: number | null; endedAt: number | null; expectedRounds: number; missedRounds: number; rounds: { scheduledAt: number; startedAt: number; finishedAt: number; lines: number; attempts: { sessionId: string; outcome: Outcome | "paused"; startedAt: number | null; finishedAt: number | null }[] }[] };
  roundTrips: RoundTrip[];
  upMs: LatencySummary;
  injectedMs: LatencySummary;
  echoedMs: LatencySummary;
  loopLag: LatencyProbeResult | null;
  hookStatus: LatencyProbeResult | null;
  termSessions: LatencyProbeResult | null;
  failures: Failure[];
  before: RuntimeIdentity | null;
  after: RuntimeIdentity | null;
  resources: Fixture[];
  teardown: { kept: boolean; conversationsDeleted: number; verified: boolean; warnings: string[] };
  acceptance: { status: "FAIL" | "NOT ESTABLISHED"; reasons: string[] };
}
export type FixtureIO = Pick<BenchFixture, "scratch" | "fixtures" | "prepare" | "allocate" | "spawn" | "recordHook" | "verify" | "mapping" | "append" | "pauseWrites" | "resumeWrites" | "hasToken" | "cleanup" | "finish">;
export interface LoadIO {
  clock: BenchClock;
  fixture: (runId: string) => FixtureIO;
  post: (route: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
  routes: (opts: Parameters<typeof runRouteProbes>[0]) => Promise<RouteProbes>;
}

export function benchPost(siteUrl: string, apiToken: string, transport: ProbeFetch = fetch): LoadIO["post"] {
  return async (route, body, signal) => {
    signal.throwIfAborted();
    const response = await transport(`${siteUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: apiToken, ...body }), signal });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const result = await response.json() as any;
    signal.throwIfAborted();
    if (!result || typeof result !== "object" || result.error) throw new Error("backend error or malformed response");
    return result;
  };
}

export async function exportedToken(post: LoadIO["post"], conversationId: string, token: string, role: "user" | "assistant", signal: AbortSignal, expected?: { sessionId: string; projectPath: string }) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 1000; page++) {
    const data = await post("/cli/export", { conversation_id: conversationId, cursor, limit: 500 }, signal);
    if (!data.conversation || !Array.isArray(data.messages)) throw new Error("malformed export");
    if (expected && (data.conversation.id !== conversationId || data.conversation.session_id !== expected.sessionId || data.conversation.project_path !== expected.projectPath)) throw new Error("conversation ownership mismatch");
    if (exportHasToken(data.messages, token, role)) return true;
    if (data.done === true) return false;
    if (typeof data.next_cursor !== "string" || !data.next_cursor || seen.has(data.next_cursor)) throw new Error("invalid export cursor");
    cursor = data.next_cursor;
    seen.add(cursor!);
  }
  throw new Error("export page limit");
}

export async function ownedHookUrl(port: number, fixture: FixtureIO, f: Fixture, clock: BenchClock, signal: AbortSignal) {
  if (!fixture.fixtures.includes(f) || !f.created || !f.pid || !f.conversationId) throw new Error("unowned hook target");
  await fixture.verify(f, signal);
  signal.throwIfAborted();
  const stamp = { ts: Math.floor(clock.wall() / 1000), message: `bench hook ${randomUUID()}` };
  await fixture.recordHook(f, stamp);
  const query = new URLSearchParams({ session_id: f.sessionId, status: "working", ts: String(stamp.ts), message: stamp.message, transcript_path: f.jsonlPath });
  return `http://127.0.0.1:${port}/hook/status?${query}`;
}

const failureText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message.slice(0, 400)}` : "unknown failure";
const missingLeg = (): Leg => ({ outcome: "missing", startedAt: null, finishedAt: null, ms: null, polls: 0, reason: "not attempted" });
const unknownRuntime = (pid: number | null): RuntimeIdentity => ({ pid, processIdentity: null, build: null, runtime: null, workerSetting: null, workerRouting: null, configHash: null });

export function measurementFailures(r: LoadResult): string[] {
  const reasons: string[] = [];
  if (r.failures.length) reasons.push(`${r.failures.length} recorded failures`);
  if (r.spawned !== r.n || r.mapped !== r.n) reasons.push("incomplete fleet");
  if (r.resources.filter(f => f.created).some(f => !f.transcriptVerified)) reasons.push("transcript correctness unverified");
  if (!r.teardown.verified || r.teardown.kept || r.teardown.warnings.length) reasons.push("cleanup unverified");
  if (r.churn.missedRounds || !r.churn.linesAppended) reasons.push("churn incomplete");
  if (r.roundTrips.length !== r.sampleRequested || r.roundTrips.some(t => [t.up, t.injected, t.echoed].some(l => l.outcome !== "ok"))) reasons.push("delivery incomplete");
  for (const [name, probe] of [["health", r.loopLag], ["owned hook", r.hookStatus], ["terminal", r.termSessions]] as const) {
    if (!probe || probe.expected === 0 || probe.records.length !== probe.expected || probe.records.some(p => p.outcome !== "ok")) reasons.push(`${name} missing or failed slots`);
  }
  if (!r.hookStatus || r.hookStatus.label !== "owned hook status") reasons.push("valid hook handling unproven");
  if ((r.loopLag?.summary.over1s ?? 0) > 0) reasons.push("health RTT >=1000ms");
  if (r.termSessions?.summary.p99 === null || (r.termSessions?.summary.p99 ?? Infinity) >= 50) reasons.push("terminal p99 >=50ms or missing");
  const window = r.window;
  if (!window || r.roundTrips.some(t => [t.up, t.injected, t.echoed].some(l => {
    if (l.startedAt === null || l.finishedAt === null || l.startedAt < window.start || l.finishedAt > window.end) return true;
    const activeChurn = r.churn.startedAt !== null && r.churn.endedAt !== null && r.churn.startedAt <= l.startedAt && r.churn.endedAt >= l.finishedAt;
    const activeProbes = [r.loopLag, r.hookStatus, r.termSessions].every(p => p && p.startedAt <= l.startedAt! && p.endedAt >= l.finishedAt!);
    return !activeChurn || !activeProbes;
  }))) reasons.push("delivery/churn/route overlap unproven");
  const starts = r.roundTrips.flatMap(t => [t.up, t.injected, t.echoed].flatMap(l => l.startedAt === null ? [] : [l.startedAt]));
  const finishes = r.roundTrips.flatMap(t => [t.up, t.injected, t.echoed].flatMap(l => l.finishedAt === null ? [] : [l.finishedAt]));
  const first = Math.min(...starts), last = Math.max(...finishes);
  if (!r.churn.rounds.some(c => c.lines > 0 && c.startedAt <= last && c.finishedAt >= first)
    || [r.loopLag, r.hookStatus, r.termSessions].some(p => !p?.records.some(s => s.outcome === "ok" && s.startedAt !== null && s.startedAt <= last && s.finishedAt >= first))) reasons.push("no observed traffic during delivery cohort");
  if (!r.before || !r.after || JSON.stringify(r.before) !== JSON.stringify(r.after)) reasons.push("runtime changed or unobserved");
  return reasons;
}

export async function runLoadBench(deps: LoadDeps, opts: LoadOptions, say: (line: string) => void, overrides: Partial<LoadIO> = {}): Promise<LoadResult> {
  const clock = overrides.clock ?? benchClock;
  const runId = `bench-${randomUUID()}`;
  const io: LoadIO = { clock, fixture: id => new BenchFixture(id, deps.config, deps.configDir, { projectDir: opts.projectDir, clock }), post: benchPost(deps.siteUrl, deps.apiToken), routes: runRouteProbes, ...overrides };
  const fixture = io.fixture(runId);
  const r: LoadResult = { runId, scratchDir: "", n: opts.n, sampleRequested: opts.sample, spawned: 0, spawnMs: summarizeLatency([]), spawnErrors: [], mapped: 0, mappingMs: summarizeLatency([]), startup: [], window: null, phases: [], churn: { durationMs: opts.durationMs, intervalMs: opts.churnIntervalMs, linesAppended: 0, startedAt: null, endedAt: null, expectedRounds: Math.ceil(opts.durationMs / opts.churnIntervalMs), missedRounds: 0, rounds: [] }, roundTrips: Array.from({ length: opts.sample }, () => ({ sessionId: null, conversationId: null, up: missingLeg(), injected: missingLeg(), echoed: missingLeg(), upMs: null, injectedMs: null, echoedMs: null })), upMs: summarizeLatency([]), injectedMs: summarizeLatency([]), echoedMs: summarizeLatency([]), loopLag: null, hookStatus: null, termSessions: null, failures: [], before: null, after: null, resources: fixture.fixtures, teardown: { kept: opts.keep, conversationsDeleted: 0, verified: false, warnings: [] }, acceptance: { status: "NOT ESTABLISHED", reasons: [] } };
  const cancellation = new AbortController();
  const onInt = () => cancellation.abort(new DOMException("SIGINT", "AbortError"));
  const onTerm = () => cancellation.abort(new DOMException("SIGTERM", "AbortError"));
  const onAbort = () => cancellation.abort(opts.signal?.reason);
  process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
  if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const overall = deadlineSignal(clock, clock.now() + (opts.totalTimeoutMs ?? opts.n * 6000 + 45000 + opts.durationMs), cancellation.signal);
  const recordFailure = (phase: string, signal: AbortSignal, sessionId?: string, reason = "operation failed") => r.failures.push({ phase, outcome: outcomeFor(signal), sessionId, reason: signal.aborted ? String(signal.reason?.name ?? "cancelled") : reason, at: clock.now() });
  const phase = async (name: string, work: () => Promise<void>) => {
    const span = { phase: name, startedAt: clock.now(), finishedAt: clock.now() }; r.phases.push(span);
    try { await work(); } finally { span.finishedAt = clock.now(); }
  };
  const observe = () => deps.observeRuntime?.() ?? Promise.resolve(unknownRuntime(deps.getDaemonPid()));
  try {
    if (!Number.isInteger(opts.n) || opts.n < 1 || !Number.isInteger(opts.sample) || opts.sample < 1 || opts.sample > opts.n || opts.durationMs <= 0 || opts.churnIntervalMs <= 0) throw new Error("invalid load bounds");
    r.before = await observe();
    if (r.before.pid === null || opts.port === null || !opts.authHeaders?.Authorization || !deps.apiToken) throw new Error("daemon identity or authentication missing");
    await phase("prepare", () => fixture.prepare(overall.signal));
    r.scratchDir = fixture.scratch;
    say(`spawning ${opts.n} owned stub panes`);
    await phase("startup", async () => {
      const mappings: Promise<void>[] = [];
      try {
        for (let index = 0; index < opts.n; index++) {
          overall.signal.throwIfAborted();
          const f = fixture.allocate();
          const start: Startup = { sessionId: f.sessionId, startedAt: clock.now(), spawnedAt: null, mappedAt: null, outcome: "missing" }; r.startup.push(start);
          const mappingWindow = deadlineSignal(clock, start.startedAt + (opts.mappingTimeoutMs ?? 45000), overall.signal);
          try {
            await fixture.spawn(f, mappingWindow.signal);
            start.spawnedAt = clock.now(); r.spawned++;
            mappings.push((async () => {
              try {
                while (!f.conversationId) {
                  mappingWindow.signal.throwIfAborted();
                  const id = await fixture.mapping(f);
                  if (id && await exportedToken(io.post, id, `boot-${f.sessionId}`, "user", mappingWindow.signal, { sessionId: f.sessionId, projectPath: fixture.scratch })) { f.conversationId = id; start.mappedAt = clock.now(); start.outcome = "ok"; r.mapped++; break; }
                  await clock.sleep(opts.pollMs ?? 250, mappingWindow.signal);
                }
              } catch (e) { start.outcome = outcomeFor(mappingWindow.signal); recordFailure("mapping", mappingWindow.signal, f.sessionId, failureText(e)); }
              finally { await mappingWindow.close(); }
            })());
          } catch (e) {
            start.outcome = outcomeFor(mappingWindow.signal); r.spawnErrors.push(f.sessionId); recordFailure("spawn", mappingWindow.signal, f.sessionId, failureText(e)); await mappingWindow.close();
          }
        }
      } finally { await Promise.all(mappings); }
    });
    overall.signal.throwIfAborted();
    if (r.mapped !== opts.n || r.spawned !== opts.n) throw new Error("fleet incomplete");
    await phase("measurement", async () => {
      const start = clock.now();
      const end = start + opts.durationMs;
      r.window = { start, end, finishedAt: start, wallStart: new Date(clock.wall()).toISOString() };
      const window = deadlineSignal(clock, Math.min(end, clock.now() + (opts.totalTimeoutMs ?? Infinity)), overall.signal);
      const population = fixture.fixtures.filter(f => f.conversationId);
      const churn = (async () => {
        r.churn.startedAt = clock.now();
        let slot = 0;
        try {
          for (; slot < r.churn.expectedRounds; slot++) {
            const scheduledAt = start + slot * opts.churnIntervalMs;
            if (clock.now() < scheduledAt) await clock.sleep(scheduledAt - clock.now(), window.signal);
            window.signal.throwIfAborted();
            if (clock.now() - scheduledAt >= opts.churnIntervalMs) { r.churn.missedRounds++; continue; }
            const round: LoadResult["churn"]["rounds"][number] = { scheduledAt, startedAt: clock.now(), finishedAt: clock.now(), lines: 0, attempts: population.map(f => ({ sessionId: f.sessionId, outcome: "missing", startedAt: null, finishedAt: null })) }; r.churn.rounds.push(round);
            try {
              for (const [index, f] of population.entries()) {
                const attempt = round.attempts[index]; attempt.startedAt = clock.now();
                try {
                  const written = await fixture.append(f, `churn ${slot} ${runId}`, window.signal);
                  attempt.outcome = written ? "ok" : "paused";
                  if (written) { round.lines++; r.churn.linesAppended++; }
                } catch (error) { attempt.outcome = outcomeFor(window.signal); throw error; }
                finally { attempt.finishedAt = clock.now(); }
              }
            } finally { round.finishedAt = clock.now(); }
          }
          if (clock.now() < end) await clock.sleep(end - clock.now(), window.signal);
        } catch (e) { if (slot < r.churn.expectedRounds) { recordFailure("churn", window.signal, undefined, failureText(e)); r.churn.missedRounds += r.churn.expectedRounds - slot; } }
        finally { r.churn.endedAt = clock.now(); }
      })();
      const probes = io.routes({ port: opts.port!, durationMs: opts.durationMs, startAt: start, authHeaders: opts.authHeaders, signal: window.signal, clock, hookRequest: (signal, slot) => ownedHookUrl(opts.port!, fixture, population[slot % population.length], clock, signal) }).then(result => { Object.assign(r, result); }, e => { recordFailure("probes", window.signal, undefined, failureText(e)); });
      const sample = async (f: Fixture, trip: RoundTrip) => {
        trip.sessionId = f.sessionId; trip.conversationId = f.conversationId!;
        const leg = async (value: Leg, work: () => Promise<void>, startedAt = clock.now()) => {
          value.startedAt = startedAt; value.reason = undefined;
          try { window.signal.throwIfAborted(); await work(); window.signal.throwIfAborted(); value.outcome = "ok"; }
          catch (e) { value.outcome = outcomeFor(window.signal); value.reason = failureText(e); recordFailure("delivery", window.signal, f.sessionId, value.reason); }
          finally { value.finishedAt = clock.now(); value.ms = value.outcome === "ok" ? value.finishedAt - startedAt : null; }
        };
        const poll = async (value: Leg, check: () => Promise<boolean>) => {
          for (;;) { window.signal.throwIfAborted(); value.polls++; if (await check()) return; await clock.sleep(opts.pollMs ?? 250, window.signal); }
        };
        const upToken = `up-${randomUUID()}`;
        await leg(trip.up, async () => {
          if (!await fixture.append(f, upToken, window.signal)) throw new Error("up append refused");
          await poll(trip.up, () => exportedToken(io.post, f.conversationId!, upToken, "user", window.signal, { sessionId: f.sessionId, projectPath: fixture.scratch }));
        });
        const downToken = `pong-${randomUUID().replaceAll("-", "")}`;
        try {
          await fixture.pauseWrites(f);
          await fixture.verify(f, window.signal);
          const sentAt = clock.now();
          await leg(trip.injected, async () => {
            await io.post("/cli/messages/send", { to: f.conversationId, body: `codecast bench ${runId}: reply with ${downToken}` }, window.signal);
            await poll(trip.injected, () => fixture.hasToken(f, downToken, window.signal));
          }, sentAt);
          if (trip.injected.outcome === "ok") await leg(trip.echoed, () => poll(trip.echoed, () => exportedToken(io.post, f.conversationId!, downToken, "assistant", window.signal, { sessionId: f.sessionId, projectPath: fixture.scratch })), sentAt);
          else { trip.echoed.outcome = trip.injected.outcome; trip.echoed.reason = "injection failed"; }
        } catch { recordFailure("delivery ownership", window.signal, f.sessionId); trip.injected.outcome = outcomeFor(window.signal); trip.injected.reason = "ownership or cancellation"; trip.echoed.outcome = trip.injected.outcome; }
        finally { if (trip.echoed.outcome === "ok") fixture.resumeWrites(f); }
        trip.upMs = trip.up.ms; trip.injectedMs = trip.injected.ms; trip.echoedMs = trip.echoed.ms;
      };
      const deliveries = (async () => {
        for (let i = 0; i < opts.sample; i++) await sample(population[i], r.roundTrips[i]);
      })();
      try { await Promise.all([churn, probes, deliveries]); }
      finally { await window.close(); r.window.finishedAt = clock.now(); }
    });
  } catch (e) { recordFailure("run", overall.signal, undefined, failureText(e)); }
  finally {
    await overall.close();
    await phase("cleanup", async () => {
      const cleanup = deadlineSignal(clock, clock.now() + Math.max(10000, fixture.fixtures.length * 6000));
      try {
        r.scratchDir = fixture.scratch;
        if (opts.keep) r.teardown.warnings.push("resources retained by --keep");
        else {
          for (const f of fixture.fixtures) {
            try { await fixture.cleanup(f, cleanup.signal); }
            catch (e) { r.teardown.warnings.push(`fixture ${f.sessionId} cleanup failed or ownership refused: ${failureText(e)}`); }
          }
          if (fixture.scratch && !r.teardown.warnings.length) {
            try {
              let done = false;
              for (let page = 0; page < 50; page++) {
                const result = await io.post("/cli/conversations/delete-by-path", { path_prefix: fixture.scratch }, cleanup.signal);
                if (!Number.isInteger(result.conversationsDeleted) || result.conversationsDeleted < 0 || typeof result.hasMore !== "boolean") throw new Error("invalid cleanup response");
                r.teardown.conversationsDeleted += result.conversationsDeleted;
                if (!result.hasMore) { done = true; break; }
              }
              if (!done || r.teardown.conversationsDeleted !== r.mapped) throw new Error("backend deletion incomplete or unexpected count");
              await fixture.finish();
            } catch (e) { r.teardown.warnings.push(`backend or file cleanup incomplete: ${failureText(e)}`); }
          }
          r.teardown.verified = r.teardown.warnings.length === 0;
        }
        try { r.after = await observe(); } catch { recordFailure("runtime after", cleanup.signal); }
      } finally { await cleanup.close(); }
    });
    (process as NodeJS.EventEmitter).off("SIGINT", onInt); (process as NodeJS.EventEmitter).off("SIGTERM", onTerm); opts.signal?.removeEventListener("abort", onAbort);
  }
  r.spawnMs = summarizeLatency(r.startup.flatMap(s => s.spawnedAt === null ? [] : [s.spawnedAt - s.startedAt]));
  r.mappingMs = summarizeLatency(r.startup.flatMap(s => s.mappedAt === null ? [] : [s.mappedAt - s.startedAt]));
  r.upMs = summarizeLatency(r.roundTrips.flatMap(t => t.up.ms === null ? [] : [t.up.ms]));
  r.injectedMs = summarizeLatency(r.roundTrips.flatMap(t => t.injected.ms === null ? [] : [t.injected.ms]));
  r.echoedMs = summarizeLatency(r.roundTrips.flatMap(t => t.echoed.ms === null ? [] : [t.echoed.ms]));
  if (cancellation.signal.aborted) recordFailure("cancellation", cancellation.signal);
  const reasons = measurementFailures(r);
  r.acceptance = { status: reasons.length ? "FAIL" : "NOT ESTABLISHED", reasons: [...reasons, ...(r.n !== 200 ? ["N=200 not measured"] : []), "independent F3 acceptance, boot blackout and runtime routing proof require parent verification"] };
  return r;
}
