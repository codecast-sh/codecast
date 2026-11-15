/**
 * `cast run`: send one command to a cloud host and get it back as if it ran
 * here, while the session stays on this machine.
 *
 * The working tree goes as a snapshot commit (wipSnapshot.ts), pushed to a
 * hidden ref in the host's copy of the repo, so git sends only the objects the
 * host lacks. The host runner (run/hostRunner.ts) checks it out in a pooled
 * worktree with a warm dependency tree, runs the argv and keeps its output in
 * files. This side follows those files, copies back the outputs the job
 * declares, and exits with the command's own code. Codes 70, 75, 124 and 130
 * belong to the tool (infraExit.ts), and the last stderr line may be a
 * `cast: hint:`.
 *
 * Once the host accepted a run, nothing here runs it locally, and losing this
 * process does not stop it: `cast run wait <id>` follows it again.
 */

import * as fs from "node:fs";
import type { ChildProcess } from "../proc.js";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "../proc.js";
import { createWipSnapshotStrict, CLOUD_SEED_EXCLUDES } from "../wipSnapshot.js";
import { shq } from "../remote/session-move.js";
import { mergeManifests } from "../workspace/resolver.js";
import { detectProject } from "../workspace/detect.js";
import { MANIFEST_REL_PATH, parseManifest } from "../workspace/manifest.js";
import type { RunJob, RunSpec } from "../workspace/types.js";
import { EXIT_BUSY, EXIT_CANCELLED, EXIT_INFRA, EXIT_WAIT_ELAPSED, formatHint } from "../infraExit.js";
import type { RunSpecWire, RunStateWire } from "./hostRunner.js";
import { callRunner, collect, InfraError, lastLine, runnerCommand, runnerJsonAsync, runnerProgram, type Transport } from "./transport.js";
import { dropRecord, newRunId, pruneRecords, readRecord, runsDir, saveRecord, type RunRecord } from "./records.js";

export * from "./transport.js";
export * from "./records.js";

// ---------------------------------------------------------------------------
// Jobs and the snapshot
// ---------------------------------------------------------------------------

/** The job whose argv prefix is the longest one `argv` starts with. */
export function matchJob(jobs: RunJob[], argv: string[]): RunJob | undefined {
  let best: RunJob | undefined;
  for (const job of jobs) {
    if (job.argv.length > argv.length || !job.argv.every((w, i) => argv[i] === w)) continue;
    if (!best || job.argv.length > best.argv.length) best = job;
  }
  return best;
}

export interface UploadEstimate { bytes: number; objects: number; top: Array<{ dir: string; bytes: number }> }

/**
 * What the push will carry beyond what origin already has: the objects the
 * snapshot reaches that no remote-tracking ref does. The host fetches origin,
 * so this is close to what travels; uncompressed, so an upper bound.
 */
export function estimateUpload(cwd: string, sha: string, hostTips?: string[]): UploadEstimate {
  // With the host's tips, count against what the host has; without, against origin (a dry run that asks no host).
  const known = hostTips ? knownCommits(cwd, hostTips) : undefined;
  const not = known ? known.map(shq).join(" ") : "--remotes";
  const list = spawnSync("bash", ["-c", `git rev-list --objects ${shq(sha)} --not ${not} | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)'`], { cwd, encoding: "utf-8", maxBuffer: 1 << 30 });
  const byDir = new Map<string, number>();
  let bytes = 0;
  let objects = 0;
  for (const line of String(list.stdout ?? "").split("\n")) {
    const m = /^(\w+) (\d+) ?(.*)$/.exec(line);
    if (!m) continue;
    objects++;
    const size = Number(m[2]);
    bytes += size;
    if (m[1] === "blob" && m[3]) {
      const parts = m[3].split("/");
      const dir = parts.length > 2 ? parts.slice(0, 3).join("/") : parts.slice(0, -1).join("/") || ".";
      byDir.set(dir, (byDir.get(dir) ?? 0) + size);
    }
  }
  const top = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([dir, b]) => ({ dir, bytes: b }));
  return { bytes, objects, top };
}

/** The host's tips this checkout also has: the ones git can leave out of the push. */
function knownCommits(cwd: string, tips: string[]): string[] {
  const shas = tips.filter((t) => /^[0-9a-f]{40,64}$/.test(t));
  if (!shas.length) return [];
  const r = spawnSync("git", ["-C", cwd, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: shas.join("\n"), encoding: "utf-8" });
  return String(r.stdout ?? "").split("\n").filter((l) => / commit$/.test(l)).map((l) => l.split(" ")[0]!);
}

