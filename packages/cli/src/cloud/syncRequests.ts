/**
 * The laptop's answers to `cast sync status | pull | push | diff`, asked by
 * an agent on the cloud host or by a person here. They arrive as
 * cloud_live_sync commands with an `op` (convex cloud.requestSync) and run
 * in the laptop's daemon, the one place that reaches both the laptop's files
 * and the host.
 *
 * These fill the gaps the automatic sync leaves:
 *   pull <path>    any file or folder from the laptop, a skipped one, one
 *                  outside the repo (~/data/x.csv), with no limit short of
 *                  PULL_HARD_CAP_BYTES
 *   pull --ref     a branch or commit only the laptop has
 *   pull / push    a sync right now: with a sync running, one tick; without
 *                  one, the laptop checkout's changes since the session
 *                  started, merged into the cloud copy
 *   status         what differs and what stayed behind, and why
 *   diff <path>    the laptop's version against the cloud's
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "../proc.js";
import { gitSshUrl, remoteHome, shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { mergeTrees, overlayTree, sshHostSide } from "./liveSync.js";
import type { LiveSyncJobs } from "./liveSyncJobs.js";
import { describeSkipped, runRemoteSide, runSide, type LandResult, type LsEntry, type Skipped, type SnapshotResult, type SyncScope } from "./syncSide.js";

/** Nothing a single pull carries may be bigger than this; past it the answer names the size. */
export const PULL_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const LISTED = 40;

export interface SyncRequestArgs {
  op: "status" | "pull" | "push" | "diff";
  conversation_id: string;
  host_device_id: string;
  remote_cwd: string;
  local_root: string;
  paths?: string[];
  ref?: string;
  seed_tree?: string;
}

export interface SyncRequestDeps {
  jobs: LiveSyncJobs;
  hostFor: (hostDeviceId: string) => RemoteHost | null;
  scopeFor: (localRoot: string) => SyncScope | undefined;
  home?: string;
}

/** What the asking CLI prints: plain lines, first one the answer. */
export interface SyncAnswer { lines: string[]; conflicts?: string[] }

function run(cmd: string, args: string[], opts: { input?: NodeJS.ReadableStream; env?: NodeJS.ProcessEnv; cwd?: string } = {}): { child: ReturnType<typeof spawn>; done: Promise<string> } {
  const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] });
  if (opts.input) opts.input.pipe(child.stdin!);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (d: Buffer) => out.push(d));
  child.stderr!.on("data", (d: Buffer) => err.push(d));
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(`${cmd}: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `exit ${code}`}`)));
  });
  return { child, done };
}

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => run("git", ["-C", cwd, ...args], { env }).done.then((s) => s.trim());

/** One bash pipeline, so the OS carries the bytes and pipefail names any stage's failure. */
function pipeline(line: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return run("bash", ["-o", "pipefail", "-c", line], { env }).done;
}
const sshLine = (host: RemoteHost, command: string) => ["ssh", ...sshArgs(host, command)].map(shq).join(" ");
/** Unpack a tar stream into `dir` only once all of it arrived: a cut stream leaves nothing half-written. */
const unpackInto = (dir: string) => `d=${shq(dir)}; t=$(mktemp -d "\${TMPDIR:-/tmp}/codecast-pull.XXXXXX") && tar -C "$t" -xf - && mkdir -p "$d" && cp -a "$t"/. "$d"/ && rm -rf "$t"`;
const sshArgs = (host: RemoteHost, command: string) => [...sshBase(host), `${host.user}@${host.address}`, command];
const mb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const listed = (items: string[]) => items.length > LISTED ? [...items.slice(0, LISTED), `…and ${items.length - LISTED} more`] : items;

/**
 * Where a requested path lives on each machine: repo-relative paths map
 * between the laptop checkout and the cloud working folder, `~/…` and
 * absolute paths under the laptop's home map to the same place in the
 * host's home. Anything else is refused by name.
 */
