/**
 * The host side of `cast run`: one self-contained function the laptop ships
 * to the host as `(${hostRunnerMain})(process.argv.slice(2))` and runs with
 * the host's bun (run/client.ts). It must not reference anything outside its
 * own body, because only its source travels: node modules come from
 * `process.getBuiltinModule`, never an import, and no helper lives outside.
 *
 * State lives under ~/.codecast/run on the host (CAST_RUN_ROOT overrides it):
 *   runs/<id>/     spec.json, state.json, log (framed stdout, stderr and
 *                  cast's own notes, in the order they happened), outputs.tgz
 *   slots/<repo>/  pooled git worktrees a run checks its snapshot out into
 *   deps/<key>/    one installed dependency tree per sha256(lockfiles), the
 *                  "golden" each slot mounts or clones (overlayfs, reflink,
 *                  hardlinks, in that order) instead of installing
 *
 * `submit` is idempotent by run id, so a client that lost the answer can ask
 * again and never starts a second copy. The run itself executes in a detached
 * `exec` process, so a client that dies (an agent's tool call timing out)
 * leaves it running; `follow` re-attaches from the start of its logs.
 * Ideas from pandora (MIT): pandora/engine/runner.py, pandora/executor/incus.py.
 */

import { runnerSlots, type SlotMeta, type SlotsCtx } from "./runnerSlots.js";

export type RunPhase = "queued" | "preparing" | "running" | "collecting" | "done";

export type RunReason = "oom" | "timeout" | "cancelled" | "busy" | "setup" | "lost" | "missing-program";

export interface RunSpecWire {
  id: string;
  /** The repo on the host the snapshot was pushed into. */
  repo: string;
  sha: string;
  cwdRel: string;
  argv: string[];
  env: Record<string, string>;
  outputs: string[];
  memoryGb: number;
  timeoutMin: number;
  install: string[];
  depsKey: string[];
  keepDeps: number;
  queueWaitS: number;
  /** Let helpers the command starts outlive it (no memory scope). */
  keepDaemons?: boolean;
  /** The repo's [ports]: each slot gets its own value of each, so parallel runs never bind the same port. */
  ports?: Record<string, { base: number; range: number }>;
  slots?: number;
  ref?: string;
}

export interface RunDeps {
  key: string;
  warm: boolean;
  clone: "overlay" | "reflink" | "hardlink" | "kept" | "none";
  ms: number;
  installMs?: number;
}

export interface RunStateWire {
  id: string;
  phase: RunPhase;
  host: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  pid?: number;
  /** The host's boot id when the runner started: a pid from before a reboot means nothing. */
  boot?: string;
  pidStart?: string;
  cmdPid?: number;
  slot?: number;
  code?: number;
  reason?: RunReason;
  hint?: string;
  deps?: RunDeps;
  timings: Record<string, number>;
  outputs?: { files: number; bytes: number };
}

export interface HostInfoWire {
  host: string;
  cpus: number;
  memAvailGb: number;
  memTotalGb: number;
  /** Free disk where runs live. */
  diskFreeGb?: number;
  load1: number;
  active: number;
  queued: number;
  slots: number;
}