export const fmtBytes = (n: number) => n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
export const fmtMs = (ms: number) => ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;

export function checkoutRoots(cwd: string): { seedCwd: string; cwdRel: string } {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (top.status !== 0) throw new InfraError(`${cwd} is not inside a git checkout`, "cast run sends a git checkout; run it from inside one");
  const seedCwd = String(top.stdout).trim();
  const rel = path.relative(fs.realpathSync(seedCwd), fs.realpathSync(cwd));
  return { seedCwd, cwdRel: rel.split(path.sep).join("/") };
}

export interface RunPlan {
  seedCwd: string;
  cwdRel: string;
  argv: string[];
  job?: RunJob;
  spec: RunSpec;
  install: string[];
  ports: Record<string, { base: number; range: number }>;
  /** [setup] copy files present here that git ignores: a snapshot never carries them. */
  notSent: string[];
}

/** Jobs cast knows without a manifest entry; a repo's own [[run.jobs]] win. cast check's watchers are meant to outlive it. */
export const BUILTIN_JOBS: RunJob[] = [{ name: "cast check", argv: ["cast", "check"], outputs: [], memoryGb: 8, keepDaemons: true }];

export function planRun(cwd: string, argv: string[]): RunPlan {
  const { seedCwd, cwdRel } = checkoutRoots(cwd);
  // Not resolveManifest: its agent-config walk (worktree copies) costs seconds and a run carries none of it.
  const manifest = mergeManifests(detectProject(seedCwd), parseManifest(path.join(seedCwd, MANIFEST_REL_PATH)));
  const spec: RunSpec = manifest.run ?? { keepDeps: 3, maxUploadMb: 50, jobs: [] };
  const present = manifest.setup.copy.filter((rel) => !/[*?[]/.test(rel) && fs.existsSync(path.join(seedCwd, rel)));
  const ignored = present.length ? String(spawnSync("git", ["-C", seedCwd, "check-ignore", "--stdin"], { input: present.join("\n"), encoding: "utf-8" }).stdout ?? "").split("\n").filter(Boolean) : [];
  return { seedCwd, cwdRel, argv, job: matchJob(spec.jobs, argv) ?? matchJob(BUILTIN_JOBS, argv), spec, install: spec.install ?? manifest.setup.install, ports: manifest.ports, notSent: ignored };
}

// ---------------------------------------------------------------------------
// Following a run and finishing it here
// ---------------------------------------------------------------------------

export interface Out { out: (b: Buffer | string) => void; err: (b: Buffer | string) => void }
export const stdio: Out = { out: (b) => process.stdout.write(b), err: (b) => process.stderr.write(b) };

export type FollowEnd = { kind: "done"; state: RunStateWire; errTail: string } | { kind: "detached"; why: "max-wait" | "signal" | "interrupt" | "connection"; detail?: string };

/**
 * Stream the run's logs from where this process last left off until the host
 * says it is done. A dropped connection resumes at the byte it reached, so
 * nothing prints twice. Ctrl-C cancels the run on the host (a second one stops
 * following); SIGTERM and SIGHUP only stop following.
 */
export async function follow(t: Transport, id: string, io: Out, opts: { maxWaitS?: number; offsets?: [number, number]; onInterrupt?: () => void; signals?: boolean; quiet?: boolean; interruptCancels?: boolean } = {}): Promise<FollowEnd> {
  const offsets: [number, number] = opts.offsets ?? [0, 0];
  let child: ChildProcess | undefined;
  let detached: FollowEnd | undefined;
  let interrupts = 0;
  let errTail = "";
  let transportErr = "";
  let badFrames = false;
  const stop = (end: FollowEnd) => { detached ??= end; child?.kill("SIGTERM"); };
  const onInt = () => {
    interrupts++;
    // Following a run you came back to (cast run wait), Ctrl-C stops watching; it never kills a run you did not start here.
    if (opts.interruptCancels === false) return stop({ kind: "detached", why: "signal" });
    if (interrupts === 1) {
      io.err("\ncast: cancelling the run on the host (Ctrl-C again to stop waiting)\n");
      opts.onInterrupt?.();
      // Sent without waiting, so a second Ctrl-C is always heard even when the host is unreachable.
      void t.runAsync(runnerCommand(["cancel", id]), { input: runnerProgram().text, timeoutMs: 30_000 });
    } else stop({ kind: "detached", why: "interrupt" });
  };
  const onTerm = () => stop({ kind: "detached", why: "signal" });
  if (opts.signals !== false) {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onTerm);
  }
  const timer = opts.maxWaitS ? setTimeout(() => stop({ kind: "detached", why: "max-wait" }), opts.maxWaitS * 1000) : undefined;
  try {
    let failures = 0;
    for (;;) {
      if (detached) return detached;
      const before = offsets[0] + offsets[1];
      const code = await new Promise<number | null>((resolve) => {
        child = t.stream(runnerCommand(["follow", id, String(offsets[0]), String(offsets[1]), opts.quiet ? "quiet" : "notes"], { install: false }));
        // The host frames everything on stdout ([stream][u32 length][bytes]); only frame bytes count toward the resume offsets,
        // and ssh's own stderr is kept aside for the error message.
        let pending = Buffer.alloc(0);
        child.stdout?.on("data", (d: Buffer) => {
          pending = Buffer.concat([pending, d]);
          while (pending.length >= 5) {
            const stream = pending.readUInt8(0);
            const len = pending.readUInt32BE(1);
            // Checked before waiting on a length: text in front of the frames would otherwise read as a 1 GB frame and hang.
            if (stream < 1 || stream > 3 || len > 64 * 1024 * 1024) {
              // Something other than the runner wrote to stdout (a shell startup file on the host): say so instead of hanging.
              badFrames = true;
              child?.kill("SIGTERM");
              return;
            }
            if (pending.length < 5 + len) break;
            const data = Buffer.from(pending.subarray(5, 5 + len));
            pending = pending.subarray(5 + len);
            if (stream === 1) { offsets[0] += data.length; io.out(data); } else {
              offsets[1] += data.length;
              if (stream === 2) errTail = (errTail + data.toString()).slice(-16_384);
              io.err(data);
            }
          }
        });
        child.stderr?.on("data", (d: Buffer) => { transportErr = (transportErr + d.toString()).slice(-2000); });
        child.on("close", (c) => resolve(c));
        child.on("error", () => resolve(null));
      });
      if (detached) return detached;
      if (badFrames) throw new InfraError(`the output from ${t.label} is not the runner's: something on the host prints to stdout when ssh starts a command`, "a line printed by the host's shell startup files (~/.bashrc, ~/.profile) for non-interactive shells; make it print only when interactive. The run continues there");
      if (code === 0) {
        const state = await runnerJsonAsync<RunStateWire | null>(t, ["status", id]).catch(() => undefined);
        if (state?.phase === "done") return { kind: "done", state, errTail };
      }
      if (code === 71) callRunner(t, ["status", id], 30_000);
      if (code === 3) throw new InfraError(`run ${id} is not on ${t.label} any more`, "runs are kept on the host for 24 hours");
      // A connection that delivered output was working: only consecutive empty drops count.
      if (offsets[0] + offsets[1] > before) failures = 0;
      // The run was accepted and lives on the host: a connection gone for about two minutes (wifi, sleep) ends the wait, not the run.
      // The run was accepted and lives on: losing the connection ends this wait (124), never the run.
      if (++failures > 14) throw new InfraError(`lost the connection to ${t.label} while following ${id}${lastLine(transportErr) ? `: ${lastLine(transportErr)}` : ""}`, `the run continues on the host; cast run wait ${id} follows it again`, EXIT_WAIT_ELAPSED);
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** failures)));
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signals !== false) {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onTerm);
    }
  }
}

