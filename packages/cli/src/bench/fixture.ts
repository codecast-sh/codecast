import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { STUB_SOURCE, resolveStubRuntime, pickDoctorProjectDir } from "../doctor.js";
import { spawnHarness, shellQuote } from "../test-helpers/messagingHarness.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { benchClock, deadlineSignal, type BenchClock } from "./probes.js";
import type { Config } from "../config/types.js";

export interface Fixture {
  sessionId: string;
  tmuxSession: string;
  jsonlPath: string;
  registryPath: string;
  statusPath: string;
  lastHook?: { ts: number; message: string };
  created: boolean;
  paneId?: string;
  tmuxId?: string;
  pid?: number;
  processIdentity?: string;
  registryIdentity?: string;
  conversationId?: string;
  transcriptLines?: number;
  transcriptVerified?: boolean;
}

export function childProcess(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure: Error | null = null;
    let output = "";
    const child = execFile(command, args, { encoding: "utf8", signal, killSignal: "SIGKILL", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      failure = error ? Object.assign(error, { stdout, stderr }) : null;
      output = stdout;
    });
    child.once("close", () => { if (failure) reject(failure); else resolve(output); });
  });
}

export class BenchFixture {
  readonly fixtures: Fixture[] = [];
  scratch = "";
  projectDir = "";
  private scratchIdentity = "";
  private stubPath = "";
  private runtime = "";
  private projectCreated = false;
  private stubCreated = false;
  private ledgerCreated = false;
  private ledgerWrites: Promise<void> = Promise.resolve();
  private readonly allocation = new Map<Fixture, string>();
  private readonly transcriptIdentity = new Map<Fixture, string>();
  private readonly hooks = new Map<Fixture, string>();
  private readonly custody = new Map<Fixture, string>();
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
    this.stubCreated = true;
    this.projectDir = path.join(this.options.home ?? os.homedir(), ".claude", "projects", claudeProjectDirName(this.scratch));
    await fs.mkdir(path.dirname(this.projectDir), { recursive: true });
    await fs.mkdir(this.projectDir, { recursive: false });
    this.projectCreated = true;
    await this.checkpoint();
    signal.throwIfAborted();
  }
  private checkpoint() {
    const body = JSON.stringify({ runId: this.runId, scratch: this.scratch, resources: this.fixtures }, null, 2);
    const target = path.join(this.scratch, "fixture-ledger.json");
    this.ledgerWrites = this.ledgerWrites.then(async () => { await fs.writeFile(`${target}.tmp`, body, { mode: 0o600 }); await fs.rename(`${target}.tmp`, target); this.ledgerCreated = true; });
    return this.ledgerWrites;
  }
  allocate(): Fixture {
    const sessionId = randomUUID();
    const f = { sessionId, tmuxSession: `${this.runId}-${sessionId}`, jsonlPath: path.join(this.projectDir, `${sessionId}.jsonl`), registryPath: path.join(this.configDir, "session-registry", `${sessionId}.json`), statusPath: path.join(this.configDir, "agent-status", `${sessionId}.json`), created: false };
    this.fixtures.push(f);
    this.allocation.set(f, this.allocationKey(f));
    return f;
  }
  async spawn(f: Fixture, signal: AbortSignal) {
    this.member(f);
    signal.throwIfAborted();
    await this.checkpoint();
    const command = `DOCTOR_BOOT_TOKEN=${shellQuote(`boot-${f.sessionId}`)} exec ${shellQuote(this.runtime)} ${shellQuote(this.stubPath)} ${shellQuote(f.sessionId)} ${shellQuote(f.jsonlPath)} ${shellQuote(f.registryPath)}`;
    spawnHarness({ cwd: this.scratch, sessionId: f.sessionId, jsonlPath: f.jsonlPath, tmuxSession: f.tmuxSession, command, singleAttempt: true,
      onCreated: () => { f.created = true; },
      runTmux: (args, opts) => {
        const r = spawnSync("tmux", this.tmuxArgs(args), { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", env: { ...process.env, ...opts?.env } });
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
    });
    const acquisition = deadlineSignal(this.clock, this.clock.now() + 5000);
    try {
      const pane = await this.pane(f, acquisition.signal);
      if (!pane) throw new Error("new fixture pane missing");
      [f.tmuxId, f.paneId] = pane;
      f.pid = Number(pane[2]);
      while (!await this.registry(f)) await this.clock.sleep(25, acquisition.signal);
      f.registryIdentity = JSON.stringify(await this.registry(f));
      f.processIdentity = await this.process(f, acquisition.signal);
      const transcript = await fs.lstat(f.jsonlPath);
      if (!transcript.isFile() || transcript.isSymbolicLink()) throw new Error("invalid fixture transcript path");
      this.transcriptIdentity.set(f, `${transcript.dev}:${transcript.ino}`);
      this.custody.set(f, this.custodyKey(f));
      await this.checkpoint();
      await this.verify(f, acquisition.signal);
      signal.throwIfAborted();
    } finally { await acquisition.close(); }
  }
  private allocationKey(f: Fixture) { return JSON.stringify([f.sessionId, f.tmuxSession, f.jsonlPath, f.registryPath, f.statusPath]); }
  private custodyKey(f: Fixture) { return JSON.stringify([f.tmuxId, f.paneId, f.pid, f.processIdentity, f.registryIdentity]); }
  private member(f: Fixture) {
    if (this.allocation.get(f) !== this.allocationKey(f) || !this.fixtures.includes(f) || f.tmuxSession !== `${this.runId}-${f.sessionId}` || f.jsonlPath !== path.join(this.projectDir, `${f.sessionId}.jsonl`) || f.registryPath !== path.join(this.configDir, "session-registry", `${f.sessionId}.json`)) throw new Error("fixture ownership refused");
  }
  private async pane(f: Fixture, signal?: AbortSignal): Promise<string[] | null> {
    let raw: string;
    try {
      await this.tmux(["has-session", "-t", `=${f.tmuxSession}`], signal);
      raw = await this.tmux(["display-message", "-p", "-t", `=${f.tmuxSession}:0.0`, "#{session_name}|#{session_id}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{session_windows}|#{window_panes}"], signal); }
    catch (e) {
      const error = e as { code?: number; stderr?: string };
      if (error.code === 1 && /can't find|no server running|error connecting.*No such file/.test(error.stderr ?? "")) return null;
      throw e;
    }
    const row = raw.trim().split("|");
    if (row[0] !== f.tmuxSession || row[5] !== "1" || row[6] !== "1") throw new Error("fixture has unexpected panes");
    return row.slice(1);
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
    if (this.custody.get(f) !== this.custodyKey(f)) throw new Error("fixture custody changed");
    const pane = await this.pane(f, signal);
    if (!pane || pane[0] !== f.tmuxId || pane[1] !== f.paneId || Number(pane[2]) !== f.pid || !/^(node|bun)$/.test(pane[3])) throw new Error("fixture pane changed");
    if (JSON.stringify(await this.registry(f)) !== f.registryIdentity || (await this.registry(f))?.pid !== f.pid) throw new Error("fixture registry changed");
    if (await this.process(f, signal) !== f.processIdentity) throw new Error("fixture process identity changed");
    signal.throwIfAborted();
  }
  async recordHook(f: Fixture, stamp: { ts: number; message: string }) { this.member(f); f.lastHook = stamp; this.hooks.set(f, JSON.stringify(stamp)); await this.checkpoint(); }
  async mapping(f: Fixture) {
    this.member(f);
    let cache: Record<string, unknown>;
    try { cache = JSON.parse(await fs.readFile(path.join(this.configDir, "conversations.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    return typeof cache[f.sessionId] === "string" ? cache[f.sessionId] as string : null;
  }
  private async openTranscript(f: Fixture, flags: number) {
    const file = await fs.open(f.jsonlPath, flags | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (`${stat.dev}:${stat.ino}` !== this.transcriptIdentity.get(f)) throw new Error("fixture transcript replaced");
      return file;
    } catch (error) { await file.close(); throw error; }
  }
  async append(f: Fixture, text: string, signal: AbortSignal) {
    this.member(f);
    const prior = this.writing.get(f.sessionId) ?? Promise.resolve();
    const work = prior.then(async () => {
      signal.throwIfAborted();
      if (this.delivering.has(f.sessionId)) return false;
      const line = JSON.stringify({ uuid: randomUUID(), sessionId: f.sessionId, cwd: this.scratch, timestamp: new Date(this.clock.wall()).toISOString(), type: "user", message: { role: "user", content: text } }) + "\n";
      const file = await this.openTranscript(f, constants.O_WRONLY | constants.O_APPEND);
      try {
        const bytes = Buffer.from(line);
        const written = await file.write(bytes);
        if (written.bytesWritten !== bytes.byteLength) throw new Error("partial transcript append");
        signal.throwIfAborted();
      } finally { await file.close(); }
      return true;
    });
    this.writing.set(f.sessionId, work);
    try { return await work; } finally { if (this.writing.get(f.sessionId) === work) this.writing.delete(f.sessionId); }
  }
  async pauseWrites(f: Fixture) { this.delivering.add(f.sessionId); await this.writing.get(f.sessionId); }
  resumeWrites(f: Fixture) { this.delivering.delete(f.sessionId); }
  async hasToken(f: Fixture, token: string, signal: AbortSignal) {
    this.member(f);
    const file = await this.openTranscript(f, constants.O_RDONLY);
    try {
      const size = (await file.stat()).size;
      const chunk = Buffer.alloc(Math.min(size, 64 * 1024));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, Math.max(0, size - chunk.length));
      signal.throwIfAborted();
      return chunk.subarray(0, bytesRead).toString("utf8").includes(token);
    } finally { await file.close(); }
  }
  private async processPresent(f: Fixture, signal: AbortSignal) {
    try { await childProcess("ps", ["-p", String(f.pid), "-o", "pid="], signal); return true; }
    catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      if (e.code === 1 && !e.stdout?.trim() && !e.stderr?.trim()) return false;
      throw error;
    }
  }
  async cleanup(f: Fixture, signal: AbortSignal) {
    this.member(f);
    if (!f.created && await this.pane(f, signal)) throw new Error("partial spawn with unknown custody");
    if (f.created) {
      if (!f.processIdentity || !f.registryIdentity) throw new Error("incomplete fixture custody; retained for inspection");
      if (this.custody.get(f) !== this.custodyKey(f)) throw new Error("fixture custody changed");
      const pane = await this.pane(f, signal);
      if (pane) {
      await this.verify(f, signal);
      const condition = `#{&&:#{==:#{session_id},${f.tmuxId}},#{&&:#{==:#{pane_pid},${f.pid}},#{==:#{pane_id},${f.paneId}}}}`;
      const result = await this.tmux(["if-shell", "-F", "-t", f.paneId!, condition, `display-message -p removing ; kill-pane -t ${f.paneId}`, "display-message -p refused"], signal);
      if (result.trim() !== "removing") throw new Error("fixture cleanup refused");
      } else if (await this.processPresent(f, signal)) throw new Error("fixture process exists without owned pane");
      for (;;) {
        signal.throwIfAborted();
        if (!await this.processPresent(f, signal) && !await this.pane(f, signal)) break;
        await this.clock.sleep(25, signal);
      }
      const handle = await this.openTranscript(f, constants.O_RDONLY);
      try {
        let carry = "", count = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for await (const chunk of handle.readableWebStream()) {
          signal.throwIfAborted();
          carry += decoder.decode(chunk, { stream: true });
          const lines = carry.split("\n"); carry = lines.pop()!;
          if (carry.length > 256 * 1024) throw new Error("oversized fixture line");
          for (const line of lines) {
            const row = JSON.parse(line);
            if (row.sessionId !== f.sessionId || row.cwd !== this.scratch || !["user", "assistant"].includes(row.type) || row.message?.role !== row.type) throw new Error("invalid fixture transcript");
            count++;
          }
        }
        carry += decoder.decode();
        if (carry || count < 2) throw new Error("incomplete fixture transcript");
        f.transcriptLines = count; f.transcriptVerified = true;
      } finally { await handle.close(); }
    }
    if (f.lastHook) {
      if (this.hooks.get(f) !== JSON.stringify(f.lastHook)) throw new Error("hook custody changed");
      for (;;) {
        signal.throwIfAborted();
        const raw = await fs.readFile(f.statusPath, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
        const status = raw ? JSON.parse(raw) : null;
        if (status?.message === f.lastHook.message && status.ts === f.lastHook.ts && status.transcript_path === f.jsonlPath) break;
        await this.clock.sleep(25, signal);
      }
      await fs.unlink(f.statusPath);
    } else if (await fs.lstat(f.statusPath).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; })) throw new Error("unowned status file");
    if (await this.registry(f) && JSON.stringify(await this.registry(f)) !== f.registryIdentity) throw new Error("refuse changed registry removal");
    await fs.rm(f.registryPath, { force: true });
    await fs.rm(f.jsonlPath, { force: true });
  }
  async finish() {
    if (!this.scratch) return;
    const stat = await fs.lstat(this.scratch);
    if (stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== this.scratchIdentity) throw new Error("scratch ownership changed");
    if (this.projectCreated) await fs.rmdir(this.projectDir).catch(e => { if (e.code !== "ENOENT") throw e; });
    await this.ledgerWrites;
    if (this.ledgerCreated) await fs.unlink(path.join(this.scratch, "fixture-ledger.json"));
    if (this.stubCreated) await fs.unlink(this.stubPath);
    await fs.rmdir(this.scratch);
  }
}
