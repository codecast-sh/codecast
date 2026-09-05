import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { STUB_SOURCE, resolveStubRuntime, pickDoctorProjectDir } from "../doctor.js";
import { spawnHarness, shellQuote } from "../test-helpers/messagingHarness.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { benchClock, type BenchClock } from "./probes.js";
import type { Config } from "../config/types.js";

export interface Fixture {
  sessionId: string;
  tmuxSession: string;
  jsonlPath: string;
  registryPath: string;
  created: boolean;
  paneId?: string;
  tmuxId?: string;
  pid?: number;
  processIdentity?: string;
  registryIdentity?: string;
  conversationId?: string;
}

export function childProcess(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", signal, killSignal: "SIGKILL", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export class BenchFixture {
  readonly fixtures: Fixture[] = [];
  scratch = "";
  projectDir = "";
  private scratchIdentity = "";
  private stubPath = "";
  private runtime = "";
  private readonly writing = new Map<string, Promise<unknown>>();
  readonly delivering = new Set<string>();
  constructor(readonly runId: string, private config: Config, private configDir: string, private options: { projectDir?: string; home?: string; socket?: string; clock?: BenchClock } = {}) {}
  private get clock() { return this.options.clock ?? benchClock; }
  private tmuxArgs(args: string[]) { return [...(this.options.socket ? ["-S", this.options.socket, "-f", "/dev/null"] : []), ...args]; }
  private tmux(args: string[], signal?: AbortSignal) { return childProcess("tmux", this.tmuxArgs(args), signal); }
  async prepare(signal: AbortSignal) {
    signal.throwIfAborted();
    this.runtime = resolveStubRuntime() ?? "";
    if (!this.runtime) throw new Error("stub runtime unavailable");
    const candidate = pickDoctorProjectDir(this.config, this.runId, this.options.projectDir ? path.join(this.options.projectDir, this.runId) : undefined);
    if (!candidate) throw new Error("no syncable scratch parent");
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    this.scratch = await fs.mkdtemp(`${candidate}-`);
    this.scratch = await fs.realpath(this.scratch);
    const stat = await fs.lstat(this.scratch);
    this.scratchIdentity = `${stat.dev}:${stat.ino}`;
    this.stubPath = path.join(this.scratch, "stub.cjs");
    await fs.writeFile(this.stubPath, STUB_SOURCE, { flag: "wx" });
    this.projectDir = path.join(this.options.home ?? os.homedir(), ".claude", "projects", claudeProjectDirName(this.scratch));
    await fs.mkdir(this.projectDir, { recursive: false });
    signal.throwIfAborted();
  }
  allocate(): Fixture {
    const sessionId = randomUUID();
    const f = { sessionId, tmuxSession: `${this.runId}-${sessionId}`, jsonlPath: path.join(this.projectDir, `${sessionId}.jsonl`), registryPath: path.join(this.configDir, "session-registry", `${sessionId}.json`), created: false };
    this.fixtures.push(f);
    return f;
  }
  async spawn(f: Fixture, signal: AbortSignal) {
    this.member(f);
    signal.throwIfAborted();
    const command = `DOCTOR_BOOT_TOKEN=${shellQuote(`boot-${f.sessionId}`)} exec ${shellQuote(this.runtime)} ${shellQuote(this.stubPath)} ${shellQuote(f.sessionId)} ${shellQuote(f.jsonlPath)} ${shellQuote(f.registryPath)}`;
    spawnHarness({ cwd: this.scratch, sessionId: f.sessionId, jsonlPath: f.jsonlPath, tmuxSession: f.tmuxSession, command, singleAttempt: true,
      onCreated: () => { f.created = true; },
      runTmux: (args, opts) => {
        const r = spawnSync("tmux", this.tmuxArgs(args), { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", env: { ...process.env, ...opts?.env } });
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    });
    const pane = await this.pane(f, signal);
    if (!pane) throw new Error("new fixture pane missing");
    [f.tmuxId, f.paneId] = pane;
    f.pid = Number(pane[2]);
    while (!await this.registry(f)) await this.clock.sleep(25, signal);
    f.registryIdentity = JSON.stringify(await this.registry(f));
    f.processIdentity = await this.process(f, signal);
    await this.verify(f, signal);
  }
  private member(f: Fixture) {
    if (!this.fixtures.includes(f) || f.tmuxSession !== `${this.runId}-${f.sessionId}` || f.jsonlPath !== path.join(this.projectDir, `${f.sessionId}.jsonl`) || f.registryPath !== path.join(this.configDir, "session-registry", `${f.sessionId}.json`)) throw new Error("fixture ownership refused");
  }
  private async pane(f: Fixture, signal?: AbortSignal): Promise<string[] | null> {
    const raw = await this.tmux(["list-panes", "-a", "-F", "#{session_name}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{session_windows}|#{window_panes}"], signal);
    const rows = raw.trim().split("\n").map(r => r.split("|")).filter(r => r[0] === f.tmuxSession);
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0][5] !== "1" || rows[0][6] !== "1") throw new Error("fixture has unexpected panes");
    return rows[0].slice(1);
  }
  private async registry(f: Fixture): Promise<{ pid: number; term: string } | null> {
    try { return JSON.parse(await fs.readFile(f.registryPath, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async process(f: Fixture, signal?: AbortSignal) {
    if (!f.pid || f.pid <= 1) throw new Error("missing fixture PID");
    const raw = (await childProcess("ps", ["-p", String(f.pid), "-o", "uid=,lstart=,args="], signal)).trim();
    if (!raw.includes(this.stubPath) || !raw.includes(f.sessionId) || !raw.includes(f.jsonlPath) || Number(raw.split(/\s+/)[0]) !== process.getuid?.()) throw new Error("fixture process changed");
    return raw;
  }
  async verify(f: Fixture, signal: AbortSignal) {
    this.member(f);
    signal.throwIfAborted();
    const pane = await this.pane(f, signal);
    if (!pane || pane[0] !== f.tmuxId || pane[1] !== f.paneId || Number(pane[2]) !== f.pid || !/^(node|bun)$/.test(pane[3])) throw new Error("fixture pane changed");
    if (JSON.stringify(await this.registry(f)) !== f.registryIdentity || (await this.registry(f))?.pid !== f.pid) throw new Error("fixture registry changed");
    if (await this.process(f, signal) !== f.processIdentity) throw new Error("fixture process identity changed");
    signal.throwIfAborted();
  }
  async mapping(f: Fixture) {
    this.member(f);
    let cache: Record<string, unknown>;
    try { cache = JSON.parse(await fs.readFile(path.join(this.configDir, "conversations.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    return typeof cache[f.sessionId] === "string" ? cache[f.sessionId] as string : null;
  }
  async append(f: Fixture, text: string, signal: AbortSignal) {
    this.member(f);
    const prior = this.writing.get(f.sessionId) ?? Promise.resolve();
    const work = prior.then(async () => {
      signal.throwIfAborted();
      if (this.delivering.has(f.sessionId)) return false;
      const line = JSON.stringify({ uuid: randomUUID(), sessionId: f.sessionId, cwd: this.scratch, timestamp: new Date(this.clock.wall()).toISOString(), type: "user", message: { role: "user", content: text } }) + "\n";
      await fs.appendFile(f.jsonlPath, line, { signal });
      return true;
    });
    this.writing.set(f.sessionId, work);
    try { return await work; } finally { if (this.writing.get(f.sessionId) === work) this.writing.delete(f.sessionId); }
  }
  async pauseWrites(f: Fixture) { this.delivering.add(f.sessionId); await this.writing.get(f.sessionId); }
  resumeWrites(f: Fixture) { this.delivering.delete(f.sessionId); }
  async hasToken(f: Fixture, token: string, signal: AbortSignal) {
    this.member(f);
    const file = await fs.open(f.jsonlPath, "r");
    try {
      const size = (await file.stat()).size;
      const chunk = Buffer.alloc(Math.min(size, 64 * 1024));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, Math.max(0, size - chunk.length));
      signal.throwIfAborted();
      return chunk.subarray(0, bytesRead).toString("utf8").includes(token);
    } finally { await file.close(); }
  }
  async cleanup(f: Fixture, signal: AbortSignal) {
    this.member(f);
    if (f.created) {
      if (!f.processIdentity || !f.registryIdentity) throw new Error("incomplete fixture custody; retained for inspection");
      await this.verify(f, signal);
      const condition = `#{&&:#{==:#{session_id},${f.tmuxId}},#{&&:#{==:#{pane_pid},${f.pid}},#{==:#{pane_id},${f.paneId}}}}`;
      const result = await this.tmux(["if-shell", "-F", "-t", f.paneId!, condition, `kill-pane -t ${f.paneId} ; display-message -p removed`, "display-message -p refused"], signal);
      if (result.trim() !== "removed") throw new Error("fixture cleanup refused");
      const processes = await childProcess("ps", ["-axo", "pid=,args="], signal);
      if (processes.split("\n").some(r => Number(r.trim().split(/\s+/)[0]) === f.pid)) throw new Error("fixture process still present");
      const remaining = await this.tmux(["list-panes", "-a", "-F", "#{pane_id}|#{session_name}"], signal).catch(async e => {
        if (this.options.socket && !await fs.stat(this.options.socket).then(() => true, () => false)) return "";
        throw e;
      });
      if (remaining.split("\n").some(r => r === `${f.paneId}|${f.tmuxSession}` || r.endsWith(`|${f.tmuxSession}`))) throw new Error("fixture pane still present");
    }
    if (await this.registry(f) && JSON.stringify(await this.registry(f)) !== f.registryIdentity) throw new Error("refuse changed registry removal");
    await fs.rm(f.registryPath, { force: true });
    await fs.rm(f.jsonlPath, { force: true });
  }
  async finish() {
    if (!this.scratch) return;
    const stat = await fs.lstat(this.scratch);
    if (stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== this.scratchIdentity) throw new Error("scratch ownership changed");
    if (this.projectDir) await fs.rmdir(this.projectDir);
    await fs.unlink(this.stubPath);
    await fs.rmdir(this.scratch);
  }
}
