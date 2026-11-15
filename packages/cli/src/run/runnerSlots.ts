/**
 * The slot and dependency half of the host runner (run/hostRunner.ts): the
 * warm dependency trees ("goldens") keyed by lockfile, how a slot gets one
 * (overlayfs, reflink, hardlinks), and how a slot's worktree is checked out.
 * Like hostRunnerMain it ships as its own source, so it references nothing
 * outside its body: everything it needs arrives in `c`.
 */

import type { RunDeps, RunSpecWire } from "./hostRunner.js";

export interface SlotMeta { owner?: string; ownerPid?: number; ownerStart?: string; since?: number; lane?: number; daemons?: boolean; depsKey?: string; clone?: RunDeps["clone"]; mounts?: string[]; dirs?: string[] }

export interface SlotsCtx {
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  cp: Pick<typeof import("../proc.js"), "spawn" | "spawnSync">;
  crypto: typeof import("node:crypto");
  sh: (cmd: string, argv: string[], opts?: { cwd?: string; input?: string; timeoutMs?: number }) => { ok: boolean; status: number | null; out: string; err: string };
  must: (cmd: string, argv: string[], what: string, cwd?: string) => string;
  readJson: <T>(file: string) => T | undefined;
  writeJson: (file: string, value: unknown) => void;
  ROOT: string;
  PLATFORM: string;
  ARCH: string;
  now: () => number;
  note: (id: string, line: string) => void;
  frame: (id: string, stream: 1 | 2 | 3, data: Buffer | string) => void;
  withLock: <T>(name: string, fn: () => T | Promise<T>, cancelled?: () => boolean) => Promise<T>;
  renewLease: (id: string, seconds?: number) => void;
  rmTree: (dir: string) => void;
  killGroup: (pid: number | undefined, sig: NodeJS.Signals) => void;
  SetupError: new (message: string) => Error;
  Cancelled: new () => Error;
  INSTALL_TIMEOUT_MS: number;
  slotPath: (repo: string, n: number) => string;
  slotMetaFile: (repo: string, n: number) => string;
  repoKey: (repo: string) => string;
}

