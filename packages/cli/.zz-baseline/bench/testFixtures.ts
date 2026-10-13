import type { BenchClock, ProbeFetch } from "./probes.js";
import type { Fixture } from "./fixture.js";
import type { FixtureIO, LoadDeps, LoadIO, LoadOptions, RuntimeIdentity } from "./load.js";
import { runRouteProbes } from "./probes.js";

export class FakeClock implements BenchClock {
  time = 0;
  timers = new Set<{ at: number; done: () => void }>();
  now = () => this.time;
  wall = () => 1788640000000 + this.time;
  sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { this.timers.delete(timer); signal?.removeEventListener("abort", abort); resolve(); };
    const timer = { at: this.time + Math.max(0, ms), done };
    const abort = () => { this.timers.delete(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    this.timers.add(timer); signal?.addEventListener("abort", abort, { once: true });
  });
  async drive<T>(work: Promise<T>): Promise<T> {
    let done = false; let value: T; let error: unknown;
    work.then(v => { done = true; value = v; }, e => { done = true; error = e; });
    for (let turn = 0; turn < 10000 && !done; turn++) {
      for (let flush = 0; flush < 100; flush++) await Promise.resolve();
      if (done) break;
      const at = Math.min(...Array.from(this.timers, t => t.at));
      if (!Number.isFinite(at)) throw new Error("virtual work stalled without a timer");
      this.time = Math.max(this.time, at);
      for (const timer of [...this.timers]) if (timer.at <= this.time) timer.done();
    }
    if (!done) throw new Error("virtual work exceeded finite scheduler steps");
    if (error) throw error;
    return value!;
  }
}
export const runtimeIdentity: RuntimeIdentity = { pid: 123, processIdentity: "owned runtime", build: "fixture-build", runtime: "fixture-runtime", workerSetting: true, workerRouting: "fixture-observed", configHash: "fixture-config" };
export const loadOptions: LoadOptions = { n: 2, sample: 1, durationMs: 3000, churnIntervalMs: 100, keep: false, port: 43210, authHeaders: { Authorization: "Bearer private-fake" }, pollMs: 100, mappingTimeoutMs: 500, totalTimeoutMs: 6000 };
export const loadDeps: LoadDeps = { config: {} as LoadDeps["config"], siteUrl: "http://127.0.0.1:43210", apiToken: "private-fake-api", configDir: "/unused-private-fixture", getDaemonPid: () => 123, observeRuntime: async () => ({ ...runtimeIdentity }) };

export function fakeLoad(clock = new FakeClock()) {
  const calls: { name: string; at: number; id?: string }[] = [];
  let fail = "";
  let hook: ((name: string, f?: Fixture) => void) | null = null;
  const touch = (name: string, f?: Fixture) => { calls.push({ name, at: clock.now(), id: f?.sessionId }); hook?.(name, f); if (fail === name) throw new Error(`private failure ${name}`); };
  const text = new Map<string, string[]>();
  const paused = new Set<string>();
  const clean: string[] = [];
  const f: FixtureIO = {
    scratch: "", fixtures: [],
    async prepare(signal) { touch("prepare"); f.scratch = "/private-bench-run"; signal.throwIfAborted(); },
    allocate() {
      const id = `fixture-${f.fixtures.length}`;
      const row: Fixture = { sessionId: id, tmuxSession: `tmux-${id}`, jsonlPath: `/private-bench-run/${id}.jsonl`, registryPath: `/private-bench-run/${id}.json`, statusPath: `/private-bench-run/${id}.status.json`, created: false };
      f.fixtures.push(row); touch("allocate", row); return row;
    },
    async spawn(row, signal) { touch("spawn", row); row.created = true; row.pid = 1000 + f.fixtures.length; await clock.sleep(20, signal); text.set(row.sessionId, [`boot-${row.sessionId}`]); },
    async recordHook(row, stamp) { row.lastHook = stamp; },
    async verify(row, signal) { touch("verify", row); signal.throwIfAborted(); },
    async mapping(row) { touch("mapping", row); return `conv-${row.sessionId}`; },
    async append(row, value, signal) { touch("append", row); await clock.sleep(2, signal); if (paused.has(row.sessionId)) return false; text.get(row.sessionId)!.push(value); return true; },
    async pauseWrites(row) { touch("pause", row); paused.add(row.sessionId); },
    resumeWrites(row) { touch("resume", row); paused.delete(row.sessionId); },
    async hasToken(row, token, signal) { touch("hasToken", row); await clock.sleep(10, signal); return text.get(row.sessionId)!.includes(token); },
    async cleanup(row) { touch("cleanup", row); clean.push(row.sessionId); row.transcriptVerified = true; row.transcriptLines = 2; },
    async finish() { touch("finish"); },
  };
  const transport: ProbeFetch = async (url, init) => {
    touch("route"); await clock.sleep(10, init.signal ?? undefined);
    if (url.includes("/hook/status?")) { const q = new URL(url).searchParams; if (!f.fixtures.some(row => row.sessionId === q.get("session_id") && row.jsonlPath === q.get("transcript_path"))) throw new Error("wrong hook ownership"); }
    return new Response("ok", { status: url.endsWith("/hook/status") ? 400 : 200 });
  };
  const io: LoadIO = { clock, fixture: () => f, routes: opts => runRouteProbes({ ...opts, fetch: transport }),
    post: async (route, body, signal) => {
      touch(route); await clock.sleep(10, signal);
      if (route === "/cli/conversations/delete-by-path") return { conversationsDeleted: f.fixtures.filter(row => row.conversationId).length, hasMore: false };
      const row = f.fixtures.find(row => `conv-${row.sessionId}` === (body.conversation_id ?? body.to))!;
      if (route === "/cli/messages/send") { await clock.sleep(250, signal); text.get(row.sessionId)!.push(String(body.body).match(/pong-[a-z0-9]+/)![0]); return { ok: true }; }
      return { conversation: { id: `conv-${row.sessionId}`, session_id: row.sessionId, project_path: f.scratch }, messages: (text.get(row.sessionId) ?? []).flatMap(content => [{ role: "user", content }, { role: "assistant", content }]), done: true };
    },
  };
  return { clock, io, fixture: f, calls, clean, setFail: (name: string) => { fail = name; }, setHook: (fn: typeof hook) => { hook = fn; } };
}