export interface AppliedOutputs { written: number; diverted: string[]; failed: string[]; dir?: string }

/**
 * Put the run's outputs into the checkout. A file lands when git ignores it
 * (generated output, replaced as is), or when the local copy is still what
 * the snapshot carried; a tracked file edited here during the run is never overwritten and goes to ~/.codecast/runs/<id>/
 * instead (pandora/client/writeback.py's stale-tree rule).
 */
export function applyOutputs(t: Transport, rec: RunRecord): AppliedOutputs {
  // Streamed to a file, never held in memory: an outputs tarball can be bigger than any buffer.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-run-out-"));
  const tgz = `${tmp}.tgz`;
  const r = t.runToFile(runnerCommand(["outputs", rec.id]), runnerProgram().text, tgz, 1_800_000);
  if (r.status === 3) { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tgz, { force: true }); return { written: 0, diverted: [], failed: [] }; }
  if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tgz, { force: true }); throw new InfraError(`could not fetch the outputs of ${rec.id}: ${lastLine(r.stderr)}`, `cast run wait ${rec.id} fetches them again`); }
  try {
    const x = spawnSync("tar", ["-xzf", tgz, "-C", tmp]);
    if (x.status !== 0) throw new InfraError(`the outputs of ${rec.id} did not unpack: ${lastLine(String(x.stderr))}`);
    // Only what the job declares lands here, whatever the host's tarball holds: the host must not be able to rewrite anything else.
    const declared = rec.outputs.map((g) => (/[*?[{]/.test(g) ? new Bun.Glob(g) : undefined));
    const isDeclared = (f: string) => rec.outputs.some((g, i) => declared[i] ? declared[i]!.match(f) : f === g || f.startsWith(`${g.replace(/\/+$/, "")}/`));
    const all = spawnSync("find", [".", "-type", "f"], { cwd: tmp, encoding: "utf-8" }).stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
    const links = spawnSync("find", [".", "-type", "l"], { cwd: tmp, encoding: "utf-8" }).stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
    const files = all.filter(isDeclared);
    // Without --no-index, so a tracked file that happens to match an ignore rule still counts as tracked.
    const ignored = new Set(spawnSync("git", ["-C", rec.seedCwd, "check-ignore", "--stdin"], { input: files.join("\n"), encoding: "utf-8" }).stdout.split("\n").filter(Boolean));
    const tracked = files.filter((f) => !ignored.has(f));
    const snapBlobs = new Map<string, string>();
    if (tracked.length) {
      // The whole tree, filtered here: thousands of paths on an argv can fail outright, and an empty answer would divert every file.
      const want = new Set(tracked);
      const ls = spawnSync("git", ["-C", rec.seedCwd, "ls-tree", "-r", "-z", rec.sha], { encoding: "utf-8", maxBuffer: 1 << 28 });
      if (ls.status !== 0) throw new InfraError(`could not read snapshot ${rec.sha.slice(0, 10)} here: ${lastLine(String(ls.stderr))}`, `cast run wait ${rec.id} tries again`);
      for (const entry of String(ls.stdout).split("\0").filter(Boolean)) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
        if (m && want.has(m[2]!)) snapBlobs.set(m[2]!, m[1]!);
      }
    }
    // One git process hashes every file on each side, not two per file.
    // Against the snapshot: the checkout's file as git would store it (its eol and filter attributes applied).
    // Against the host's copy: raw bytes on both sides, since both are working-tree files.
    const hashAll = (paths: string[], cwd: string | undefined, filters: boolean) => {
      if (!paths.length) return [];
      return String(spawnSync("git", [...(cwd ? ["-C", cwd] : []), "hash-object", ...(filters ? [] : ["--no-filters"]), "--stdin-paths"], { input: paths.join("\n"), encoding: "utf-8", maxBuffer: 1 << 26 }).stdout).trim().split("\n");
    };
    const present = tracked.filter((f) => fs.statSync(path.join(rec.seedCwd, f), { throwIfNoEntry: false })?.isFile());
    const localClean = new Map(hashAll(present, rec.seedCwd, true).map((h, i) => [present[i]!, h]));
    const localRaw = new Map(hashAll(present.map((f) => path.join(rec.seedCwd, f)), undefined, false).map((h, i) => [present[i]!, h]));
    const hostHashes = new Map(hashAll(tracked.map((f) => path.join(tmp, f)), undefined, false).map((h, i) => [tracked[i]!, h]));
    const hashLocal = (rel: string) => localClean.get(rel);
    const diverted: string[] = [];
    const failed: string[] = [];
    let written = 0;
    const divertDir = path.join(runsDir(), rec.id, "outputs");
    const hostHash = (rel: string) => hostHashes.get(rel);
    for (const rel of files) {
      // Any name the host can write is fine (a reporter's timestamped file has colons); only escapes and .git are refused.
      if (rel.startsWith("/") || rel.split("/").some((p) => !p || p === ".." || p.toLowerCase() === ".git")) { failed.push(rel); continue; }
      const local = ignored.has(rel) ? undefined : hashLocal(rel);
      if (local !== undefined && localRaw.get(rel) === hostHash(rel)) { written++; continue; }
      // The host left this tracked file as the snapshot had it: nothing to bring back, whatever happened to it here.
      if (!ignored.has(rel) && snapBlobs.has(rel) && hostHash(rel) === snapBlobs.get(rel)) continue;
      const ok = ignored.has(rel) || local === snapBlobs.get(rel);
      let dest = path.join(rec.seedCwd, rel);
      if (ok) {
        // Never write through a symlink on the way, and never over something that is not a file.
        const parts = rel.split("/");
        let cur = rec.seedCwd;
        let safe = true;
        for (const [i, part] of parts.entries()) {
          cur = path.join(cur, part);
          const st = fs.lstatSync(cur, { throwIfNoEntry: false });
          if (!st) break;
          if (st.isSymbolicLink() || (i === parts.length - 1 ? !st.isFile() : !st.isDirectory())) { safe = false; break; }
        }
        if (!safe) { failed.push(`${rel} (not a plain file here)`); continue; }
      } else {
        diverted.push(rel);
        dest = path.join(divertDir, rel);
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // Atomic per file: an interrupted copy leaves the old file or the new one, never half of one.
        const part = `${dest}.cast-run-${process.pid}`;
        fs.copyFileSync(path.join(tmp, rel), part);
        fs.renameSync(part, dest);
        if (dest.startsWith(rec.seedCwd)) written++;
      } catch (e) {
        failed.push(`${rel} (${(e as { code?: string }).code ?? "copy failed"})`);
      }
    }
    for (const f of all) if (!isDeclared(f)) failed.push(`${f} (not a declared output)`);
    for (const f of links) failed.push(`${f} (a symlink; only files come back)`);
    return { written, diverted, failed, ...(diverted.length ? { dir: divertDir } : {}) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
  }
}

/**
 * Paths a failing command complained about that exist in this checkout but
 * git ignores, so they never reached the host (a .env, a generated file).
 * The host's own slot paths map back to repo paths. pandora/client/hints.py's
 * ignored-path hint.
 */
export function ignoredPathsIn(text: string, rec: Pick<RunRecord, "seedCwd" | "cwdRel">): string[] {
  const found = new Set<string>();
  const patterns = [
    /ENOENT[^'"\n]*['"]([^'"\n]+)['"]/g,
    /([^\s'":]+): No such file or directory/g,
    /No such file or directory[^'"\n]*['"]([^'"\n]+)['"]/g,
    /Cannot find (?:module|package) ['"]([^'"\n]+)['"]/g,
    /(?:open|read|load|stat) ['"]?([^'"\s]+\.[A-Za-z0-9]+)['"]?: (?:no such file|ENOENT)/gi,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) found.add(m[1]);
  const rels = new Set<string>();
  for (const raw of found) {
    const slot = /\/\.codecast\/run\/slots\/[0-9a-f]{10}\/\d+\/(.+)$/.exec(raw);
    const rel = slot ? slot[1]! : path.isAbsolute(raw) ? undefined : path.posix.normalize(path.posix.join(rec.cwdRel || ".", raw));
    if (!rel || rel.startsWith("..") || rel.split("/").includes("node_modules")) continue;
    if (fs.existsSync(path.join(rec.seedCwd, rel))) rels.add(rel);
  }
  if (!rels.size) return [];
  // Without --no-index: a tracked file that matches an ignore rule did travel, so it is not the cause.
  const r = spawnSync("git", ["-C", rec.seedCwd, "check-ignore", "--stdin"], { input: [...rels].join("\n"), encoding: "utf-8" });
  return String(r.stdout ?? "").split("\n").filter(Boolean);
}

/** Finish a run that is done on the host: outputs, the record, the hint, the exit code. */
export function finishRun(t: Transport, rec: RunRecord, state: RunStateWire, io: Out, errTail = ""): number {
  let code = state.code ?? EXIT_INFRA;
  let hint = state.hint;
  const t0 = Date.now();
  // Two clients (a `cast run wait` beside the first) apply one at a time, and the second finds it done.
  const lock = path.join(runsDir(), `${rec.id}.applying`);
  fs.mkdirSync(runsDir(), { recursive: true });
  for (let i = 0; ; i++) {
    if (i === 50) io.err(`cast: waiting for another cast run wait to finish applying ${rec.id}'s outputs\n`);
    if (i > 9000) throw new InfraError(`another process has been applying ${rec.id}'s outputs for 15 minutes`, `remove ${lock} if nothing is running`);
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); break; } catch {
      // A holder that died (Ctrl-C mid-apply) leaves its pid behind: a dead pid frees the lock at once.
      let holder = 0;
      try { holder = Number(fs.readFileSync(path.join(lock, "pid"), "utf-8")); } catch {}
      const dead = holder > 0 && (() => { try { process.kill(holder, 0); return false; } catch { return true; } })();
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (dead || (!holder && age > 5000)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
  const fresh = readRecord(rec.id);
  if (fresh?.outputsApplied) {
    rec.outputsApplied = true;
    // Another client finished this run first: its verdict (a diversion's 75 included) stands.
    if (fresh.code !== undefined) code = fresh.code;
  }
  if (!rec.outputsApplied && (state.outputs?.files ?? 0) > 0) {
    // Marked while it happens, so a client killed halfway leaves a record that says so (cast run wait finishes the job).
    rec.reason = "applying-outputs";
    saveRecord(rec);
    const applied = applyOutputs(t, rec);
    // A copy that failed partway stays unapplied, so cast run wait tries it again.
    rec.outputsApplied = applied.failed.length === 0;
    if (applied.failed.length) {
      // Not an edit of yours: the copy itself failed, so the tool failed.
      hint = `${applied.failed.length} output file${applied.failed.length === 1 ? "" : "s"} could not be written here: ${applied.failed.slice(0, 3).join(", ")}${applied.failed.length > 3 ? ", ..." : ""}`;
      if (code === 0) code = EXIT_INFRA;
    } else if (applied.diverted.length) {
      const one = applied.diverted.length === 1;
      hint = `${applied.diverted.length} output file${one ? "" : "s"} changed here during the run and ${one ? "was" : "were"} not overwritten (${applied.diverted.slice(0, 3).join(", ")}${applied.diverted.length > 3 ? ", ..." : ""}); the host's copies are in ${applied.dir}`;
      if (code === 0) code = EXIT_BUSY;
    }
  }
  if (!hint && code !== 0 && state.deps?.clone === "hardlink" && /EACCES[^\n]*node_modules|node_modules[^\n]*(EACCES|Permission denied)/.test(errTail)) {
    hint = "this host has no overlayfs or reflink, so node_modules is shared read-only between runs and the command tried to write into it; give the host passwordless sudo (overlayfs) or a reflink filesystem";
  }
  if (!hint && code !== 0 && errTail) {
    const missing = ignoredPathsIn(errTail, rec);
    if (missing.length) hint = `${missing.slice(0, 3).join(", ")} ${missing.length === 1 ? "exists" : "exist"} here but git ignores ${missing.length === 1 ? "it" : "them"}, so the snapshot did not carry ${missing.length === 1 ? "it" : "them"} to the host`;
  }
  rec.timings = { ...rec.timings, outputsBackMs: Date.now() - t0 };
  rec.code = code;
  rec.reason = state.reason;
  saveRecord(rec);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  if (state.reason === "cancelled") code = EXIT_CANCELLED;
  if (hint) io.err(`${formatHint(hint)}\n`);
  return code;
}

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

export interface SubmitInput {
  plan: RunPlan;
  transport: Transport;
  host: RunRecord["host"];
  /** Host home, for the repo path (its main checkout of this repo, when it has one). */
  hostRepo: string;
  env?: Record<string, string>;
  maxUploadMb?: number;
  queueWaitS?: number;
  quiet?: boolean;
  io?: Out;
  id?: string;
  timings?: Record<string, number>;
  /** Called with the run id once the snapshot reached the host. */
  onId?: (id: string) => void;
  /** Called with the run id when its record is saved, before the push. */
  onPrepared?: (id: string) => void;
  /** Called with the run id once the host has accepted it. */
  onAccepted?: (id: string) => void;
}

/** Snapshot, push and submit. Returns the record once the host has accepted the run. */
export async function submitRun(input: SubmitInput): Promise<RunRecord> {
  const { plan, transport: t } = input;
  const io = input.io ?? stdio;
  const timings: Record<string, number> = { ...(input.timings ?? {}) };
  const lap = (name: string, since: number) => { timings[name] = Date.now() - since; return Date.now(); };

  let t0 = Date.now();
  const snap = await createWipSnapshotStrict(plan.seedCwd, { exclude: CLOUD_SEED_EXCLUDES }).catch((e: Error) => {
    throw new InfraError(`snapshot of ${plan.seedCwd} failed: ${lastLine(e.message)}`);
  });
  if (!snap) throw new InfraError(`${plan.seedCwd} has no commits to snapshot`, "commit once, then cast run");
  if (plan.cwdRel && spawnSync("git", ["-C", plan.seedCwd, "cat-file", "-e", `${snap.sha}:${plan.cwdRel}`]).status !== 0) {
    throw new InfraError(`${plan.cwdRel} is not in the snapshot`, "git ignores it, or it holds no files git would track; run from a directory the checkout tracks");
  }
  t0 = lap("snapshotMs", t0);
  const origin = spawnSync("git", ["-C", plan.seedCwd, "remote", "get-url", "origin"], { encoding: "utf-8" });
  // Never a credential: an https origin with a token in it travels as the bare URL (the host fetches with its own access).
  const originUrl = origin.status === 0 ? String(origin.stdout).trim().replace(/^(https?:\/\/)[^@/]+@/, "$1") : "";
  const id = input.id ?? newRunId();
  const prep = await runnerJsonAsync<{ repo: string; created: boolean; tips: string[]; hasBase?: boolean }>(t, ["prep", input.hostRepo, originUrl, snap.base, id], 1_800_000);
  t0 = lap("prepMs", t0);
  const est = estimateUpload(plan.seedCwd, snap.sha, prep.hasBase ? [snap.base, ...prep.tips] : prep.tips);
  t0 = lap("estimateMs", t0);
  const limit = input.maxUploadMb ?? plan.spec.maxUploadMb;
  if (est.bytes > limit * 1024 * 1024) {
    const top = est.top.slice(0, 3).map((d) => `${d.dir} ${fmtBytes(d.bytes)}`).join(", ");
    const fresh = !prep.hasBase && !knownCommits(plan.seedCwd, prep.tips).length;
    throw new InfraError(
      `the snapshot would upload ${fmtBytes(est.bytes)} to ${t.label}, over the ${limit} MB limit (${top})`,
      fresh ? `${t.label} has no copy of this repo yet, so the first push carries its history; pass --max-upload-mb ${Math.ceil(est.bytes / 1048576) + 1} once` : `if those are build output, add them to .gitignore; otherwise pass --max-upload-mb ${Math.ceil(est.bytes / 1048576) + 1}`,
    );
  }
  const job = plan.job;
  // Saved before the push, so a client killed mid-submit still leaves an id `cast run wait` can ask the host about.
  const rec: RunRecord = {
    id,
    host: input.host,
    repo: prep.repo,
    seedCwd: plan.seedCwd,
    cwdRel: plan.cwdRel,
    argv: plan.argv,
    ...(job ? { job: job.name } : {}),
    outputs: job?.outputs ?? [],
    sha: snap.sha,
    base: snap.base,
    dirty: snap.dirty,
    createdAt: Date.now(),
    timings,
    uploadBytes: est.bytes,
  };
  saveRecord(rec);
  input.onPrepared?.(id);
  const ref = `refs/codecast/run/${id}`;
  const target = t.pushTarget(prep.repo);
  const push = await collect(spawn("git", ["-C", plan.seedCwd, "push", "-q", "--force", "--no-verify", "--", target.url, `${snap.sha}:${ref}`], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...target.env } }), { timeoutMs: 900_000 });
  if (push.status === 0) input.onId?.(id);
  if (push.status !== 0) dropRecord(id);
  if (push.status !== 0) throw new InfraError(`git push of the snapshot to ${t.label} failed: ${lastLine(push.stderr)}`, "the command did not start; check the host with cast remote hosts", EXIT_INFRA, /Could not resolve|timed out|Connection refused|No route|unreachable/i.test(push.stderr));
  t0 = lap("pushMs", t0);

  const wire: RunSpecWire = {
    id,
    repo: prep.repo,
    sha: snap.sha,
    ref,
    cwdRel: plan.cwdRel,
    argv: plan.argv,
    env: { ...(process.stdout.isTTY ? { FORCE_COLOR: "1" } : {}), ...(input.env ?? {}) },
    outputs: job?.outputs ?? [],
    memoryGb: job?.memoryGb ?? 2,
    timeoutMin: job?.timeoutMin ?? 30,
    ...(job?.keepDaemons ? { keepDaemons: true } : {}),
    ...(Object.keys(plan.ports).length ? { ports: plan.ports } : {}),
    install: plan.install,
    depsKey: plan.spec.depsKey ?? [],
    keepDeps: plan.spec.keepDeps,
    queueWaitS: input.queueWaitS ?? 600,
  };
  let answer: { accepted: boolean; error?: string; state?: RunStateWire } | undefined;
  let lastErr: unknown;
  // Submit is idempotent by run id: an answer lost on the way back is asked for again, never resubmitted as a new run.
  for (let attempt = 0; attempt < 6 && !(answer?.accepted || (answer && !(answer as { retry?: boolean }).retry)); attempt++) {
    try {
      answer = await runnerJsonAsync(t, ["submit"], 60_000, JSON.stringify(wire));
    } catch (e) {
      lastErr = e;
      // A runner that answered with an error will answer the same again: only a lost connection is worth retrying.
      if (!(e instanceof InfraError && (e.unreachable || /gave no answer/.test(e.message)))) break;
    }
    if (!answer?.accepted) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!answer || (!answer.accepted && (answer as { retry?: boolean }).retry)) {
    // No answer (or a host still busy with an earlier attempt) is not a refusal: the run may have started.
    rec.reason = "unconfirmed";
    saveRecord(rec);
    const e = lastErr instanceof InfraError ? lastErr : new InfraError(lastErr ? String(lastErr) : "the host kept answering that an earlier submit of this run is still in progress");
    throw new InfraError(e.message, `the run may have started before the connection failed; cast run wait ${id} finds out`, EXIT_INFRA, e.unreachable);
  }
  if (!answer.accepted) {
    t.run(`git -C ${shq(prep.repo)} update-ref -d ${shq(ref)}`, { timeoutMs: 15_000 });
    dropRecord(id);
    throw new InfraError(`the host refused the run: ${answer.error}`);
  }
  lap("submitMs", t0);
  input.onAccepted?.(id);
  rec.timings = timings;
  saveRecord(rec);
  pruneRecords();
  if (!input.quiet) {
    io.err(`cast: run ${id} on ${t.label}: snapshot ${snap.sha.slice(0, 8)}${snap.dirty ? " (uncommitted work)" : ""}, ${fmtBytes(est.bytes)} to send, sent in ${fmtMs(timings.pushMs ?? 0)}${job ? `, job ${job.name}` : ""}\n`);
  }
  return rec;
}

/** Follow a submitted run to the end and return the exit code for this process. */
export async function awaitRun(t: Transport, rec: RunRecord, io: Out, opts: { maxWaitS?: number; quiet?: boolean; interruptCancels?: boolean } = {}): Promise<number> {
  const t0 = Date.now();
  const deadline = opts.maxWaitS ? t0 + opts.maxWaitS * 1000 : Infinity;
  let end: FollowEnd;
  try {
    end = await follow(t, rec.id, io, { maxWaitS: opts.maxWaitS, quiet: opts.quiet, ...(opts.interruptCancels === false ? { interruptCancels: false } : {}) });
  } catch (e) {
    return reportInfra(e, io);
  }
  rec.timings = { ...rec.timings, followMs: Date.now() - t0 };
  if (end.kind === "detached") {
    saveRecord(rec);
    if (end.detail) io.err(`cast: ${end.detail}\n`);
    io.err(`${formatHint(end.why === "interrupt" ? `cancel sent to ${rec.id}; cast run show ${rec.id} says when it stopped` : `run ${rec.id} continues on the host; cast run wait ${rec.id} follows it again`)}\n`);
    return end.why === "interrupt" ? EXIT_CANCELLED : EXIT_WAIT_ELAPSED;
  }
  // Done, but out of time: bringing outputs back can take long, and the caller sized --max-wait to its own limit.
  if (Date.now() > deadline && (end.state.outputs?.files ?? 0) > 0 && !rec.outputsApplied) {
    saveRecord(rec);
    io.err(`${formatHint(`run ${rec.id} finished with exit ${end.state.code}; its outputs are not here yet: cast run wait ${rec.id} brings them`)}\n`);
    return EXIT_WAIT_ELAPSED;
  }
  try {
    return finishRun(t, rec, end.state, io, end.errTail);
  } catch (e) {
    return reportInfra(e, io);
  }
}

export function reportInfra(e: unknown, io: Out = stdio): number {
  if (e instanceof InfraError) {
    io.err(`cast: ${e.message}\n`);
    if (e.hint) io.err(`${formatHint(e.hint)}\n`);
    return e.code;
  }
  io.err(`cast: ${(e as Error)?.message ?? String(e)}\n`);
  return EXIT_INFRA;
}