export function runnerSlots(c: SlotsCtx) {
  const { fs, path, cp, crypto, sh, must, readJson, writeJson, ROOT, PLATFORM, ARCH, now, note, frame, withLock, renewLease, rmTree, killGroup, SetupError, Cancelled, INSTALL_TIMEOUT_MS, slotPath, slotMetaFile, repoKey } = c;

  const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  const depsKeyFor = (spec: RunSpecWire, tree: string) => {
    const files = new Set<string>();
    if (spec.depsKey.length) {
      for (const g of spec.depsKey) {
        if (!/[*?[{]/.test(g)) { if (fs.existsSync(path.join(tree, g))) files.add(g); continue; }
        for (const f of new Bun.Glob(g).scanSync({ cwd: tree, dot: true, onlyFiles: true })) if (!f.split("/").includes("node_modules")) files.add(f);
      }
    } else {
      // The lockfiles, plus what an install reads beside them: the root package.json (overrides, trusted deps, scripts) and
      // patches/ (patch-package and postinstall patch scripts change node_modules from there).
      for (const f of [...LOCKFILES, "package.json"]) if (fs.existsSync(path.join(tree, f))) files.add(f);
      if (fs.existsSync(path.join(tree, "patches"))) for (const f of new Bun.Glob("patches/**").scanSync({ cwd: tree, dot: true, onlyFiles: true })) files.add(f);
    }
    if (!files.size || !spec.install.length) return undefined;
    const h = crypto.createHash("sha256");
    h.update(`${PLATFORM}-${ARCH}-bun${process.versions.bun ?? ""}\n${spec.install.join("\n")}\n`);
    for (const f of [...files].sort()) { h.update(`${f}\0`); h.update(fs.readFileSync(path.join(tree, f))); h.update("\0"); }
    // A `file:` dependency is copied into node_modules, but a lockfile records only its path: its content (the git tree id
    // of the folder) goes into the key too, so refreshing a vendored package makes a new tree instead of serving the old copy.
    const local = new Set<string>();
    for (const f of LOCKFILES) {
      const p = path.join(tree, f);
      if (f.endsWith(".lockb") || !fs.existsSync(p)) continue;
      for (const m of fs.readFileSync(p, "utf-8").matchAll(/@file:([^"'\s,)]+)/g)) if (!m[1]!.includes("..")) local.add(m[1]!.replace(/\/+$/, ""));
    }
    for (const dir of [...local].sort()) h.update(`file:${dir}=${sh("git", ["-C", tree, "rev-parse", `HEAD:${dir}`]).out}\n`);
    return h.digest("hex").slice(0, 24);
  };

  /** node_modules dirs under `tree`, not counting ones nested inside another. */
  const findNodeModules = (tree: string) => {
    const r = sh("find", [".", "-name", ".git", "-prune", "-o", "-name", "node_modules", "-type", "d", "-print", "-prune"], { cwd: tree });
    return r.out.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, "")).sort();
  };
  const mountedSet = () => {
    if (PLATFORM !== "linux") return new Set<string>();
    try { return new Set(fs.readFileSync("/proc/self/mounts", "utf-8").split("\n").map((l) => l.split(" ")[1]).filter(Boolean)); } catch { return new Set<string>(); }
  };
  let sudoOk: boolean | undefined;
  const canOverlay = () => PLATFORM === "linux" && (sudoOk ??= sh("sudo", ["-n", "true"]).ok);


  /**
   * The golden for a lockfile key: a worktree of the repo where the install
   * ran, kept in place so any absolute path an install wrote still resolves.
   * .cast-golden.json, written last, is what makes it ready.
   */
  async function ensureGolden(spec: RunSpecWire, id: string, key: string, cancelled: () => boolean): Promise<{ dir: string; built: boolean; installMs?: number }> {
    const dir = path.join(ROOT, "deps", key);
    const metaFile = path.join(dir, ".cast-golden.json");
    if (readJson(metaFile)) return { dir, built: false };
    return withLock(`deps-${key}`, async () => {
      renewLease(id, INSTALL_TIMEOUT_MS / 1000 + 600);
      if (readJson(metaFile)) return { dir, built: false };
      note(id, `no warm dependencies for this lockfile yet; installing once (${spec.install.join(" && ")})`);
      const drop = () => { sh("git", ["-C", spec.repo, "worktree", "remove", "--force", dir]); rmTree(dir); sh("git", ["-C", spec.repo, "worktree", "prune"]); };
      drop();
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      must("git", ["-C", spec.repo, "worktree", "add", "-q", "--detach", dir, spec.sha], "dependency worktree");
      const log = path.join(ROOT, "deps", `${key}.install.log`);
      fs.writeFileSync(log, "");
      const t = now();
      for (const cmd of spec.install) {
        if (cancelled()) { drop(); throw new Cancelled(); }
        const fd = fs.openSync(log, "a");
        // Async with a watch, so a cancel stops an install in progress instead of after it.
        const child = cp.spawn("bash", ["-c", cmd], { cwd: dir, stdio: ["ignore", fd, fd], env: process.env, detached: true });
        const startedAt = now();
        let stopped: "cancel" | "timeout" | undefined;
        let beat = now();
        const watch = setInterval(() => {
          if (stopped) return;
          // A sign of life for whoever follows: a cold install can take minutes with nothing else to show.
          if (now() - beat > 30_000) { beat = now(); note(id, `still installing dependencies (${Math.round((now() - startedAt) / 1000)}s)`); }
          if (cancelled()) stopped = "cancel";
          else if (now() - startedAt > INSTALL_TIMEOUT_MS) stopped = "timeout";
          if (stopped) killGroup(child.pid, "SIGKILL");
        }, 250);
        const r = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.on("error", () => resolve({ status: 127, signal: null }));
          child.on("close", (status, signal) => resolve({ status, signal }));
        });
        clearInterval(watch);
        fs.closeSync(fd);
        if (stopped === "cancel") { drop(); throw new Cancelled(); }
        if (r.status !== 0) {
          const tail = fs.readFileSync(log, "utf-8").trim().split("\n").slice(-15).join("\n");
          if (tail) frame(id, 2, `${tail}\n`);
          drop();
          const why = stopped === "timeout" ? `took over ${INSTALL_TIMEOUT_MS / 60_000} min and was killed` : `failed on the host (exit ${r.status})`;
          throw new SetupError(`dependency install \`${cmd}\` ${why}; its last lines are above, the whole log is on the host at ${log}`);
        }
      }
      const installMs = now() - t;
      writeJson(metaFile, { key, repo: spec.repo, dirs: findNodeModules(dir), builtAt: now(), lastUsed: now(), installMs });
      return { dir, built: true, installMs };
    }, cancelled);
  }

  /**
   * Stop whatever still runs inside a slot (a kept typecheck watcher) before its dependency tree changes under it: a watcher
   * that saw node_modules swapped keeps answering from the old tree, once with thousands of "cannot find module" errors.
   */
  const stopSlotProcesses = (slot: string) => {
    if (PLATFORM !== "linux") return;
    const inSlot = () => fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid).filter((d) => {
      try { const cwd = fs.readlinkSync(`/proc/${d}/cwd`); return cwd === slot || cwd.startsWith(`${slot}/`); } catch { return false; }
    }).map(Number);
    for (const pid of inSlot()) { try { process.kill(pid, "SIGTERM"); } catch {} }
    const tick = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 20 && inSlot().length; i++) Atomics.wait(tick, 0, 0, 100);
    for (const pid of inSlot()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  };

  const detachDeps = (repo: string, n: number, meta: SlotMeta) => {
    const slot = slotPath(repo, n);
    stopSlotProcesses(slot);
    const mounted = mountedSet();
    for (const m of meta.mounts ?? []) if (mounted.has(m)) sh("sudo", ["-n", "umount", "-l", m]);
    if (fs.existsSync(slot)) for (const rel of findNodeModules(slot)) fs.rmSync(path.join(slot, rel), { recursive: true, force: true });
    rmTree(path.join(ROOT, "ov", repoKey(repo), String(n)));
    return { ...meta, depsKey: undefined, clone: undefined, mounts: undefined, dirs: undefined };
  };

  /** Give the slot the golden's node_modules: overlayfs (instant, writes stay in the slot), reflink, then hardlinks. */
  const attachDeps = (repo: string, n: number, golden: string, dirs: string[]): { clone: RunDeps["clone"]; mounts: string[] } => {
    const slot = slotPath(repo, n);
    const ov = path.join(ROOT, "ov", repoKey(repo), String(n));
    if (canOverlay() && ![golden, slot, ov].some((p) => /[,:\s]/.test(p))) {
      const mounts: string[] = [];
      let ok = true;
      dirs.forEach((rel, i) => {
        if (!ok) return;
        const target = path.join(slot, rel);
        const upper = path.join(ov, String(i), "u");
        const work = path.join(ov, String(i), "w");
        rmTree(path.join(ov, String(i)));
        fs.mkdirSync(upper, { recursive: true });
        fs.mkdirSync(work, { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        const r = sh("sudo", ["-n", "mount", "-t", "overlay", "overlay", "-o", `lowerdir=${path.join(golden, rel)},upperdir=${upper},workdir=${work}`, target]);
        if (r.ok) mounts.push(target); else ok = false;
      });
      if (ok) return { clone: "overlay", mounts };
      for (const m of mounts) sh("sudo", ["-n", "umount", "-l", m]);
    }
    const copyAll = (flags: string[]) => dirs.every((rel) => {
      const target = path.join(slot, rel);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return sh("cp", [...flags, path.join(golden, rel), target]).ok;
    });
    if (PLATFORM === "darwin" ? copyAll(["-cR"]) : copyAll(["-a", "--reflink=always"])) return { clone: "reflink", mounts: [] };
    // Hardlinks share inodes with the golden: its files go read-only once, so an in-place write fails loudly instead of changing every slot.
    const sealed = path.join(golden, ".cast-golden-sealed");
    if (!fs.existsSync(sealed)) {
      for (const rel of dirs) sh("chmod", ["-R", "a-w", path.join(golden, rel)]);
      for (const rel of dirs) sh("find", [path.join(golden, rel), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
      fs.writeFileSync(sealed, "");
    }
    if (copyAll(["-al"])) return { clone: "hardlink", mounts: [] };
    throw new SetupError("could not place the warm dependency tree in the run's worktree");
  };

  /** Between runs: overlay mounts reset to the golden, reflink and hardlink copies are redone (a run may have changed them). */
  const refreshDeps = (repo: string, n: number, meta: SlotMeta, golden: string, keepDaemons = false): RunDeps["clone"] | undefined => {
    // A job whose helpers outlive it (cast check's watchers) keeps its tree as is, whatever the clone: renewing it would pull
    // it out from under them.
    if (keepDaemons && (meta.clone !== "overlay" || (meta.mounts ?? []).every((m) => mountedSet().has(m)))) return "kept";
    if (meta.clone === "reflink") return undefined;
    // Hardlinked trees are redone too: a run can add, delete or rename entries in their (writable) directories.
    if (meta.clone === "hardlink") return undefined;
    if (meta.clone !== "overlay") return "kept";
    const mounted = mountedSet();
    if (!(meta.mounts ?? []).every((m) => mounted.has(m))) return undefined;
    stopSlotProcesses(slotPath(repo, n));
    const dirs = meta.dirs ?? [];
    const ov = path.join(ROOT, "ov", repoKey(repo), String(n));
    for (const [i, target] of (meta.mounts ?? []).entries()) {
      if (!sh("sudo", ["-n", "umount", target]).ok) return undefined;
      rmTree(path.join(ov, String(i)));
      fs.mkdirSync(path.join(ov, String(i), "u"), { recursive: true });
      fs.mkdirSync(path.join(ov, String(i), "w"), { recursive: true });
      const rel = dirs[i]!;
      if (!sh("sudo", ["-n", "mount", "-t", "overlay", "overlay", "-o", `lowerdir=${path.join(golden, rel)},upperdir=${path.join(ov, String(i), "u")},workdir=${path.join(ov, String(i), "w")}`, target]).ok) return undefined;
    }
    return "overlay";
  };

  const prepareSlot = (spec: RunSpecWire, n: number, hadDaemons: boolean) => {
    const slot = slotPath(spec.repo, n);
    // A plain job in a slot whose watchers still run: stop them before the checkout changes files under them.
    if (hadDaemons && !spec.keepDaemons) stopSlotProcesses(slot);
    const fresh = !fs.existsSync(path.join(slot, ".git"));
    if (fresh) {
      sh("git", ["-C", spec.repo, "worktree", "prune"]);
      fs.rmSync(slot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(slot), { recursive: true });
      must("git", ["-C", spec.repo, "worktree", "add", "-q", "--detach", slot, spec.sha], "worktree add");
    } else if (!sh("git", ["-C", slot, "checkout", "-q", "-f", "--detach", spec.sha]).ok) {
      // A slot whose worktree link broke (pruned, or the repo recloned) is rebuilt once instead of failing every run it gets.
      const meta = readJson<SlotMeta>(slotMetaFile(spec.repo, n)) ?? {};
      writeJson(slotMetaFile(spec.repo, n), { ...detachDeps(spec.repo, n, meta), owner: meta.owner, ownerPid: meta.ownerPid, ownerStart: meta.ownerStart, since: meta.since, lane: meta.lane, daemons: meta.daemons });
      sh("git", ["-C", spec.repo, "worktree", "remove", "--force", slot]);
      rmTree(slot);
      sh("git", ["-C", spec.repo, "worktree", "prune"]);
      must("git", ["-C", spec.repo, "worktree", "add", "-q", "--detach", slot, spec.sha], "worktree add");
    } else {
      must("git", ["-C", slot, "clean", "-q", "-ffdx", "-e", "node_modules"], "clean");
    }
    return slot;
  };

  return { depsKeyFor, findNodeModules, mountedSet, ensureGolden, stopSlotProcesses, detachDeps, attachDeps, refreshDeps, prepareSlot };
}