export async function hostRunnerMain(args: string[], parts: { slots: typeof runnerSlots }): Promise<number> {
  const gbm = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule;
  const fs = gbm("node:fs") as typeof import("node:fs");
  const path = gbm("node:path") as typeof import("node:path");
  const os = gbm("node:os") as typeof import("node:os");
  const cp = gbm("node:child_process") as SlotsCtx["cp"];
  const crypto = gbm("node:crypto") as typeof import("node:crypto");

  // The platform comes from os, never from the process object: `bun build --compile` bakes the laptop's values into this source,
  // so a runner shipped from a Mac would think every Linux host is a Mac. os answers at run time, on the host.
  const PLATFORM = os.platform();
  const ARCH = os.arch();
  // The CLI's state directory, resolved here because this body cannot import codecastDir().
  const STATE_DIR = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  const ROOT = process.env.CAST_RUN_ROOT || path.join(STATE_DIR, "run");
  const RUNS = path.join(ROOT, "runs");
  const ID_RE = /^r[a-z0-9]{6,24}$/;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();

  const readJson = <T>(file: string): T | undefined => {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return undefined; }
  };
  const writeJson = (file: string, value: unknown) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  /** When a process started (Linux: clock ticks since boot), so a pid reused by another process is not taken for ours. */
  const procStart = (pid: number): string | undefined => {
    if (PLATFORM !== "linux") return undefined;
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf-8").split(") ").pop()!.split(" ")[19]; } catch { return undefined; }
  };
  const alive = (pid: number | undefined, start?: string) => {
    if (!pid) return false;
    // EPERM is a process of another user: a reused pid, never our runner.
    try { process.kill(pid, 0); } catch { return false; }
    return !start || procStart(pid) === undefined || procStart(pid) === start;
  };
  const sh = (cmd: string, argv: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}) => {
    const r = cp.spawnSync(cmd, argv, { cwd: opts.cwd, encoding: "utf-8", input: opts.input, maxBuffer: 256 * 1024 * 1024, ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}) });
    return { ok: r.status === 0, status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() || (r.error ? String(r.error) : "") };
  };
  const must = (cmd: string, argv: string[], what: string, cwd?: string) => {
    const r = sh(cmd, argv, { cwd });
    if (!r.ok) throw new SetupError(`${what} failed: ${r.err.split("\n").filter(Boolean).pop() ?? `exit ${r.status}`}`);
    return r.out;
  };
  class SetupError extends Error {}
  class Cancelled extends Error {}
  const INSTALL_TIMEOUT_MS = 20 * 60_000;

  const runDir = (id: string) => {
    if (!ID_RE.test(id)) throw new Error(`bad run id ${JSON.stringify(id)}`);
    return path.join(RUNS, id);
  };
  const stateFile = (id: string) => path.join(runDir(id), "state.json");
  const readState = (id: string) => readJson<RunStateWire>(stateFile(id));
  /** Submit, exec and follow all write state.json: each read-modify-write holds the run's lock. */
  const lockSync = <T>(dir: string, fn: () => T): T => {
    const tick = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(dir); break; } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        const age = now() - (fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now());
        if (age > 5000) fs.rmSync(dir, { recursive: true, force: true });
        Atomics.wait(tick, 0, 0, 10);
      }
    }
    try { return fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const patchState = (id: string, patch: Partial<RunStateWire>, when?: (cur: RunStateWire) => boolean) => lockSync(path.join(runDir(id), "state.lock"), () => {
    const cur = readState(id);
    if (!cur) throw new Error(`run ${id} has no state`);
    if (when && !when(cur)) return cur;
    const next = { ...cur, ...patch, timings: { ...cur.timings, ...(patch.timings ?? {}) } };
    writeJson(stateFile(id), next);
    return next;
  });
  const bootId = () => {
    if (PLATFORM === "linux") { try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim(); } catch {} }
    return sh("sysctl", ["-n", "kern.boottime"]).out || "unknown";
  };
  /** The run's log is frames of [stream: 1 stdout, 2 stderr, 3 cast note][u32 length][bytes], so a replay keeps the order. */
  const logFds = new Map<string, number>();
  const frame = (id: string, stream: 1 | 2 | 3, data: Buffer | string) => {
    const body = typeof data === "string" ? Buffer.from(data) : data;
    if (!body.length) return;
    let fd = logFds.get(id);
    if (fd === undefined) { fd = fs.openSync(path.join(runDir(id), "log"), "a", 0o600); logFds.set(id, fd); }
    const head = Buffer.alloc(5);
    head.writeUInt8(stream, 0);
    head.writeUInt32BE(body.length, 1);
    fs.writeSync(fd, Buffer.concat([head, body]));
  };
  const note = (id: string, line: string) => frame(id, 3, `cast: ${line}\n`);
  /** Every byte, whatever the pipe says: a short write continues, and a full non-blocking socket (EAGAIN) waits a moment. */
  const writeAll = (fd: number, data: Buffer) => {
    const tick = new Int32Array(new SharedArrayBuffer(4));
    for (let w = 0; w < data.length;) {
      try { w += fs.writeSync(fd, data, w, data.length - w); } catch (e) {
        if ((e as { code?: string }).code !== "EAGAIN") throw e;
        Atomics.wait(tick, 0, 0, 5);
      }
    }
  };

  async function withLock<T>(name: string, fn: () => T | Promise<T>, cancelled?: () => boolean): Promise<T> {
    const dir = path.join(ROOT, "locks", name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    for (;;) {
      try {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "pid"), `${process.pid} ${procStart(process.pid) ?? ""}`);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        if (cancelled?.()) throw new Cancelled();
        let holder = 0;
        let holderStart: string | undefined;
        // The holder may release between our mkdir and this read: a vanished lock is a free one.
        try { const [p, st] = fs.readFileSync(path.join(dir, "pid"), "utf-8").split(" "); holder = Number(p || 0); holderStart = st || undefined; } catch { continue; }
        const age = now() - (fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now());
        if ((holder && !alive(holder, holderStart)) || (!holder && age > 10_000)) fs.rmSync(dir, { recursive: true, force: true });
        else await sleep(50 + Math.random() * 100);
      }
    }
    try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  const memInfo = () => {
    if (PLATFORM === "linux") {
      const text = fs.readFileSync("/proc/meminfo", "utf-8");
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
      return { avail: kb("MemAvailable") / 1048576, total: kb("MemTotal") / 1048576 };
    }
    const vm = sh("vm_stat", []).out;
    const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 4096);
    const pages = (k: string) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
    const avail = vm ? (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page : os.freemem();
    return { avail: avail / 1073741824, total: os.totalmem() / 1073741824 };
  };
  const repoKey = (repo: string) => crypto.createHash("sha1").update(repo).digest("hex").slice(0, 10);
  const slotCount = (spec?: RunSpecWire) => spec?.slots ?? Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));

  const slotsDir = (repo: string) => path.join(ROOT, "slots", repoKey(repo));
  const slotMetaFile = (repo: string, n: number) => path.join(slotsDir(repo), `${n}.json`);
  const slotPath = (repo: string, n: number) => path.join(slotsDir(repo), String(n));

  const listRunIds = () => (fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((n) => ID_RE.test(n)) : []);

  /**
   * Runs that hold a slot now, on the whole host (memory and cores belong to
   * the host, not to a repo), after clearing slots whose exec process died.
   */
  const activeOwners = () => {
    const owners: Array<{ rk: string; slot: number; id: string; memoryGb: number; since: number; lane: number }> = [];
    const slotsRoot = path.join(ROOT, "slots");
    for (const rk of fs.existsSync(slotsRoot) ? fs.readdirSync(slotsRoot) : []) {
      for (const f of fs.readdirSync(path.join(slotsRoot, rk)).filter((f) => /^\d+\.json$/.test(f))) {
        const file = path.join(slotsRoot, rk, f);
        const meta = readJson<SlotMeta>(file);
        if (!meta?.owner) continue;
        if (!alive(meta.ownerPid, meta.ownerStart)) { writeJson(file, { ...meta, owner: undefined, ownerPid: undefined, ownerStart: undefined, since: undefined }); continue; }
        const spec = readJson<RunSpecWire>(path.join(RUNS, meta.owner, "spec.json"));
        owners.push({ rk, slot: Number(f.slice(0, -5)), id: meta.owner, memoryGb: spec?.memoryGb ?? 2, since: meta.since ?? 0, lane: meta.lane ?? -1 });
      }
    }
    return owners;
  };

  /** Overlay leaves root-owned, mode-000 dirs in its workdir after an unmount; those need sudo to go. */
  const rmTree = (dir: string) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {
      if (!["EACCES", "EPERM"].includes((e as { code?: string }).code ?? "") || !sh("sudo", ["-n", "rm", "-rf", "--", dir]).ok) throw e;
    }
  };
  let scopeOk: boolean | undefined;
  const killGroup = (pid: number | undefined, sig: NodeJS.Signals) => {
    if (!pid) return;
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
  };

  const collectOutputs = (spec: RunSpecWire, id: string, slot: string) => {
    const list = new Set<string>();
    for (const g of spec.outputs) {
      if (!/[*?[{]/.test(g)) { if (fs.existsSync(path.join(slot, g))) list.add(g); continue; }
      const named = g.split("/").includes("node_modules");
      for (const f of new Bun.Glob(g).scanSync({ cwd: slot, dot: true, onlyFiles: true })) {
        const parts = f.split("/");
        if (parts.includes(".git") || (!named && parts.includes("node_modules"))) continue;
        list.add(f);
      }
    }
    if (!list.size) return { files: 0, bytes: 0 };
    const listFile = path.join(runDir(id), "outputs.list");
    fs.writeFileSync(listFile, [...list].join("\0"));
    const tgz = path.join(runDir(id), "outputs.tgz");
    must("tar", ["-czf", tgz, "-C", slot, "--null", "-T", listFile], "pack outputs");
    const files = sh("tar", ["-tzf", tgz]).out.split("\n").filter((l) => l && !l.endsWith("/")).length;
    return { files, bytes: fs.statSync(tgz).size };
  };

  const gc = async (spec: RunSpecWire) => {
    await withLock("gc", () => {
      const ids = listRunIds().map((id) => ({ id, s: readState(id) })).sort((a, b) => (b.s?.createdAt ?? 0) - (a.s?.createdAt ?? 0));
      ids.forEach(({ id, s }, i) => {
        if (!s) {
          const age = now() - (fs.statSync(runDir(id), { throwIfNoEntry: false })?.mtimeMs ?? now());
          if (age > 24 * 3600_000) fs.rmSync(runDir(id), { recursive: true, force: true });
          return;
        }
        if (s.phase !== "done") {
          // A runner that died with nobody following would stay unfinished forever: settle it as lost.
          if ((s.pid && (!alive(s.pid, s.pidStart) || (s.boot && s.boot !== bootId()))) || (!s.pid && now() - s.createdAt > 30_000)) {
            patchState(id, { phase: "done", finishedAt: now(), code: 70, reason: "lost", hint: "the host runner stopped before the command finished (host reboot or a killed process)" }, (cur) => cur.phase !== "done");
          }
          return;
        }
        const age = now() - (s.finishedAt ?? 0);
        if (age > 24 * 3600_000 || (i >= 500 && age > 3600_000)) fs.rmSync(runDir(id), { recursive: true, force: true });
      });
      // Snapshot refs whose run is over (or never arrived): deleting one only lets git gc reclaim it later.
      const refs = sh("git", ["-C", spec.repo, "for-each-ref", "--format=%(refname)", "refs/codecast/run/"]).out.split("\n").filter(Boolean);
      for (const ref of refs) {
        const rid = ref.split("/").pop()!;
        const st = ID_RE.test(rid) ? readState(rid) : undefined;
        const pending = fs.statSync(path.join(ROOT, "pending", rid), { throwIfNoEntry: false });
        if (rid !== spec.id && (!st || st.phase === "done") && !(pending && now() - pending.mtimeMs < 3600_000)) sh("git", ["-C", spec.repo, "update-ref", "-d", ref]);
      }
      const depsRoot = path.join(ROOT, "deps");
      if (!fs.existsSync(depsRoot)) return;
      const inUse = new Set<string>();
      const slotsRoot = path.join(ROOT, "slots");
      for (const rk of fs.existsSync(slotsRoot) ? fs.readdirSync(slotsRoot) : []) {
        for (const f of fs.readdirSync(path.join(slotsRoot, rk)).filter((f) => f.endsWith(".json"))) {
          const k = readJson<SlotMeta>(path.join(slotsRoot, rk, f))?.depsKey;
          if (k) inUse.add(k);
        }
      }
      // keep_deps counts this repo's trees only; another repo's go only after a week unused.
      const goldens = fs.readdirSync(depsRoot).filter((d) => /^[0-9a-f]{24}$/.test(d))
        .map((k) => ({ k, meta: readJson<{ lastUsed?: number; repo?: string }>(path.join(depsRoot, k, ".cast-golden.json")) }))
        .sort((a, b) => (b.meta?.lastUsed ?? 0) - (a.meta?.lastUsed ?? 0));
      let mine = 0;
      for (const { k, meta } of goldens) {
        if (inUse.has(k) || !meta) continue;
        const own = meta.repo === spec.repo;
        if (own) mine++;
        if ((own && mine > spec.keepDeps) || now() - (meta.lastUsed ?? 0) > 7 * 24 * 3600_000) {
          sh("git", ["-C", meta.repo ?? spec.repo, "worktree", "remove", "--force", path.join(depsRoot, k)]);
          rmTree(path.join(depsRoot, k));
          fs.rmSync(path.join(depsRoot, `${k}.install.log`), { force: true });
        }
      }
      sh("git", ["-C", spec.repo, "worktree", "prune"]);
      // The mirror owns its objects, so git's own housekeeping is safe there.
      sh("git", ["-C", spec.repo, "gc", "--auto", "--quiet"], { timeoutMs: 600_000 });
      const pendingDir = path.join(ROOT, "pending");
      for (const f of fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []) {
        if (now() - (fs.statSync(path.join(pendingDir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0) > 3600_000) fs.rmSync(path.join(pendingDir, f), { force: true });
      }
    });
  };

  const leaseFile = (id: string) => path.join(STATE_DIR, "host-keepalive", `cast-run-${id}`);
  /** Long synchronous steps (an install) block the renew timer, so they take a lease long enough to cover themselves first. */
  const renewLease = (id: string, seconds = 300) => {
    try {
      fs.mkdirSync(path.dirname(leaseFile(id)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(leaseFile(id), `${Math.floor(now() / 1000) + Math.min(seconds, 86_000)}\n`, { mode: 0o600 });
    } catch {}
  };

  // The slot and dependency half of the runner travels as its own function (run/runnerSlots.ts), handed what it uses.
  const { depsKeyFor, findNodeModules, ensureGolden, stopSlotProcesses, detachDeps, attachDeps, refreshDeps, prepareSlot } = parts.slots({
    fs, path, cp, crypto, sh, must, readJson, writeJson, ROOT, PLATFORM, ARCH, now, note, frame, withLock, renewLease, rmTree, killGroup,
    SetupError, Cancelled, INSTALL_TIMEOUT_MS, slotPath, slotMetaFile, repoKey,
  });

  /** The run holds a keepalive lease for its whole life, so the host's idle watchdog never stops it mid-run (cloud/idleProbe.ts). */
  async function exec(id: string): Promise<number> {
    const spec = readJson<RunSpecWire>(path.join(runDir(id), "spec.json"));
    if (!spec) return 2;
    renewLease(id);
    const timer = setInterval(() => renewLease(id), 60_000);
    patchState(id, { pid: process.pid, boot: bootId(), ...(procStart(process.pid) ? { pidStart: procStart(process.pid) } : {}) });
    try {
      return await execRun(id, spec);
    } finally {
      clearInterval(timer);
      fs.rmSync(leaseFile(id), { force: true });
      if (spec.ref) sh("git", ["-C", spec.repo, "update-ref", "-d", spec.ref]);
    }
  }

  async function execRun(id: string, spec: RunSpecWire): Promise<number> {
    const cancelFile = path.join(runDir(id), "cancel");
    const finish = (patch: Partial<RunStateWire>) => patchState(id, { ...patch, phase: "done", finishedAt: now() });
    const t0 = now();
    const slots = slotCount(spec);
    const cancelled = () => fs.existsSync(cancelFile);
    let slotN: number | undefined;
    let hadDaemons = false;
    let queuedNoted = false;

    while (slotN === undefined) {
      if (fs.existsSync(cancelFile)) { finish({ code: 130, reason: "cancelled", timings: { queueMs: now() - t0 } }); return 0; }
      slotN = await withLock("slots", () => {
        const active = activeOwners();
        const free = memInfo().avail;
        // A run admitted moments ago has not grown into its memory yet: count its reservation against what looks free.
        const ramping = active.filter((a) => now() - a.since < 120_000).reduce((sum, a) => sum + a.memoryGb, 0);
        const fits = active.length === 0 || free - ramping - spec.memoryGb >= 1;
        // A run that has waited over two minutes holds the line, so a stream of small runs cannot starve a big one.
        const mine = readState(id)?.createdAt ?? now();
        const starving = listRunIds().some((other) => {
          if (other === id) return false;
          const st = readState(other);
          return !!st && st.phase === "queued" && !!st.pid && alive(st.pid, st.pidStart) && st.createdAt < mine && now() - st.createdAt > 120_000;
        });
        if (active.length >= slots || !fits || starving) {
          if (!queuedNoted) {
            note(id, active.length >= slots ? `queued: all ${slots} slots busy` : starving ? "queued behind a run that has waited longer" : `queued: needs ${spec.memoryGb} GB, ${free.toFixed(1)} GB free beside ${active.length} running`);
            queuedNoted = true;
          }
          return undefined;
        }
        const metas = Array.from({ length: slots }, (_, i) => ({ i, m: readJson<SlotMeta>(slotMetaFile(spec.repo, i)) ?? {} }));
        const rk = repoKey(spec.repo);
        const freeSlots = metas.filter(({ i }) => !active.some((a) => a.rk === rk && a.slot === i));
        // Slots that keep helpers alive (cast check's watchers) serve those jobs, and other jobs go elsewhere first.
        const wantDaemons = !!spec.keepDaemons;
        const pick = freeSlots.find(({ m }) => m.depsKey && !!m.daemons === wantDaemons) ?? freeSlots.find(({ m }) => !!m.daemons === wantDaemons) ?? freeSlots.find(({ m }) => m.depsKey) ?? freeSlots[0]!;
        fs.mkdirSync(slotsDir(spec.repo), { recursive: true });
        // A lane is the run's place on the whole host (slots are per repo): its ports come from it, so two repos never share one.
        let lane = 0;
        while (active.some((a) => a.lane === lane)) lane++;
        // What the slot held before this run claims it: its watchers, if any, must stop before a plain job checks out there.
        hadDaemons = !!pick.m.daemons;
        writeJson(slotMetaFile(spec.repo, pick.i), { ...pick.m, owner: id, ownerPid: process.pid, ownerStart: procStart(process.pid), since: now(), lane, daemons: wantDaemons });
        return pick.i;
      });
      if (slotN === undefined) {
        if (now() - t0 > spec.queueWaitS * 1000) {
          finish({ code: 75, reason: "busy", hint: `the host stayed full for ${spec.queueWaitS}s; try another host with --host, or again later`, timings: { queueMs: now() - t0 } });
          return 0;
        }
        await sleep(1000);
      }
    }
    const n = slotN;
    patchState(id, { phase: "preparing", slot: n, startedAt: now(), timings: { queueMs: now() - t0 } });
    const release = () => {
      const meta = readJson<SlotMeta>(slotMetaFile(spec.repo, n)) ?? {};
      writeJson(slotMetaFile(spec.repo, n), { ...meta, owner: undefined, ownerPid: undefined, ownerStart: undefined, since: undefined, lane: undefined });
    };

    let slot: string;
    let deps: RunDeps;
    // Checkout and dependency placement are synchronous and can run long on a big repo: a lease that covers them first.
    renewLease(id, 1800);
    try {
      const tc = now();
      slot = prepareSlot(spec, n, hadDaemons);
      const checkoutMs = now() - tc;
      if (!fs.existsSync(path.join(slot, spec.cwdRel))) throw new SetupError(`${spec.cwdRel} is not in the snapshot (git ignores it, or it holds no tracked files); run from a tracked directory`);
      const td = now();
      const key = depsKeyFor(spec, slot);
      let meta = readJson<SlotMeta>(slotMetaFile(spec.repo, n)) ?? {};
      if (!key) {
        deps = { key: "", warm: true, clone: "none", ms: 0 };
      } else {
        const golden = await ensureGolden(spec, id, key, cancelled);
        const gmeta = readJson<{ dirs: string[]; lastUsed: number }>(path.join(golden.dir, ".cast-golden.json"))!;
        writeJson(path.join(golden.dir, ".cast-golden.json"), { ...gmeta, lastUsed: now() });
        let clone = meta.depsKey === key ? refreshDeps(spec.repo, n, meta, golden.dir, spec.keepDaemons) : undefined;
        if (!clone) {
          meta = detachDeps(spec.repo, n, meta);
          const a = attachDeps(spec.repo, n, golden.dir, gmeta.dirs);
          clone = a.clone;
          meta = { ...meta, depsKey: key, clone, mounts: a.mounts, dirs: gmeta.dirs };
        }
        writeJson(slotMetaFile(spec.repo, n), { ...meta, owner: id, ownerPid: process.pid, ownerStart: procStart(process.pid), since: readJson<SlotMeta>(slotMetaFile(spec.repo, n))?.since ?? now() });
        deps = { key, warm: !golden.built, clone, ms: now() - td, ...(golden.installMs ? { installMs: golden.installMs } : {}) };
      }
      patchState(id, { deps, timings: { checkoutMs, depsMs: now() - td } });
      if (cancelled()) throw new Cancelled();
    } catch (e) {
      release();
      if (e instanceof Cancelled) { finish({ code: 130, reason: "cancelled" }); return 0; }
      const msg = (e as Error).message;
      note(id, msg);
      finish({ code: 70, reason: "setup", hint: e instanceof SetupError ? msg : `the host runner failed while preparing: ${msg}` });
      return 0;
    }

    const cwd = path.join(slot, spec.cwdRel);
    if (cancelled()) { release(); finish({ code: 130, reason: "cancelled" }); return 0; }
    note(id, `running on ${os.hostname()} in slot ${n}, deps ${deps.clone === "none" ? "none" : `${deps.warm ? "warm" : "cold"} (${deps.clone}, ${(deps.ms / 1000).toFixed(1)}s)`}`);
    const lane = readJson<SlotMeta>(slotMetaFile(spec.repo, n))?.lane ?? n;
    // Each lane starts past `base` (a host session's own dev server takes the first free port from there) and takes the first
    // port that is actually free, so a run's PORT_* never lands on a live server.
    const net = gbm("node:net") as typeof import("node:net");
    const isFree = (port: number) => new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(true)));
    });
    const ports: Record<string, string> = {};
    for (const [name, p] of Object.entries(spec.ports ?? {})) {
      const range = Math.max(2, p.range);
      let chosen = p.base + 1 + (lane % (range - 1));
      for (let k = 0; k < range - 1; k++) {
        const candidate = p.base + 1 + ((lane + k) % (range - 1));
        if (await isFree(candidate)) { chosen = candidate; break; }
      }
      ports[`PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = String(chosen);
    }
    const env = { ...process.env, ...ports, ...spec.env, CAST_RUN_ID: id, CAST_RUN_LANE: String(lane), CAST_RUN_CPUS: String(os.cpus().length) };
    if (cp.spawnSync("bash", ["-c", 'command -v -- "$1" >/dev/null', "_", spec.argv[0]!], { cwd, env }).status !== 0) {
      release();
      finish({ code: 127, reason: "missing-program", hint: `${spec.argv[0]} is not installed on the host, or not on its PATH` });
      return 0;
    }
    // A memory ceiling the kernel enforces (a user systemd scope, no swap), so a runaway run dies alone instead of taking the host;
    // the scope's Result then says whether the kernel killed it for memory.
    const capGb = Math.max(1, Math.min(Math.max(spec.memoryGb * 2, 8), memInfo().total * 0.9));
    const unit = `cast-run-${id}`;
    // A user scope outlives the ssh session only with linger on (provisioned hosts have it); without, it would die with the session.
    const scoped = !spec.keepDaemons && PLATFORM === "linux" && (scopeOk ??= sh("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"]).out === "yes" && sh("systemd-run", ["--user", "--scope", "-q", "--", "true"]).ok);
    const argv = scoped ? ["systemd-run", "--user", "--scope", "-q", `--unit=${unit}`, "-p", `MemoryMax=${Math.floor(capGb * 1024)}M`, "-p", "MemorySwapMax=0", "--", ...spec.argv] : spec.argv;
    const tr = now();
    const child = cp.spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    patchState(id, { phase: "running", cmdPid: child.pid });
    child.stdout?.on("data", (d: Buffer) => frame(id, 1, d));
    child.stderr?.on("data", (d: Buffer) => frame(id, 2, d));
    let killedBy: RunReason | undefined;
    let spawnError: string | undefined;
    const deadline = tr + spec.timeoutMin * 60_000;
    // Stopping covers the whole scope when there is one: a child that left the process group (a daemon, a watcher) goes too.
    const stopAll = (sig: NodeJS.Signals) => { killGroup(child.pid, sig); if (scoped) sh("systemctl", ["--user", "kill", `--signal=${sig}`, `${unit}.scope`]); };
    const watch = setInterval(() => {
      if (killedBy) return;
      if (fs.existsSync(cancelFile)) killedBy = "cancelled";
      else if (now() > deadline) killedBy = "timeout";
      if (!killedBy) return;
      stopAll("SIGTERM");
      setTimeout(() => stopAll("SIGKILL"), 5000).unref();
    }, 250);
    // Done when the command exits; a child it leaked that still holds the pipes gets 2s to flush, then the group is killed.
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("error", (e) => { spawnError = (e as { code?: string }).code ?? String(e); resolve({ code: 127, signal: null }); });
      // Bun may emit close before exit, so both are listened for from the start.
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let closed = false;
      child.on("close", (c, sg) => { closed = true; resolve(exited ?? { code: c, signal: sg }); });
      child.on("exit", (c, sg) => {
        exited = { code: c, signal: sg };
        if (closed) return resolve(exited);
        setTimeout(() => { if (!spec.keepDaemons) killGroup(child.pid, "SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); resolve(exited!); }, 2000).unref();
      });
    });
    clearInterval(watch);
    if (!spec.keepDaemons || killedBy) killGroup(child.pid, "SIGKILL");
    const runMs = now() - tr;
    patchState(id, { phase: "collecting", timings: { runMs } });
    const sigNum = signal ? (os.constants.signals as Record<string, number>)[signal] ?? 9 : 0;
    const own = code ?? 128 + sigNum;

    const to = now();
    renewLease(id, 1800);
    let outputs = { files: 0, bytes: 0 };
    let outputsError: string | undefined;
    // Outputs of a run that was stopped are half-written: they never replace a good local copy.
    if (!killedBy && !spawnError && signal !== "SIGKILL" && own !== 137) {
      try { outputs = collectOutputs(spec, id, slot); } catch (e) { outputsError = (e as Error).message; }
    }
    release();
    const oomKilled = scoped && sh("systemctl", ["--user", "show", "-p", "Result", "--value", `${unit}.scope`]).out === "oom-kill";
    if (scoped) { sh("systemctl", ["--user", "stop", `${unit}.scope`]); sh("systemctl", ["--user", "reset-failed", `${unit}.scope`]); }
    let patch: Partial<RunStateWire>;
    if (killedBy === "cancelled") patch = { code: 130, reason: "cancelled" };
    else if (killedBy === "timeout") patch = { code: 70, reason: "timeout", hint: `the run passed its ${spec.timeoutMin} min limit and was killed; raise timeout_min for this job in .codecast/workspace.toml` };
    else if (spawnError === "ENOENT") patch = { code: 127, reason: "missing-program", hint: `${spec.argv[0]} is not installed on the host, or not on its PATH` };
    else if (oomKilled) patch = { code: 70, reason: "oom", hint: `the run passed its ${capGb.toFixed(0)} GB memory ceiling and the kernel killed it; raise memory_gb for this job (the ceiling is twice that, at least 8 GB), or lower its parallelism` };
    else if (signal === "SIGKILL" || own === 137) patch = { code: own, hint: `the command was killed by SIGKILL, not by cast; if it ran out of memory, set memory_gb for this job or pick a bigger host` };
    else if (outputsError) patch = { code: own, hint: `the command finished but its outputs could not be packed: ${outputsError}` };
    else patch = { code: own };
    finish({ ...patch, outputs, timings: { outputsMs: now() - to } });
    try { await gc(spec); } catch {}
    return 0;
  }

  const startExec = (id: string) => {
    const log = fs.openSync(path.join(runDir(id), "runner.log"), "a");
    const self = process.argv[1]!;
    const child = cp.spawn(process.execPath, [self, "exec", id], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    return child.pid;
  };

  const [cmd, ...rest] = args;
  const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);

  if (cmd === "prep") {
    // The repo to push into, and the commits it already has, so the laptop can size what the push will really send.
    const [want, origin, base] = [rest[0]!, rest[1], rest[2]];
    const bin = path.join(ROOT, "bin");
    for (const f of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
      const full = path.join(bin, f);
      if (full !== process.argv[1] && now() - (fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? now()) > 7 * 24 * 3600_000) fs.rmSync(full, { force: true });
    }
    // A host behind the laptop's base (or a fresh one) fetches it from origin itself, so the push carries only the laptop's own work.
    const catchUp = (repo: string, remote: string) => {
      if (!base || !/^[0-9a-f]{40,64}$/.test(base) || sh("git", ["-C", repo, "cat-file", "-e", `${base}^{commit}`]).ok) return;
      sh("git", ["-C", repo, "fetch", "-q", remote, "+refs/heads/*:refs/remotes/origin/*"], { timeoutMs: 180_000 });
    };
    const hasBase = (repo: string) => !!base && /^[0-9a-f]{40,64}$/.test(base) && sh("git", ["-C", repo, "cat-file", "-e", `${base}^{commit}`]).ok;
    const tips = (repo: string) => sh("git", ["-C", repo, "for-each-ref", "--count=200", "--sort=-committerdate", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"]).out.split("\n").filter(Boolean);
    // Runs live in a bare mirror of their own, never in the host's checkout (where sessions work and `git worktree list` would
    // show every slot). It starts as a hardlinked clone of that checkout, so a push still sends only the laptop's work, and it
    // owns every object it holds: a gc in the checkout can never take one from under a slot.
    const bare = path.join(ROOT, "repos", `${path.basename(want)}-${repoKey(want).slice(0, 8)}.git`);
    const pendingId = rest[3];
    return await withLock(`prep-${repoKey(want)}`, () => {
      const checkout = sh("git", ["-C", want, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const created = !fs.existsSync(path.join(bare, "HEAD"));
      if (created) {
        fs.mkdirSync(path.dirname(bare), { recursive: true });
        rmTree(bare);
        if (!checkout.ok || !sh("git", ["clone", "-q", "--bare", "--local", "--no-tags", checkout.out, bare], { timeoutMs: 600_000 }).ok) {
          rmTree(bare);
          must("git", ["init", "-q", "--bare", bare], "init repo");
        }
      }
      const alternates = path.join(bare, "objects", "info", "alternates");
      if (fs.existsSync(alternates)) {
        // A mirror made by an older runner borrowed the checkout's objects: copy what it uses into its own store, once.
        if (sh("git", ["-C", bare, "repack", "-a", "-d", "-q"], { timeoutMs: 600_000 }).ok) fs.rmSync(alternates, { force: true });
      }
      sh("git", ["-C", bare, "config", "--unset", "gc.auto"]);
      if (checkout.ok) {
        // The checkout's refs, copied in (pruned, so a branch origin deleted goes here too): local, quick, and they tell the
        // laptop what the host already has.
        sh("git", ["-C", bare, "fetch", "-q", "--prune", "--no-tags", checkout.out, "+refs/remotes/origin/*:refs/remotes/origin/*"], { timeoutMs: 120_000 });
      }
      const fromLaptop = origin && /^(git@|ssh:\/\/)[^\s]+$|^https:\/\/[^@\s]+$/.test(origin) ? origin : "";
      const remote = fromLaptop || (checkout.ok ? sh("git", ["-C", want, "remote", "get-url", "origin"]).out : "");
      if (remote) catchUp(bare, remote);
      // The run id this prep is for: gc spares its snapshot ref for an hour, between the push and the submit.
      if (pendingId && ID_RE.test(pendingId)) {
        fs.mkdirSync(path.join(ROOT, "pending"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(ROOT, "pending", pendingId), String(now()));
      }
      print({ repo: bare, created, tips: tips(bare), hasBase: hasBase(bare) });
      return 0;
    });
  }
  if (cmd === "submit") {
    // The spec arrives on stdin, never on the command line, where other users of the host could read its env values.
    const spec = JSON.parse(fs.readFileSync(0, "utf-8")) as RunSpecWire;
    const dir = runDir(spec.id);
    fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });
    fs.chmodSync(RUNS, 0o700);
    const claim = () => fs.writeFileSync(path.join(dir, "submit.pid"), `${process.pid} ${procStart(process.pid) ?? ""}`, { mode: 0o600 });
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      claim();
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      for (let i = 0; i < 50 && !readState(spec.id); i++) {
        if (fs.existsSync(path.join(dir, "cancel"))) { print({ accepted: false, error: "cancelled before it started" }); return 0; }
        await sleep(100);
      }
      if (readState(spec.id)) { print({ accepted: true, duplicate: true, state: readState(spec.id) }); return 0; }
      const [pidText, start] = (() => { try { return fs.readFileSync(path.join(dir, "submit.pid"), "utf-8").split(" "); } catch { return ["0", ""]; } })();
      if (alive(Number(pidText), start || undefined)) { print({ accepted: false, retry: true, error: "an earlier submit of this run is still in progress" }); return 0; }
      // An earlier submit of this id died before it wrote any state: nothing started, so this one takes its place.
      rmTree(dir);
      fs.mkdirSync(dir, { mode: 0o700 });
      claim();
    }
    if (!sh("git", ["-C", spec.repo, "cat-file", "-e", `${spec.sha}^{commit}`]).ok) {
      fs.rmSync(dir, { recursive: true, force: true });
      print({ accepted: false, error: `snapshot ${spec.sha.slice(0, 10)} is not in ${spec.repo}` });
      return 0;
    }
    writeJson(path.join(dir, "spec.json"), spec);
    fs.chmodSync(path.join(dir, "spec.json"), 0o600);
    fs.writeFileSync(path.join(dir, "log"), "");
    const state: RunStateWire = { id: spec.id, phase: "queued", host: os.hostname(), createdAt: now(), timings: {} };
    writeJson(stateFile(spec.id), state);
    const pid = startExec(spec.id);
    print({ accepted: true, state: patchState(spec.id, { pid }, (cur) => !cur.pid) });
    return 0;
  }
  if (cmd === "exec") return exec(rest[0]!);
  if (cmd === "status") { print(readState(rest[0]!) ?? null); return 0; }
  if (cmd === "cancel") {
    const id = rest[0]!;
    // A cancel that beats its own submit leaves a tombstone the submit then refuses.
    fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir(id), "cancel"), String(now()));
    print(readState(id) ?? null);
    return 0;
  }
  if (cmd === "outputs") {
    const tgz = path.join(runDir(rest[0]!), "outputs.tgz");
    if (!fs.existsSync(tgz)) return 3;
    const fd = fs.openSync(tgz, "r");
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) writeAll(1, buf.subarray(0, n));
    return 0;
  }
  if (cmd === "follow") {
    const id = rest[0]!;
    if (!readState(id)) { process.stderr.write(`cast: no run ${id} on ${os.hostname()}\n`); return 3; }
    // Resume by per-stream byte counts the client already printed; notes count as stderr unless quiet.
    const skip = { 1: Number(rest[1] ?? 0) || 0, 2: Number(rest[2] ?? 0) || 0 };
    const quiet = rest[3] === "quiet";
    const boot = bootId();
    // The client holds stdin open while it follows; when it goes, so does this poller.
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => process.exit(0));
    process.stdin.resume();
    const fd = fs.openSync(path.join(runDir(id), "log"), "r");
    let pos = 0;
    let pending = Buffer.alloc(0);
    const buf = Buffer.alloc(1 << 16);
    // Everything goes to stdout in the same frames, so ssh's own chatter on stderr can never be mistaken for the command's bytes.
    const write = (out: 1 | 2 | 3, data: Buffer) => {
      const head = Buffer.alloc(5);
      head.writeUInt8(out, 0);
      head.writeUInt32BE(data.length, 1);
      writeAll(1, Buffer.concat([head, data]));
    };
    const drain = () => {
      let any = false;
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0;) {
        pos += n;
        any = true;
        pending = Buffer.concat([pending, buf.subarray(0, n)]);
        while (pending.length >= 5) {
          const len = pending.readUInt32BE(1);
          if (pending.length < 5 + len) break;
          const stream = pending.readUInt8(0);
          let data = pending.subarray(5, 5 + len);
          pending = pending.subarray(5 + len);
          if (stream === 3 && quiet) continue;
          const counted = stream === 1 ? 1 : 2;
          const drop = Math.min(skip[counted], data.length);
          skip[counted] -= drop;
          data = data.subarray(drop);
          if (data.length) write(stream === 1 ? 1 : stream === 3 ? 3 : 2, Buffer.from(data));
        }
      }
      return any;
    };
    for (;;) {
      const s = readState(id);
      const got = drain();
      if (s?.phase === "done") { drain(); return 0; }
      // No runner pid 30s after the state was written means the submit died before it started one.
      if (s && ((s.pid && (!alive(s.pid, s.pidStart) || (s.boot && s.boot !== boot))) || (!s.pid && now() - s.createdAt > 30_000))) {
        drain();
        patchState(id, { phase: "done", finishedAt: now(), code: 70, reason: "lost", hint: "the host runner stopped before the command finished (host reboot or a killed process)" }, (cur) => cur.phase !== "done");
        if (readState(id)?.phase === "done") { drain(); return 0; }
      }
      if (!got) await sleep(100);
    }
  }
  if (cmd === "info") {
    const mem = memInfo();
    const ids = listRunIds().map(readState).filter((s): s is RunStateWire => !!s && s.phase !== "done" && !!s.pid && alive(s.pid, s.pidStart));
    print({
      host: os.hostname(), cpus: os.cpus().length, memAvailGb: +mem.avail.toFixed(1), memTotalGb: +mem.total.toFixed(1), load1: os.loadavg()[0],
      ...(() => { try { fs.mkdirSync(ROOT, { recursive: true }); const st = fs.statfsSync(ROOT); return { diskFreeGb: +((st.bavail * st.bsize) / 1073741824).toFixed(1) }; } catch { return {}; } })(),
      active: ids.filter((s) => s.phase !== "queued").length, queued: ids.filter((s) => s.phase === "queued").length, slots: slotCount(),
    } satisfies HostInfoWire);
    return 0;
  }
  process.stderr.write(`cast run host: unknown command ${cmd}\n`);
  return 2;
}

/** The program the host runs: the function's own source, called on argv. */
export function hostRunnerSource(): string {
  return `if (typeof process.getBuiltinModule !== "function") { process.stderr.write("cast run host: this host's bun (" + (process.versions.bun || "?") + ") is too old for cast run; upgrade it with: bun upgrade\\n"); process.exit(70); }\n(${hostRunnerMain.toString()})(process.argv.slice(2), { slots: (${runnerSlots.toString()}) }).then((c) => process.exit(c), (e) => { process.stderr.write("cast run host: " + (e && e.stack || e) + "\\n"); process.exit(70); });\n`;
}