export function mapPath(p: string, where: { localRoot: string; remoteCwd: string; home: string; hostHome: string }): { from: string; fromRoot: string; to: string; rel: string; outside: boolean } {
  const clean = p.trim().replace(/\/+$/, "");
  if (!clean) throw new Error("an empty path");
  let fromRoot: string, toRoot: string, rel: string, outside = false;
  if (clean === "~" || clean.startsWith("~/") || path.isAbsolute(clean)) {
    const abs = clean === "~" ? where.home : clean.startsWith("~/") ? path.join(where.home, clean.slice(2)) : path.resolve(clean);
    if (abs === where.home) throw new Error(`${p} is your whole home folder; name what inside it to bring`);
    if (abs.startsWith(where.localRoot + path.sep) || abs === where.localRoot) {
      fromRoot = where.localRoot; toRoot = where.remoteCwd; rel = path.relative(where.localRoot, abs);
    } else if (abs.startsWith(where.home + path.sep)) {
      fromRoot = where.home; toRoot = where.hostHome; rel = path.relative(where.home, abs); outside = true;
    } else throw new Error(`${p} is outside your home folder, which is all a pull reaches`);
  } else {
    fromRoot = where.localRoot; toRoot = where.remoteCwd; rel = path.normalize(clean);
  }
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${p} leaves the folder it names`);
  return { from: path.join(fromRoot, rel), fromRoot, to: path.posix.join(toRoot, rel.split(path.sep).join("/")), rel, outside };
}

export async function handleSyncRequest(args: SyncRequestArgs, deps: SyncRequestDeps): Promise<SyncAnswer> {
  const host = deps.hostFor(args.host_device_id);
  if (!host) throw new Error("this laptop does not manage that cloud host (cast hosts ls)");
  const scope = deps.scopeFor(args.local_root);
  const home = deps.home ?? os.homedir();
  const where = { localRoot: args.local_root, remoteCwd: args.remote_cwd, home, hostHome: remoteHome(host) };
  switch (args.op) {
    case "status": return status(args, deps, host, scope);
    case "diff": return diff(args, deps, host, where);
    case "pull":
      if (args.ref) return pullRef(args, host);
      if (args.paths?.length) return pullPaths(args, host, where);
      return syncNow(args, deps, host, scope, "pull");
    case "push":
      return args.paths?.length ? pushPaths(args, deps, host) : syncNow(args, deps, host, scope, "push");
  }
}

/**
 * What stayed on one machine, in a few lines: dependency folders as one
 * count, then the rest largest first, then how to get any of it.
 */
export function skippedLines(label: string, skipped: Skipped[], fetchable = false): string[] {
  if (!skipped.length) return [];
  const rebuilt = skipped.filter((s) => s.reason === "rebuilt");
  const rest = skipped.filter((s) => s.reason !== "rebuilt").sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const shown = rest.slice(0, 8).map((s) => `  ${describeSkipped(s)}`);
  return [
    `stayed on ${label}:`,
    ...(rebuilt.length ? [`  ${rebuilt.length} dependency or build folder${rebuilt.length === 1 ? "" : "s"} (${rebuilt.slice(0, 3).map((s) => s.path).join(", ")}${rebuilt.length > 3 ? ", …" : ""}): rebuilt on each machine`] : []),
    ...shown,
    ...(rest.length > shown.length ? [`  …and ${rest.length - shown.length} more`] : []),
    ...(fetchable && rest.length ? ["  cast sync pull <path> brings any of these here"] : []),
  ];
}

async function status(args: SyncRequestArgs, deps: SyncRequestDeps, host: RemoteHost, scope?: SyncScope): Promise<SyncAnswer> {
  const job = deps.jobs.describe(args.conversation_id);
  if (job) {
    // What the laptop checkout holds that never came here: the answer to "what am I missing".
    const checkout = runSide<SnapshotResult>({ op: "snapshot", cwd: args.local_root, scope }).catch(() => null);
    const r = await deps.jobs.syncNow(args.conversation_id);
    const d = deps.jobs.describe(args.conversation_id)!;
    const head = d.conflicts.length
      ? `${d.conflicts.length} file${d.conflicts.length === 1 ? "" : "s"} changed on both sides, holding until someone picks: cast sync keep laptop|cloud [paths]`
      : r.kind === "local_edit" ? `the laptop copy is watch-only and was edited there (${r.files.slice(0, 5).join(", ")})`
      : `in step with the laptop copy at ${d.dir}${d.mode === "from_cloud" ? " (watch-only: changes go from the cloud to the laptop)" : " (changes travel both ways)"}`;
    return {
      lines: [
        head, ...listed(d.conflicts.map((p) => `  both changed: ${p}`)),
        ...skippedLines("this machine", d.hostSkipped),
        ...skippedLines(`the laptop checkout (${args.local_root})`, (await checkout)?.skipped ?? [], true),
      ],
      conflicts: d.conflicts,
    };
  }
  // No sync running: compare the cloud folder with the laptop checkout, each against where the session started.
  const [h, l] = await Promise.all([
    runRemoteSide<SnapshotResult>(host, { op: "snapshot", cwd: args.remote_cwd, scope }),
    runSide<SnapshotResult>({ op: "snapshot", cwd: args.local_root, scope, commit: true }),
  ]);
  await fetchHostTree(args, host, scope);
  const base = args.seed_tree && (await git(args.local_root, ["cat-file", "-t", args.seed_tree]).catch(() => "")) === "tree" ? args.seed_tree : null;
  const changed = async (a: string, b: string) => a === b ? [] : (await git(args.local_root, ["diff", "--name-only", "-z", a, b])).split("\0").filter(Boolean);
  const lines: string[] = [];
  if (base) {
    const onLaptop = await changed(base, l.tree);
    const inCloud = await changed(base, h.tree);
    const both = onLaptop.filter((p) => inCloud.includes(p));
    lines.push(onLaptop.length ? `${onLaptop.length} file${onLaptop.length === 1 ? "" : "s"} changed on the laptop since this session started (cast sync pull brings them here):` : "nothing changed on the laptop since this session started");
    lines.push(...listed(onLaptop.map((p) => `  ${both.includes(p) ? "also changed here: " : ""}${p}`)));
  } else {
    const differ = await changed(h.tree, l.tree);
    lines.push(differ.length ? `${differ.length} file${differ.length === 1 ? "" : "s"} differ between here and the laptop checkout:` : "the same as the laptop checkout");
    lines.push(...listed(differ.map((p) => `  ${p}`)));
  }
  lines.push("no live sync is running; cast sync push starts one into a laptop copy");
  return { lines: [...lines, ...skippedLines("this machine", h.skipped), ...skippedLines(`the laptop checkout (${args.local_root})`, l.skipped, true)] };
}

/** The host's current tree, reachable in the laptop repo (for comparisons and merges). */
async function fetchHostTree(args: SyncRequestArgs, host: RemoteHost, scope?: SyncScope): Promise<SnapshotResult> {
  const ref = `refs/codecast/sync/${args.conversation_id}-request`;
  const snap = await runRemoteSide<SnapshotResult>(host, { op: "snapshot", cwd: args.remote_cwd, scope, commit: true, ref });
  await git(args.local_root, ["fetch", "--quiet", "--no-tags", gitSshUrl(host, args.remote_cwd), `+${ref}:${ref}`], { GIT_SSH_COMMAND: `ssh ${sshBase(host).map(shq).join(" ")}` });
  return snap;
}

async function syncNow(args: SyncRequestArgs, deps: SyncRequestDeps, host: RemoteHost, scope: SyncScope | undefined, op: "pull" | "push"): Promise<SyncAnswer> {
  if (!deps.jobs.describe(args.conversation_id) && op === "push") {
    await deps.jobs.start({ conversation_id: args.conversation_id, host_device_id: args.host_device_id, remote_cwd: args.remote_cwd, local_root: args.local_root, mode: "two_way" });
  }
  if (deps.jobs.describe(args.conversation_id)) {
    const r = await deps.jobs.syncNow(args.conversation_id);
    const dir = deps.jobs.describe(args.conversation_id)!.dir;
    switch (r.kind) {
      case "idle": return { lines: [`already in step with the laptop copy at ${dir}`] };
      case "synced": return { lines: [`in step with the laptop copy at ${dir}: ${r.toHost.length} file${r.toHost.length === 1 ? "" : "s"} came here, ${r.toLaptop.length} went there`, ...listed([...r.toHost.map((p) => `  ← ${p}`), ...r.toLaptop.map((p) => `  → ${p}`)])] };
      case "conflict": return { lines: [`${r.paths.length} file${r.paths.length === 1 ? "" : "s"} changed on both sides and hold, each side keeping its own; the rest is in step`, ...listed(r.paths.map((p) => `  both changed: ${p}`)), "cast sync keep laptop|cloud [paths] settles them"], conflicts: r.paths };
      case "local_edit": return { lines: [`the laptop copy is watch-only and was edited there: ${r.files.slice(0, 5).join(", ")}`] };
      case "retry": return { lines: ["a file changed while syncing; run it again in a moment"] };
    }
  }
  return pullCheckout(args, host, scope);
}

/**
 * No sync running: bring the laptop checkout's changes since the session
 * started into the cloud folder, merged with what the agent changed. A file
 * both changed keeps the cloud's version and is named.
 */
async function pullCheckout(args: SyncRequestArgs, host: RemoteHost, scope?: SyncScope): Promise<SyncAnswer> {
  const [h, l] = await Promise.all([fetchHostTree(args, host, scope), runSide<SnapshotResult>({ op: "snapshot", cwd: args.local_root, scope, commit: true })]);
  const knownSeed = args.seed_tree && (await git(args.local_root, ["cat-file", "-t", args.seed_tree]).catch(() => "")) === "tree";
  // Without the start, the best common ground is the cloud's last commit.
  const base = knownSeed ? args.seed_tree! : await git(args.local_root, ["rev-parse", `${h.head}^{tree}`]);
  if (l.tree === base) return { lines: ["nothing changed on the laptop since this session started"] };
  const merged = await mergeTrees(args.local_root, base, l.tree, h.tree);
  const tree = await overlayTree(args.local_root, merged.tree, h.tree, merged.conflicts);
  if (tree === h.tree) return { lines: ["already here: the laptop's changes match this folder"], conflicts: merged.conflicts };
  const date = await git(args.local_root, ["log", "-1", "--format=%cI", h.head]);
  const id = { GIT_AUTHOR_NAME: "codecast", GIT_AUTHOR_EMAIL: "codecast@localhost", GIT_COMMITTER_NAME: "codecast", GIT_COMMITTER_EMAIL: "codecast@localhost", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const sha = await git(args.local_root, ["commit-tree", tree, "-p", h.head, "-m", "codecast sync"], id);
  const side = sshHostSide(host, args.remote_cwd, `${args.conversation_id}-request`, args.local_root, scope);
  await side.send(sha);
  const r = await runRemoteSide<LandResult>(host, { op: "land", cwd: args.remote_cwd, scope, sha, expectTree: h.tree });
  if (!r.landed) return { lines: ["a file here changed while pulling; run it again in a moment"] };
  return {
    lines: [
      `brought ${r.changed.length} file${r.changed.length === 1 ? "" : "s"} from the laptop checkout`,
      ...listed(r.changed.map((p) => `  ← ${p}`)),
      ...(merged.conflicts.length ? ["changed both here and on the laptop, kept as they are here (cast sync diff <path> compares):", ...listed(merged.conflicts.map((p) => `  ${p}`))] : []),
    ],
    conflicts: merged.conflicts,
  };
}

async function pullPaths(args: SyncRequestArgs, host: RemoteHost, where: Parameters<typeof mapPath>[1]): Promise<SyncAnswer> {
  const mapped = args.paths!.map((p) => ({ asked: p, ...mapPath(p, where) }));
  const sizes = await runSide<LsEntry[]>({ op: "ls", cwd: args.local_root, paths: mapped.map((m) => m.from) });
  const missing = mapped.filter((_, i) => sizes[i]!.kind === "missing");
  const present = mapped.filter((_, i) => sizes[i]!.kind !== "missing");
  const total = sizes.reduce((n, s) => n + (s.bytes ?? 0), 0);
  if (total > PULL_HARD_CAP_BYTES) throw new Error(`that is ${mb(total)}, over the ${mb(PULL_HARD_CAP_BYTES)} a pull carries; name smaller parts`);
  // One tar stream per root, unpacked in the matching place on the host.
  const groups = new Map<string, { fromRoot: string; toRoot: string; rels: string[] }>();
  for (const m of present) {
    const toRoot = m.to.slice(0, m.to.length - m.rel.length - 1);
    const key = `${m.fromRoot}\0${toRoot}`;
    const g = groups.get(key) ?? { fromRoot: m.fromRoot, toRoot, rels: [] };
    g.rels.push(m.rel);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    // COPYFILE_DISABLE: macOS tar would otherwise add ._ resource files beside each file.
    await pipeline(`tar -C ${shq(g.fromRoot)} -cf - -- ${g.rels.map(shq).join(" ")} | ${sshLine(host, unpackInto(g.toRoot))}`, { COPYFILE_DISABLE: "1" });
  }
  const size = (m: (typeof mapped)[number]) => sizes[mapped.indexOf(m)]?.bytes;
  return {
    lines: [
      present.length ? `brought ${present.length} path${present.length === 1 ? "" : "s"} from the laptop` : "nothing brought",
      ...present.map((m) => `  ← ${m.asked}${size(m) ? ` (${mb(size(m)!)})` : ""}${m.outside ? ` into ${m.to}` : ""}`),
      ...(missing.length ? [`not on the laptop: ${missing.map((m) => m.asked).join(", ")}`] : []),
    ],
  };
}

async function pullRef(args: SyncRequestArgs, host: RemoteHost): Promise<SyncAnswer> {
  const ref = args.ref!;
  const sha = await git(args.local_root, ["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => { throw new Error(`the laptop has no branch or commit named ${ref}`); });
  const name = /^[0-9a-f]{7,40}$/.test(ref) ? sha.slice(0, 12) : ref.replace(/^refs\/heads\//, "");
  await git(args.local_root, ["push", "--quiet", "--force", "--no-verify", gitSshUrl(host, args.remote_cwd), `${sha}:refs/remotes/laptop/${name}`], { GIT_SSH_COMMAND: `ssh ${sshBase(host).map(shq).join(" ")}` });
  return { lines: [`brought ${ref} (${sha.slice(0, 10)}) from the laptop as laptop/${name}: git log laptop/${name}, git checkout laptop/${name} -- <paths>, or git merge laptop/${name}`] };
}

async function pushPaths(args: SyncRequestArgs, deps: SyncRequestDeps, host: RemoteHost): Promise<SyncAnswer> {
  const job = deps.jobs.describe(args.conversation_id) ?? (await deps.jobs.start({ conversation_id: args.conversation_id, host_device_id: args.host_device_id, remote_cwd: args.remote_cwd, local_root: args.local_root, mode: "two_way" }), deps.jobs.describe(args.conversation_id)!);
  const rels = args.paths!.map((p) => {
    const r = path.posix.normalize(p.trim().replace(/\/+$/, ""));
    if (!r || r === "." || r.startsWith("..") || path.posix.isAbsolute(r) || r.startsWith("~")) throw new Error(`${p}: push sends paths inside this folder to the laptop copy`);
    return r;
  });
  await pipeline(`${sshLine(host, `cd ${shq(args.remote_cwd)} && tar -cf - -- ${rels.map(shq).join(" ")}`)} | bash -c ${shq(unpackInto(job.dir))}`);
  return { lines: [`sent ${rels.length} path${rels.length === 1 ? "" : "s"} to the laptop copy at ${job.dir}`, ...listed(rels.map((r) => `  → ${r}`))] };
}

async function diff(args: SyncRequestArgs, deps: SyncRequestDeps, host: RemoteHost, where: Parameters<typeof mapPath>[1]): Promise<SyncAnswer> {
  const p = args.paths?.[0];
  if (!p) throw new Error("diff names one path");
  // With a sync running, the laptop's side of a repo file is its laptop copy; otherwise the checkout.
  const copy = deps.jobs.describe(args.conversation_id)?.dir;
  const m = mapPath(p, copy ? { ...where, localRoot: copy } : where);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-diff-"));
  try {
    const label = m.rel.split(path.sep).join("/");
    for (const side of ["laptop", "cloud"]) fs.mkdirSync(path.dirname(path.join(tmp, side, label)), { recursive: true });
    fs.writeFileSync(path.join(tmp, "laptop", label), fs.existsSync(m.from) ? fs.readFileSync(m.from) : "");
    fs.writeFileSync(path.join(tmp, "cloud", label), await run("ssh", sshArgs(host, `cat ${shq(m.to)} 2>/dev/null || true`)).done);
    const out = await new Promise<string>((resolve) => {
      const c = spawn("git", ["diff", "--no-index", "--no-color", "--no-prefix", `laptop/${label}`, `cloud/${label}`], { cwd: tmp, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      c.stdout!.on("data", (d: Buffer) => chunks.push(d));
      c.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    if (!out.trim()) return { lines: [`${p} is the same on the laptop${copy ? " copy" : ""} and here`] };
    return { lines: [`${p}: the laptop${copy ? " copy" : ""} (-) against here (+)`, ...out.split("\n").slice(0, 400)] };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
