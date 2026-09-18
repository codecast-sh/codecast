/**
 * `cast hosts` — the remote machines codecast can run on.
 *
 * The group started life under `cast browser` because a remote Chrome was the
 * first thing anyone put on a cloud box. It is no longer only that: the same
 * instance runs a codecast daemon, holds git worktrees and hosts sessions
 * moved there from a laptop. So the builder lives here and is mounted twice —
 * at the top level as `cast hosts`, and under `cast browser hosts`, which
 * keeps every documented command working. One implementation, two names.
 *
 * `ls` answers the question a person actually has when they think about these
 * machines: what is running on it, and what is it costing me. That means one
 * block per host with its state, its codecast device, its live sessions, its
 * worktrees and a price estimate. Each of those comes from a different system
 * (AWS, Convex, SSH), so every one of them is fetched behind its own guard:
 * a field that cannot be read prints "unknown (reason)" and the rest of the
 * block still prints. A sleeping host, a missing aws CLI and an expired token
 * are all ordinary states here, not failures.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { fmt, icons } from "../colors.js";
import { formatAgeShort } from "../publishCommand.js";
import {
  ensureUp, hostState, inspectHost, patchHost, readHosts, stopHost, toRemoteHost, upsertHost, writeHosts,
  type CloudHost, type HostState,
} from "../browser/cloudHost.js";
import { AGENT_BRIDGE_MIN_WATCHDOG } from "../cloud/agentBridge.js";
import { ACCOUNT_KEY_URL, cwdGitRoot, deployKeyUrl, githubRepo, hostAccessPath, repoOrigin, type HostAccessPath, type HostGitState } from "../cloud/hostGit.js";
import { hostToolsDetailLines, parseHostToolsStamp, summarizeHostTools, type HostToolsReport } from "../cloud/hostTools.js";
import { parseHostMcpOverrides } from "../cloud/hostMcpOverrides.js";
import { deviceId } from "../remote/device.js";
import { ssh, type RemoteHost } from "../remote/session-move.js";
import { ROOT_WORKSPACE_NAME, type AgentLoginsReport } from "../cloud/prepare.js";
import { DANGLING_SEED_REFS_SCRIPT } from "../cloud/transfer.js";
import { cloudSeedLabel } from "@codecast/shared/contracts";
import { commandGroup } from "../commandGroups.js";
import { registerHostKeepaliveCommand } from "../cloud/keepalive.js";

const OK = fmt.success(icons.check);

function die(msg: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Cost
// --------------------------------------------------------------------------

/**
 * On-demand USD per hour, us-west-2, Linux. A short table on purpose: these
 * are the types we actually launch, and a wrong price is worse than an
 * admitted unknown, so an unlisted type prints "rate unknown" rather than
 * being guessed from its family.
 */
export const EC2_HOURLY_USD: Record<string, number> = {
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
};

/** gp3 storage, USD per GiB-month. This is the whole bill of a sleeping host. */
export const GP3_USD_PER_GIB_MONTH = 0.08;

export interface HostCost {
  hourlyUsd: number | null;
  diskMonthlyUsd: number | null;
  line: string;
}

/** Money, to the cent. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** An hourly rate, which is cents-per-hour small: four places, no padding. */
function usdRate(n: number): string {
  return `$${n.toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

/**
 * What this machine costs, in the one sentence a person needs.
 *
 * A stopped instance bills only its disk, which is the entire argument for
 * Linux over a Mac, so the asleep line names that explicitly. A running one
 * shows both halves: the hourly rate it is burning now, and the disk it will
 * keep costing after it sleeps.
 */
export function estimateHostCost(input: {
  instanceType?: string;
  volumeGiB?: number;
  state: HostState | string;
}): HostCost {
  const hourlyUsd = input.instanceType ? EC2_HOURLY_USD[input.instanceType] ?? null : null;
  const diskMonthlyUsd = typeof input.volumeGiB === "number" ? input.volumeGiB * GP3_USD_PER_GIB_MONTH : null;
  const disk = diskMonthlyUsd === null ? "disk size unknown" : `about ${usd(diskMonthlyUsd)}/month disk`;

  if (input.state === "missing") return { hourlyUsd, diskMonthlyUsd, line: "gone: nothing left to bill" };

  if (input.state !== "running") {
    const line =
      diskMonthlyUsd === null
        ? "asleep: disk size unknown"
        : `asleep: about ${usd(diskMonthlyUsd)}/month (disk only)`;
    return { hourlyUsd, diskMonthlyUsd, line };
  }

  const rate =
    hourlyUsd === null
      ? `rate unknown for ${input.instanceType ?? "an unknown instance type"}`
      : `about ${usdRate(hourlyUsd)}/hour running`;
  return { hourlyUsd, diskMonthlyUsd, line: `awake: ${rate}, ${disk}` };
}

// --------------------------------------------------------------------------
// Worktrees, read from the host itself
// --------------------------------------------------------------------------

export interface RemoteWorktree {
  /** The checkout the worktree belongs to, e.g. "codecast". */
  repo: string;
  name: string;
  state: string;
  branch: string;
  path: string;
  /** Where the checkout is NOW, read with git on the host: `branch` above is only what it started on. */
  live?: WorktreeGitState;
}

export interface WorktreeGitState {
  /** The checked out branch, empty when HEAD is detached. */
  branch: string;
  /** Full HEAD commit, empty on an unborn branch. */
  head: string;
  /** Uncommitted changes, untracked files included. */
  dirty: boolean;
}

/**
 * Every repo checkout on the box that codecast manages worktrees for, asked
 * for its own `cast ws ls`. The host is the authority here: it allocated the
 * worktrees and their ports, so reading its answer beats inferring one from
 * session rows, which only know about worktrees that still have a session.
 */
// The trailing `exit 0` is load-bearing. With `[ -f … ] && (…)` as the loop
// body, a last directory that is not a codecast checkout makes the test the
// loop's final command, the loop exits 1, and ssh reports the whole listing as
// a failure. Seen live: one non-checkout directory on the box turned every
// worktree into "unknown".
//
// The same round trip reads each git worktree of the checkout (the main
// checkout first) as a `@@<TAB>path<TAB>branch<TAB>head<TAB>dirty` line, so
// the listing shows where every worktree is now, not where it started.
export const REMOTE_WORKSPACE_LIST_SCRIPT =
  'for d in ~/work/*/; do [ -f "$d/.codecast/workspace.toml" ] || continue; ' +
  '(cd "$d" && echo "## $d" && cast ws ls); ' +
  'git -C "$d" worktree list --porcelain 2>/dev/null | sed -n "s/^worktree //p" | while IFS= read -r p; do ' +
  '[ -d "$p" ] || continue; ' +
  'b=$(git -C "$p" symbolic-ref --short -q HEAD 2>/dev/null); h=$(git -C "$p" rev-parse -q --verify HEAD 2>/dev/null); ' +
  's=$(git -C "$p" status --porcelain 2>/dev/null | head -c 1); ' +
  'printf "@@\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$b" "$h" "${s:+dirty}"; done; done; exit 0';

/**
 * Parse the concatenated `cast ws ls` output. Each checkout is announced by a
 * `## <path>` line; then a NAME/STATE/BRANCH/PATH table, or "(no workspaces)".
 * Anything that is not four columns is dropped, which is how a shell warning
 * or a stray error line on stderr fails to become a phantom worktree.
 */
/**
 * Every checkout's seed refs (refs/codecast/cloud/<name>) that have no
 * workspace state dir: a `## <path>` header per checkout, one name per line.
 */
export const REMOTE_DANGLING_SEEDS_SCRIPT =
  'for d in ~/work/*/; do [ -d "$d/.git" ] || continue; ' +
  `(cd "$d" && echo "## $d" && ${DANGLING_SEED_REFS_SCRIPT}); done; exit 0`;

export function parseDanglingSeeds(out: string): Array<{ repo: string; name: string }> {
  const rows: Array<{ repo: string; name: string }> = [];
  let repo = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const header = /^##\s+(.*)$/.exec(line);
    if (header) { repo = path.posix.basename(header[1].trim().replace(/\/+$/, "")); continue; }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(line)) rows.push({ repo, name: line });
  }
  return rows;
}

export function parseRemoteWorkspaceList(out: string): RemoteWorktree[] {
  const rows: RemoteWorktree[] = [];
  const live = new Map<string, WorktreeGitState>();
  const checkouts: Array<{ repo: string; path: string }> = [];
  let repo = "";
  for (const raw of out.split("\n")) {
    const git = /^@@\t([^\t]+)\t([^\t]*)\t([0-9a-f]*)\t(dirty)?$/.exec(raw);
    if (git) {
      live.set(git[1].replace(/\/+$/, ""), { branch: git[2], head: git[3], dirty: !!git[4] });
      continue;
    }
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const header = /^##\s+(.*)$/.exec(line);
    if (header) {
      const checkout = header[1].trim().replace(/\/+$/, "");
      repo = path.posix.basename(checkout);
      checkouts.push({ repo, path: checkout });
      continue;
    }
    const t = line.trim();
    if (!t || t === "(no workspaces)" || t.startsWith("NAME ")) continue;
    const cells = t.split(/\s{2,}/);
    if (cells.length < 4) continue;
    const [name, state, branch, ...rest] = cells;
    rows.push({ repo, name, state, branch, path: rest.join("  ") });
  }
  // The main checkout is listed even when no `cast ws root` record names it.
  for (const c of checkouts) {
    if (live.has(c.path) && !rows.some((r) => r.path.replace(/\/+$/, "") === c.path)) {
      rows.push({ repo: c.repo, name: ROOT_WORKSPACE_NAME, state: "", branch: "", path: c.path });
    }
  }
  return rows.map((r) => {
    const state = live.get(r.path.replace(/\/+$/, ""));
    return state ? { ...r, live: state } : r;
  });
}

/** Every managed worktree on the host with its live git state: one ssh round trip. */
export function readRemoteWorktrees(host: RemoteHost, timeoutMs = 60_000): RemoteWorktree[] {
  return parseRemoteWorkspaceList(ssh(host, REMOTE_WORKSPACE_LIST_SCRIPT, timeoutMs));
}

/** `feat/x@abc1234, uncommitted changes`: where a host worktree is now. */
export function worktreeGitLabel(live: WorktreeGitState): string {
  if (!live.head) return `${live.branch || "detached HEAD"}, no commits`;
  const at = cloudSeedLabel({ source: "checkout", base: live.head, branch: live.branch, dirty: false });
  return live.dirty ? `${at}, uncommitted changes` : at;
}

// --------------------------------------------------------------------------
// The report behind `ls`
// --------------------------------------------------------------------------

export interface HostSession {
  conversation_id: string;
  short_id: string;
  title: string | null;
  status: string | null;
  work_state: string | null;
  worktree_name: string | null;
  worktree_branch: string | null;
  project_path: string | null;
  /** Own worktree (isolated / null) or the host's main checkout (shared). */
  cloud_workspace: "isolated" | "shared" | null;
  /** "pending" while a laptop is still preparing the host for this row. */
  cloud_placement: string | null;
  /** The main checkout a shared row claimed (the occupancy key). */
  cloud_checkout_path: string | null;
  /** The row carries a session_error (a failed preparation frees a pending shared claim). */
  session_error: boolean;
  /** What the worktree started from (cloud.placeConversation's stamp), or null before placement / on old rows. */
  cloud_seed?: { source: "checkout" | "origin_main"; base: string; branch: string | null; dirty: boolean | null; device_id: string | null; reason: string | null } | null;
  updated_at: number | null;
}

/** The worktrees a live session still occupies. */
export function sessionWorktreeNames(sessions: HostSession[]): Set<string> {
  return new Set(sessions.map((s) => s.worktree_name).filter((n): n is string => !!n));
}

/**
 * Tag each worktree with whether a session is still in it. An untagged one is
 * an orphan: a checkout and its ports held on the box by nothing, which is the
 * thing worth seeing in a listing, because it is what quietly fills the disk.
 * The `shared-checkout` record (`cast ws root`) has no worktree name on any
 * session; it is attributed by PATH to the session whose project_path or
 * claimed checkout equals it.
 */
export function markOrphanWorktrees(
  worktrees: RemoteWorktree[],
  sessions: HostSession[],
): Array<RemoteWorktree & { hasSession: boolean }> {
  const taken = sessionWorktreeNames(sessions);
  const paths = new Set(sessions.flatMap((s) => [s.project_path, s.cloud_checkout_path]).filter((p): p is string => !!p));
  return worktrees.map((w) => ({ ...w, hasSession: taken.has(w.name) || (!!w.path && paths.has(w.path)) }));
}

/**
 * The listing's note for a worktree nobody sits in. The `shared-checkout`
 * record is the repo's main checkout holding ports, not a leaked worktree:
 * free, never an orphan.
 */
export function worktreeNote(w: RemoteWorktree & { hasSession: boolean }): string {
  if (w.hasSession) return "";
  return w.name === ROOT_WORKSPACE_NAME ? "main checkout, free" : "no session (orphan)";
}

export interface HostReport {
  id: string;
  provider: string;
  region: string;
  state: HostState | "unknown";
  address: string | null;
  stateError?: string;
  device: {
    id: string | null;
    label: string | null;
    online: boolean | null;
    lastSeen: number | null;
    note?: string;
  };
  sessions: HostSession[];
  sessionsError?: string;
  worktrees: Array<RemoteWorktree & { hasSession: boolean }>;
  worktreesNote?: string;
  /** Seed refs (refs/codecast/cloud/<name>) in a host checkout with no workspace state behind them. */
  danglingSeeds?: Array<{ repo: string; name: string }>;
  cost: HostCost & { instanceType: string | null; volumeGiB: number | null };
  /** The host's home-mirror stamp (~/.codecast/mirror.json), when it is awake and has one. */
  mirror?: HostMirrorStamp | null;
  mirrorNote?: string;
  /** Git push access from the host, as the registry last recorded it (no ssh). */
  git: HostGitReport;
  /** The host's last tools check (~/.codecast/host-tools.json), when it is awake and has one. */
  tools?: HostToolsReport | null;
  toolsNote?: string;
}

export interface HostGitReport {
  pubkey: string | null;
  /** null = never probed. */
  read: boolean | null;
  write: boolean | null;
  readonly?: boolean;
  origin?: string;
  checkedAt?: number;
  error?: string;
  forwardAgent: boolean;
  /** The GitHub App token path, as the last probe found it. */
  app?: { origin: string; read: boolean; write: boolean; error?: string };
  /** Which credential this host pushes with now. */
  path: HostAccessPath;
  /** Why none does, when path is "none". */
  pathReason?: string;
}

/** The registry's git facts for a host — what `ls` prints without waking it. */
export function hostGitReport(host: CloudHost): HostGitReport {
  const a = host.gitAccess;
  const app = host.gitAppAccess;
  const key = {
    read: a ? a.read : null,
    write: a ? a.write : null,
    ...(a?.readonly ? { readonly: true } : {}),
    ...(a?.error ? { error: a.error } : {}),
  };
  const { path, reason } = hostAccessPath(
    key,
    app ? { write: app.write, ...(app.error ? { error: app.error } : {}) } : undefined,
    host.forwardAgent === true,
  );
  return {
    pubkey: host.gitPubkey ?? null,
    ...key,
    ...(a?.origin ? { origin: a.origin } : {}),
    ...(a?.checkedAt ? { checkedAt: a.checkedAt } : {}),
    ...(app ? { app: { origin: app.origin, read: app.read, write: app.write, ...(app.error ? { error: app.error } : {}) } } : {}),
    forwardAgent: host.forwardAgent === true,
    path,
    ...(reason ? { pathReason: reason } : {}),
  };
}

/**
 * The `git` line of a host block: which of the four access paths is live, and
 * what to do when none is. A read-only deploy key (GitHub's default) fetches
 * fine and fails every push, so it keeps its own sentence with the fix.
 */
export function gitStatusLine(git: HostGitReport, hostId: string, now = Date.now()): string {
  const bridge = git.forwardAgent && git.path !== "agent-bridge" ? "  agent bridge on" : "";
  const age = git.checkedAt ? `, checked ${formatAgeShort(now - git.checkedAt)} ago` : "";
  if (git.path === "app-token") return `app-token: pushes ${git.app!.origin} with a codecast GitHub App token — no key needed${age}${bridge}`;
  if (git.path === "device-key") return `device-key: push access to ${git.origin}${age}${bridge}`;
  if (git.path === "agent-bridge") return `agent-bridge: pushes through your laptop's ssh agent while the bridge is up — cast hosts key ${hostId} for a standing key`;
  if (git.write === null || !git.origin) return `none: unknown until a session is placed — cast hosts key ${hostId}${bridge}`;
  if (git.readonly) return `none: read-only key for ${git.origin} — re-add it with write access: cast hosts key ${hostId}${bridge}`;
  return `none: needs access to ${git.origin}${git.pathReason ? ` (${git.pathReason})` : ""} — cast hosts key ${hostId}${bridge}`;
}

/** Why `cast hosts forward-agent` must refuse to enable the bridge, or null. */
export function forwardAgentRefusal(host: CloudHost): string | null {
  if ((host.watchdogVersion ?? 0) >= AGENT_BRIDGE_MIN_WATCHDOG) return null;
  return `run \`cast hosts provision ${host.id}\` first so the idle watchdog ignores the bridge (its watchdog is version ${host.watchdogVersion ?? 1}, the bridge needs ${AGENT_BRIDGE_MIN_WATCHDOG})`;
}

export const AGENT_BRIDGE_SECURITY_NOTE =
  "while the bridge is up, every key in your laptop's ssh-agent is usable by any process on the host — an agent session included. Turn it off when the work is done: cast hosts forward-agent <id> --off";

export const GH_NOT_LOGGED_IN_MESSAGE = "gh is not logged in — run `gh auth login` first, or add the key by hand at the URL above";

export const KEY_ALREADY_IN_USE_MESSAGE =
  "this key is already registered on GitHub (another repo's deploy key or an account key) — remove it there, or add it as an account key at " +
  `${ACCOUNT_KEY_URL} (broad access: every repo you can reach)`;

/**
 * `gh repo deploy-key add` for the host's key, with write access, after
 * `gh auth status` says gh can act at all (its own login error names the
 * API call, not the precondition). GitHub registers a public key ONCE across
 * deploy keys and account keys, so the second repo's add fails with "key is
 * already in use" — reported as such instead of as a raw API error, with the
 * choice the human has to make.
 */
export function grantDeployKey(
  pubkey: string,
  origin: string,
  hostId: string,
  gh = "gh",
): { ok: boolean; alreadyInUse?: boolean; error?: string } {
  const repo = githubRepo(origin);
  if (!repo) return { ok: false, error: `${origin} is not a GitHub repository; add the key by hand` };
  const auth = spawnSync(gh, ["auth", "status"], { encoding: "utf-8", stdio: "pipe", timeout: 60_000, env: process.env });
  if (auth.error) return { ok: false, error: (auth.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh is not installed" : auth.error.message };
  if (auth.status !== 0) return { ok: false, error: GH_NOT_LOGGED_IN_MESSAGE };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-deploy-key-"));
  const file = path.join(dir, "key.pub");
  try {
    fs.writeFileSync(file, `${pubkey}\n`, { mode: 0o600 });
    const r = spawnSync(gh, ["repo", "deploy-key", "add", file, "--allow-write", "--title", `codecast-${hostId}`, "-R", repo],
      { encoding: "utf-8", stdio: "pipe", timeout: 60_000, env: process.env });
    if (r.error) return { ok: false, error: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "gh is not installed" : r.error.message };
    if (r.status === 0) return { ok: true };
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    if (/already in use/i.test(err)) return { ok: false, alreadyInUse: true, error: KEY_ALREADY_IN_USE_MESSAGE };
    return { ok: false, error: err.trim().split("\n").filter(Boolean).pop() ?? `gh exited ${r.status}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface HostMirrorStamp {
  hash: string;
  applied_at: string;
  files: number;
  source_device_id: string;
  complete?: boolean;
}

/** The host's ~/.codecast/mirror.json as the verify command returned it, or null when it has none. */
export function parseHostMirrorStamp(out: string): HostMirrorStamp | null {
  const line = out.trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || typeof parsed.hash !== "string") return null;
    return {
      hash: parsed.hash,
      applied_at: typeof parsed.applied_at === "string" ? parsed.applied_at : "",
      files: parsed.files && typeof parsed.files === "object" ? Object.values(parsed.files).filter((f: any) => !f?.removed).length : 0,
      source_device_id: typeof parsed.source_device_id === "string" ? parsed.source_device_id : "",
      ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The `config mirror` line of a host block: never, or "<age> ago (hash8,
 * N files)", with a suffix when another laptop owns the host's config.
 */
export function mirrorStatusLine(
  mirror: HostMirrorStamp | null | undefined,
  localDeviceId: string,
  now = Date.now(),
  note?: string,
): string {
  if (note) return `unknown (${note})`;
  if (!mirror) return "never — cast hosts sync";
  const at = Date.parse(mirror.applied_at);
  const age = Number.isFinite(at) ? `${formatAgeShort(now - at)} ago` : "at an unknown time";
  const owner = mirror.source_device_id && mirror.source_device_id !== localDeviceId
    ? "  (owned by another device — cast hosts sync --take-over)"
    : "";
  if (mirror.complete !== true || !mirror.hash) return `${mirror.complete === false ? "incomplete or drifted" : "unverified"} — cast hosts sync${owner}`;
  return `verified on disk; applied ${age} (${mirror.hash.slice(0, 8)}, ${mirror.files} file${mirror.files === 1 ? "" : "s"})${owner}`;
}

/**
 * The short reason something failed, for a line that has to fit next to a
 * field name. A failed `execFileSync` puts the entire command it ran into its
 * message — for an ssh call that is a hundred characters of flags before the
 * first word of the actual problem — so the child's own stderr is preferred.
 */
export function briefError(err: unknown, max = 140): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = String(e.stderr ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  const text = stderr || (e.message ?? "failed").split("\n")[0] || "failed";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Run something that talks to another system; hand back its failure as text. */
async function guard<T>(fn: () => Promise<T> | T): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: briefError(err) };
  }
}

type Convex = { client: any; token: string; api: any } | null;

/** One Convex client for the whole listing, or null when we cannot get one. */
async function openConvex(): Promise<{ convex: Convex; error?: string }> {
  const { value, error } = await guard(async () => (await import("../remote/cli.js")).convexClient());
  return { convex: value ?? null, error };
}

async function collectHostReport(host: CloudHost, convex: Convex, convexError?: string): Promise<HostReport> {
  // One AWS round trip for state, address and the bill — each of those calls
  // costs tens of seconds on a slow route, so `ls` asks once.
  const facts = await guard(() => inspectHost(host));
  const live = facts.value?.state === "running";
  const address = facts.value?.address ?? (live ? host.address ?? null : null);
  // The host with its address as of RIGHT NOW: a booted instance gets a new
  // one, and the registry's copy is only trustworthy until it next sleeps.
  const current: CloudHost = { ...host, address: address ?? undefined };

  // The device id: from the registry when we already know it, else learned
  // over SSH — which only works while the box is up.
  let deviceId = host.deviceId ?? null;
  let deviceNote: string | undefined;
  if (!deviceId) {
    if (!live) deviceNote = "device id unknown until it wakes";
    else {
      const learned = await guard(async () => {
        const { learnHostDeviceId } = await import("../cloud/prepare.js");
        return learnHostDeviceId(current, toRemoteHost(current));
      });
      deviceId = learned.value ?? null;
      if (!deviceId) deviceNote = learned.error ? `unknown (${learned.error})` : "no codecast daemon answered";
    }
  }

  // What the device is doing, and what is running on it — both from Convex,
  // so one unusable client explains both fields with the same reason.
  let deviceLabel: string | null = null;
  let deviceOnline: boolean | null = null;
  let deviceLastSeen: number | null = null;
  let sessions: HostSession[] = [];
  let sessionsError: string | undefined;
  if (deviceId && !convex) {
    deviceNote = `unknown (${convexError ?? "no convex client"})`;
    sessionsError = convexError ?? "no convex client";
  } else if (deviceId && convex) {
    const devices = await guard(() =>
      convex.client.query(convex.api.devices.listDevices, { api_token: convex.token }),
    );
    const row = (devices.value ?? []).find((d: any) => d.device_id === deviceId);
    if (row) {
      deviceLabel = row.label ?? null;
      deviceOnline = !!row.online;
      deviceLastSeen = row.last_seen ?? null;
    } else deviceNote = devices.error ? `unknown (${devices.error})` : "not in this account's device list";

    const rows = await guard(() =>
      convex.client.query(convex.api.cloud.hostSessions, { api_token: convex.token, device_id: deviceId }),
    );
    sessions = (rows.value ?? []) as HostSession[];
    sessionsError = rows.error;
  }

  let worktrees: Array<RemoteWorktree & { hasSession: boolean }> = [];
  let worktreesNote: string | undefined;
  let danglingSeeds: Array<{ repo: string; name: string }> = [];
  if (live && address) {
    const listed = await guard(() => readRemoteWorktrees(toRemoteHost(current)));
    if (listed.error) worktreesNote = `unknown (${listed.error})`;
    worktrees = markOrphanWorktrees(listed.value ?? [], sessions);
    // Seed refs left behind by a failed acquire or a worktree removed by
    // hand: nothing frees them but `git update-ref -d`, so they are listed.
    const seeds = await guard(() => parseDanglingSeeds(ssh(toRemoteHost(current), REMOTE_DANGLING_SEEDS_SCRIPT, 60_000)));
    danglingSeeds = seeds.value ?? [];
  } else {
    // Asleep, so the host cannot be asked. Its sessions still remember which
    // worktree they were in, which is a partial answer and is labelled as one:
    // a worktree with no session left cannot appear here at all.
    worktrees = [...sessionWorktreeNames(sessions)].map((name) => ({
      repo: "", name, state: "", branch: "", path: "", hasSession: true,
    }));
    worktreesNote = worktrees.length
      ? "asleep — these are only the ones its sessions name"
      : "asleep, and no session names one — wake it to list them";
  }

  let mirror: HostMirrorStamp | null | undefined;
  let mirrorNote: string | undefined;
  let tools: HostToolsReport | null | undefined;
  let toolsNote: string | undefined;
  if (live && address) {
    // The mirror stamp comes back verified against the disk (mirror/push.ts).
    const { readRemoteMirrorStamp } = await import("../cloud/mirror/push.js");
    const stamp = await guard(async () => parseHostMirrorStamp(JSON.stringify(await readRemoteMirrorStamp(toRemoteHost(current), 5_000, undefined, undefined, true))));
    if (stamp.error) mirrorNote = stamp.error;
    else mirror = stamp.value ?? null;
    // A short cap: a hung sshd must not stall the whole listing. One ssh for
    // both stamps, split on a marker line.
    const stamps = await guard(() => ssh(toRemoteHost(current), "cat ~/.codecast/host-tools.json 2>/dev/null; echo; echo __CAST_MCP__; cat ~/.codecast/host-mcp-overrides.json 2>/dev/null", 5_000));
    if (stamps.error) toolsNote = stamps.error;
    else {
      const [toolsOut, mcpOut] = (stamps.value ?? "").split("__CAST_MCP__\n");
      tools = parseHostToolsStamp(toolsOut ?? "");
      // The MCP manifest rides beside the tools stamp: the summary line names the pinned servers.
      if (tools && (mcpOut ?? "").trim()) tools.mcpOverrides = parseHostMcpOverrides(mcpOut!);
    }
  } else {
    mirrorNote = "asleep";
    toolsNote = "asleep";
  }

  const cost = facts.error
    ? { hourlyUsd: null, diskMonthlyUsd: null, line: `unknown (${facts.error})` }
    : estimateHostCost({
        instanceType: facts.value?.instanceType,
        volumeGiB: facts.value?.volumeGiB,
        state: facts.value?.state ?? "unknown",
      });

  return {
    id: host.id,
    provider: host.provider,
    region: host.region,
    state: facts.value?.state ?? "unknown",
    address,
    ...(facts.error ? { stateError: facts.error } : {}),
    device: { id: deviceId, label: deviceLabel, online: deviceOnline, lastSeen: deviceLastSeen, ...(deviceNote ? { note: deviceNote } : {}) },
    sessions,
    ...(sessionsError ? { sessionsError } : {}),
    worktrees,
    ...(worktreesNote ? { worktreesNote } : {}),
    ...(danglingSeeds.length ? { danglingSeeds } : {}),
    ...(mirror !== undefined ? { mirror } : {}),
    ...(mirrorNote ? { mirrorNote } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolsNote ? { toolsNote } : {}),
    git: hostGitReport(host),
    cost: {
      ...cost,
      instanceType: facts.value?.instanceType ?? null,
      volumeGiB: facts.value?.volumeGiB ?? null,
    },
  };
}

/** Where a session runs, for the `ls` line: its worktree, or `<repo> (shared[, pending])` for the main checkout. */
export function sessionWhere(s: HostSession): string {
  if (s.worktree_name) return s.worktree_name;
  const repo = s.cloud_checkout_path ?? s.project_path;
  const base = repo ? path.basename(repo) : "";
  if (s.cloud_workspace === "shared") return `${base} (shared${s.cloud_placement === "pending" ? ", pending" : ""})`;
  return base;
}

/** `feat/x@abc1234+` for a checkout seed, `origin/main@abc1234` for an origin seed, empty without one. */
export function sessionSeed(s: HostSession): string {
  return s.cloud_seed ? cloudSeedLabel(s.cloud_seed) : "";
}

export function sessionLine(s: HostSession): string {
  const where = sessionWhere(s);
  const seed = sessionSeed(s);
  const title = (s.title ?? "").trim() || (s.project_path ? path.basename(s.project_path) : "(untitled)");
  const work = s.work_state ?? s.status ?? "";
  return `${fmt.id(s.short_id.padEnd(8))} ${fmt.muted(`${where}${seed ? `  ${seed}` : ""}`.padEnd(30))} ${title.slice(0, 44).padEnd(44)} ${fmt.muted(work)}`;
}

/** The daemon on the box: which device it is, and whether it is answering. */
function deviceText(dev: HostReport["device"]): string {
  if (!dev.id) return fmt.muted(dev.note ?? "unknown");
  const health =
    dev.online === null ? fmt.muted("daemon state unknown")
    : dev.online ? fmt.success("online")
    : fmt.muted(`offline, last seen ${dev.lastSeen ? `${formatAgeShort(Date.now() - dev.lastSeen)} ago` : "never"}`);
  const label = dev.label ?? "(unlabelled)";
  return `${label} — ${health}  ${fmt.muted(dev.id)}${dev.note ? `  ${fmt.muted(dev.note)}` : ""}`;
}

/** The `tools` line of a host block: the last check's summary, or why there is none. */
export function toolsStatusLine(tools: HostToolsReport | null | undefined, note?: string): string {
  if (note) return `unknown (${note})`;
  if (!tools) return "never checked — cast hosts tools";
  return `${summarizeHostTools(tools)}${tools.at ? `, checked ${tools.at}` : ""}`;
}

/** The per-source lines `cast hosts wake` / `sync-auth` print for the logins push. */
export function loginsReportLines(r: AgentLoginsReport | undefined): string[] {
  if (!r) return ["agent logins: not pushed"];
  const lines: string[] = [];
  lines.push(r.pushed ? `agent logins: pushed ${r.shipped || "nothing"}` : `agent logins: not pushed${r.reason ? ` (${r.reason})` : ""}`);
  lines.push(`claude credential: ${r.claude.pushed ? "pushed" : `not pushed (${r.claude.reason ?? "unknown"})`}`);
  for (const k of r.kept) lines.push(`kept on the host: ${k}`);
  for (const sk of r.skipped) lines.push(`skipped ${sk.id}: ${sk.reason}`);
  return lines;
}

function printHostReport(r: HostReport, opts: { verbose?: boolean } = {}): void {
  const mark =
    r.state === "running" ? fmt.success("awake")
    : r.state === "stopped" ? fmt.muted("asleep")
    : r.state === "unknown" ? fmt.warning(`unknown (${r.stateError ?? "no answer"})`)
    : fmt.warning(r.state);
  console.log(`${fmt.highlight(r.id)}  ${fmt.muted(`${r.provider} · ${r.region}`)}`);
  console.log(`  state      ${mark}${r.address ? `  ${r.address}` : ""}`);

  console.log(`  device     ${deviceText(r.device)}`);

  if (r.sessionsError) console.log(`  sessions   ${fmt.muted(`unknown (${r.sessionsError})`)}`);
  else if (!r.sessions.length) console.log(`  sessions   ${fmt.muted("none")}`);
  else {
    console.log(`  sessions   ${r.sessions.length}`);
    for (const s of r.sessions) console.log(`    ${sessionLine(s)}`);
  }

  const wtNote = r.worktreesNote ? fmt.muted(r.worktreesNote) : r.worktrees.length ? "" : fmt.muted("none");
  console.log(`  worktrees  ${wtNote}`.trimEnd());
  for (const w of r.worktrees) {
    const note = worktreeNote(w);
    const orphan = !note ? "" : w.name === ROOT_WORKSPACE_NAME ? fmt.muted(`  ${note}`) : fmt.warning(`  ${note}`);
    const started = w.live && w.branch && w.branch !== w.live.branch ? fmt.muted(`started on ${w.branch}`) : "";
    const cols = [w.repo, w.name, w.state, w.live ? worktreeGitLabel(w.live) : w.branch, started].filter(Boolean);
    console.log(`    ${cols.join("  ")}${orphan}`);
  }
  for (const d of r.danglingSeeds ?? []) console.log(`    ${d.repo}  ${d.name}${fmt.warning("  seed ref only (orphan)")}`);

  const mirror = mirrorStatusLine(r.mirror, deviceId(), Date.now(), r.mirrorNote);
  console.log(`  config mirror  ${mirror.startsWith("never") || mirror.startsWith("unknown") ? fmt.muted(mirror) : mirror}`);
  const gitLine = gitStatusLine(r.git, r.id);
  console.log(`  git        ${r.git.write ? gitLine : r.git.write === null ? fmt.muted(gitLine) : fmt.warning(gitLine)}`);
  const toolsLine = toolsStatusLine(r.tools, r.toolsNote);
  const toolsBad = !!r.tools && (r.tools.missing.length > 0 || r.tools.unsupported.length > 0);
  console.log(`  tools      ${!r.tools ? fmt.muted(toolsLine) : toolsBad ? fmt.warning(toolsLine) : toolsLine}`);
  if (opts.verbose && r.tools) for (const l of hostToolsDetailLines(r.tools)) console.log(`    ${fmt.muted(l)}`);
  console.log(`  cost       ${r.cost.line}`);
}

// --------------------------------------------------------------------------
// The command group
// --------------------------------------------------------------------------

/** The registered host an id names, or the default Linux one. */
function pick(id: string | undefined, what: string): CloudHost {
  const rows = readHosts();
  const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
  if (!h) die(id ? `no host ${id}` : what, "`cast hosts add <instance-id> --key <pem>` first");
  return h;
}

/** Remember what the host git setup found, so `ls` can say it without ssh. */
function recordGitState(hostId: string, state: HostGitState): void {
  const { origin, read, write, readonly, error } = state.access;
  const app = state.app;
  patchHost(hostId, {
    gitPubkey: state.pubkey ?? undefined,
    ...(origin ? { gitAccess: { origin, read, write, ...(readonly ? { readonly } : {}), checkedAt: state.checkedAt, ...(error ? { error } : {}) } } : {}),
    ...(app
      ? { gitAppAccess: { origin: app.origin, read: app.read, write: app.write, checkedAt: state.checkedAt, ...(app.error ? { error: app.error } : {}) } }
      : {}),
  });
}

/**
 * What `cast hosts key` prints: the key, where to add it (a single-repo
 * deploy key with WRITE access first; the account key labelled for what it
 * is), and what the probe found. A denied probe on a key the registry says
 * grants another repo names the one-key-one-repo rule, because that is the
 * choice the person has to make.
 */
export function keyReportLines(host: CloudHost, state: HostGitState, origin: string, opts: { check?: boolean } = {}): string[] {
  const lines: string[] = [];
  const a = state.access;
  // A live App token makes the key optional, so say that first and do not
  // print a key for anyone to paste.
  if (state.app?.write) {
    lines.push(`${OK} ${host.id} pushes ${state.app.origin} with a codecast GitHub App token — no key to add`);
    lines.push(`  ${fmt.muted(`the device key is the fallback for repositories the App does not cover: cast hosts key ${host.id} --check prints it`)}`);
  }
  if (a.write) lines.push(`${OK} ${host.id} has push access to ${origin}`);
  else if (a.readonly) lines.push(`${fmt.warning(icons.cross)} ${host.id}'s key is read-only for ${origin} — delete it on GitHub and re-add it with write access`);
  else if (a.read) lines.push(`${fmt.warning(icons.cross)} ${host.id} can read ${origin} but not push (${a.error ?? "push refused"})`);
  else lines.push(`${fmt.warning(icons.cross)} ${host.id} has no access to ${origin} yet${a.error ? ` (${a.error})` : ""}`);
  const prior = host.gitAccess;
  // Compared with the PROBED origin: an https request is recorded as its ssh form.
  if (!a.write && prior?.write && prior.origin !== (a.origin || origin)) {
    lines.push(`  ${fmt.muted(`this key already grants ${prior.origin}; one deploy key attaches to one repo — use an account key for several, or a second host`)}`);
  }
  if (a.origin && a.origin !== origin) lines.push(`  ${fmt.muted(`probed as ${a.origin} — the host's key works over ssh only; its checkout's origin is set to that form`)}`);
  lines.push(`  ${fmt.muted(`identity: ${state.identity}${state.identity === "placeholder" ? " (no laptop identity to mirror — pass --git-identity \"Name <email>\")" : ""}`)}`);
  if (opts.check || a.write || state.app?.write || !state.pubkey) return lines;
  lines.push("");
  lines.push(state.pubkey);
  const deploy = deployKeyUrl(origin);
  if (deploy) lines.push(`Recommended: add it as a deploy key with WRITE access (one repo): ${fmt.highlight(deploy)}`);
  else lines.push(`Add it wherever ${origin} takes keys, with write access`);
  lines.push(fmt.muted(`Account-level key (broad: every repo you can reach): ${ACCOUNT_KEY_URL}`));
  if (deploy) lines.push(fmt.muted(`or: cast hosts key ${host.id} --grant   (uses gh, adds it with write access)`));
  return lines;
}

function printKeyReport(host: CloudHost, state: HostGitState, origin: string, opts: { check?: boolean }): void {
  for (const l of keyReportLines(host, state, origin, opts)) console.log(l);
}

/**
 * Attach the whole group to a parent command. `cast hosts` and
 * `cast browser hosts` both call this, so neither can drift from the other.
 */
export function buildHostsCommand(parent: Command): Command {
  const hosts = parent.command("hosts").description(commandGroup("hosts").description);
  registerHostKeepaliveCommand(hosts);

  hosts
    .command("ls", { isDefault: true })
    .description("List remote hosts: state, device, sessions, worktrees and cost")
    .option("--json", "Machine-readable report")
    .option("--verbose", "Also list what the last tools check found missing or unsupported on each host")
    .action(async (o: { json?: boolean; verbose?: boolean }) => {
      const rows = readHosts();
      if (!rows.length) {
        if (o.json) console.log("[]");
        else console.log(fmt.muted("no remote hosts registered — `cast hosts add --help`"));
        return;
      }
      // Each AWS call has been measured at tens of seconds on a slow route, so
      // say what is happening. stderr keeps a piped `ls` clean.
      if (!o.json) console.error(fmt.muted(`reading ${rows.length} host${rows.length === 1 ? "" : "s"}…`));
      const { convex, error } = await openConvex();
      const reports: HostReport[] = [];
      for (const h of rows) reports.push(await collectHostReport(h, convex, error));
      if (o.json) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      for (const r of reports) {
        printHostReport(r, { verbose: o.verbose });
        console.log("");
      }
      console.log(
        fmt.muted(
          "  A Linux host sleeps when idle and then costs only its disk, about a dollar a month.\n" +
            "  An Apple silicon Mac cannot sleep — Apple's licence sets a 24-hour minimum lease, so it\n" +
            "  bills continuously (~EUR75/month) until deleted. Use one only for work that needs macOS.",
        ),
      );
    });

  hosts
    .command("add <instanceId>")
    .description("Register an existing EC2 instance as a host")
    .requiredOption("--key <path>", "SSH private key for it")
    .option("--region <name>", "AWS region", "us-west-2")
    .option("--user <name>", "SSH user for the image", "ubuntu")
    .action((instanceId: string, o: { key: string; region: string; user: string }) => {
      const host: CloudHost = {
        id: instanceId, provider: "aws", region: o.region, user: o.user,
        keyPath: path.resolve(o.key),
      };
      const s = hostState(host);
      if (s.state === "missing") die(`${instanceId} was not found in ${o.region}`);
      upsertHost({ ...host, address: s.address });
      console.log(`${OK} registered ${instanceId} (${s.state})`);
    });

  hosts
    .command("provision [id]")
    .description("Set up a Linux host as a full remote service: display, live stream, idle auto-stop, codecast daemon")
    .option("--idle <minutes>", "Auto-stop after this many idle minutes (0 disables)", "20")
    .option("--no-daemon", "Skip the codecast daemon (browser + stream only; sessions cannot move there)")
    .option("--git-identity <identity>", 'The identity commits on the host carry ("Name <email>"); default: this laptop\'s git config')
    .action(async (id: string | undefined, o: { idle: string; daemon: boolean; gitIdentity?: string }) => {
      const h = pick(id, "no linux host registered");
      const idle = parseInt(o.idle, 10);
      const { provisionLinuxHost, IDLE_WATCHDOG_VERSION } = await import("../browser/provisionLinux.js");
      console.log(`provisioning ${h.id} (${h.region})…`);
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      try {
        const report = await provisionLinuxHost(toRemoteHost(up), { idleStopMinutes: idle, skipDaemon: !o.daemon, gitIdentity: o.gitIdentity }, (m) =>
          console.log(fmt.muted(`  ${m}`)),
        );
        patchHost(up.id, { idleStopMinutes: idle, watchdogVersion: IDLE_WATCHDOG_VERSION });
        console.log(`${OK} ${h.id} is a full remote service`);
        console.log(`  chrome:   ${report.chrome.trim()}`);
        console.log(`  cast:     ${report.cast.trim()}`);
        console.log(`  claude:   ${report.claude.trim()}`);
        console.log(`  services: ${report.services.trim()}`);
        console.log(`  daemon:   ${report.device.trim()}`);
        console.log(`  git key:  ${report.git.trim()}`);
        console.log(`  agents:   ${report.agents.trim()}`);
        console.log(`  tools:    ${report.tools.trim()}`);
        console.log(fmt.muted(`  idle auto-stop: ${idle ? `${idle}m` : "disabled"} — it powers itself off and costs only its disk`));
        console.log(fmt.muted(`  watch it: cast hosts view`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("update [id]")
    .description("Put the CLI built from this checkout on a host, check it runs there, then restart its daemon onto it")
    .option("--no-restart", "Install and check the new bundle, but leave the running daemon alone")
    .option("--force", "Restart even when that would end the sessions in the daemon's own tmux server")
    .action(async (id: string | undefined, o: { restart: boolean; force?: boolean }) => {
      const h = pick(id, "no linux host registered");
      const { installLinuxCast, restartHostDaemon, IDLE_WATCHDOG_VERSION } = await import("../browser/provisionLinux.js");
      console.log(`updating ${h.id} (${h.region})…`);
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const remote = toRemoteHost(up);
      try {
        const { version } = installLinuxCast(remote, (m) => console.log(fmt.muted(`  ${m}`)));
        console.log(`${OK} cast ${version} is installed on ${h.id} and runs there`);
        if (!o.restart) console.log(fmt.muted("  the running daemon is untouched; `cast hosts update` without --no-restart moves it over"));
        else {
          const { pid } = restartHostDaemon(remote, { force: o.force });
          console.log(`${OK} daemon restarted onto ${version} (pid ${pid})`);
        }
      } catch (err) {
        die((err as Error).message);
      }
      // The bundle is not the whole host: the idle watchdog and its probe are
      // written by provisioning, so an update leaves them where they were.
      if ((up.watchdogVersion ?? 0) < IDLE_WATCHDOG_VERSION) {
        console.log(fmt.muted(`  its idle watchdog is older than this build's (v${up.watchdogVersion ?? "unknown"} < v${IDLE_WATCHDOG_VERSION}); \`cast hosts provision\` brings that over`));
      }
    });

  hosts
    .command("wake [id]")
    .description("Start a sleeping host and wait until it accepts connections")
    .action(async (id: string | undefined) => {
      const h = pick(id, "no linux host registered");
      try {
        const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
        console.log(`${OK} ${up.id} is awake at ${fmt.highlight(up.address ?? "(no address)")}`);
        const { learnHostDeviceId, readyHostHome, remoteRepoPath } = await import("../cloud/prepare.js");
        const hostDevice = await learnHostDeviceId(up, toRemoteHost(up));
        console.log(
          hostDevice
            ? `  device: ${fmt.muted(hostDevice)}`
            : fmt.muted("  no codecast daemon answered — `cast hosts provision` if sessions should run there"),
        );
        // The host-home steps; step 1 pushes the agent logins, so a wake
        // from here refreshes them without the daemon (which never sees this
        // path). Skipped on a box with no daemon: nothing to log in to yet.
        const localGitRoot = cwdGitRoot();
        const home = await readyHostHome(toRemoteHost(up), {
          cloudId: up.id, localGitRoot, repoPath: localGitRoot ? remoteRepoPath(toRemoteHost(up), localGitRoot) : undefined,
          onProgress: (m) => console.log(fmt.muted(`  ${m}`)), skipLogins: !hostDevice,
        });
        for (const l of loginsReportLines(home.logins)) console.log(`  ${l}`);
        if (home.tools) console.log(`  tools: ${summarizeHostTools(home.tools)}`);
      } catch (err) {
        die((err as Error).message);
      }
    });

  // The operator's manual repair and the e2e check for the agent-auth push.
  hosts
    .command("sync-auth [id]", { hidden: true })
    .description("Push this laptop's agent logins (codex, grok, gemini, opencode, pi + settings.json provider keys) to a host now")
    .option("--json", "Machine-readable outcome")
    .action(async (id: string | undefined, o: { json?: boolean }) => {
      const h = pick(id, "no host registered");
      const say = (m: string) => { if (!o.json) console.log(fmt.muted(`  ${m}`)); };
      try {
        const { learnHostDeviceId, pushAgentLoginsNow } = await import("../cloud/prepare.js");
        const up = await ensureUp(h, say);
        const remote = toRemoteHost(up);
        await learnHostDeviceId(up, remote);
        const r = pushAgentLoginsNow(remote, { localGitRoot: cwdGitRoot(), onProgress: say });
        if (o.json) { console.log(JSON.stringify({ host: up.id, ...r }, null, 2)); return; }
        for (const l of loginsReportLines(r)) console.log(`${l.startsWith("agent logins: pushed") ? OK : l.startsWith("agent logins") ? fmt.warning(icons.cross) : " "} ${l}`);
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("tools [id]")
    .description("Check (and install, user-locally) the runtimes and tools the repo here and your mirrored hooks/skills need on a host")
    .option("--check", "Report only; install nothing")
    .option("--json", "Machine-readable report")
    .action(async (id: string | undefined, o: { check?: boolean; json?: boolean }) => {
      const h = pick(id, "no host registered");
      const say = (m: string) => { if (!o.json) console.log(fmt.muted(`  ${m}`)); };
      try {
        const { toolsForPrepare } = await import("../cloud/prepare.js");
        const up = await ensureUp(h, say);
        const report = toolsForPrepare(toRemoteHost(up), say, { localGitRoot: cwdGitRoot(), install: !o.check });
        if (!report) die("the host did not answer the tools check");
        if (o.json) { console.log(JSON.stringify({ host: up.id, ...report }, null, 2)); return; }
        const bad = report.missing.length > 0 || report.unsupported.length > 0;
        console.log(`${bad ? fmt.warning(icons.cross) : OK} ${up.id}  tools: ${summarizeHostTools(report)}`);
        for (const t of [...report.ok, ...report.installed]) console.log(`  ${fmt.muted(`${report.installed.includes(t) ? "installed" : "ok"} ${t.tool}${t.version ? ` ${t.version}` : ""}`)}`);
        for (const m of report.mcp ?? []) if (m.status === "ok") console.log(`  ${fmt.muted(`mcp ${m.harness}/${m.name} ok (${m.command})`)}`);
        for (const l of hostToolsDetailLines(report).filter((l) => !l.startsWith("installed"))) console.log(`  ${fmt.warning(l)}`);
        if (report.mcpOverridesWritten) console.log(fmt.muted("  ~/.codecast/host-mcp-overrides.json rewritten on the host — the next mirror push applies it"));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("key [id]")
    .description("The host's git device key: print it, check what it can reach, or grant it on GitHub with gh")
    .option("--repo <origin>", "The origin to probe/grant (default: this directory's `git remote get-url origin`)")
    .option("--check", "Probe read/write access only; print nothing to paste")
    .option("--grant", "Add it as a deploy key with write access through `gh` (checks `gh auth status` first)")
    .option("--git-identity <identity>", 'The identity commits on the host carry ("Name <email>"); default: this laptop\'s git config')
    .action(async (id: string | undefined, o: { repo?: string; check?: boolean; grant?: boolean; gitIdentity?: string }) => {
      const h = pick(id, "no linux host registered");
      const localGitRoot = cwdGitRoot();
      const origin = o.repo ?? repoOrigin(localGitRoot);
      if (!origin) die("no repository here to probe against", "run it inside a repo, or pass --repo <origin>");
      const say = (m: string) => console.log(fmt.muted(`  ${m}`));
      try {
        const { ensureHostGitReady } = await import("../cloud/hostGit.js");
        const { learnHostDeviceId, remoteRepoPath } = await import("../cloud/prepare.js");
        const up = await ensureUp(h, say);
        const remote = toRemoteHost(up);
        await learnHostDeviceId(up, remote);
        const probe = () => ensureHostGitReady(remote, {
          localGitRoot,
          origin,
          repoPath: localGitRoot ? remoteRepoPath(remote, localGitRoot) : undefined,
          gitIdentity: o.gitIdentity,
          identitiesOnly: readHosts().find((r) => r.id === h.id)?.gitAccess?.write === true,
          keyComment: h.id,
          onProgress: say,
        });
        let state = probe();
        recordGitState(h.id, state);
        if (!state.pubkey) die("the host minted no key", "ssh-keygen is missing there — `cast hosts provision` installs the base packages");
        if (o.grant && !state.access.write) {
          const r = grantDeployKey(state.pubkey, origin, h.id);
          if (r.ok) {
            say("deploy key added with write access — re-probing");
            state = probe();
            recordGitState(h.id, state);
          } else {
            console.log(`${fmt.warning(icons.cross)} ${r.error}`);
          }
        }
        printKeyReport(h, state, origin, { check: o.check });
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("forward-agent <id>")
    .description("Forward this laptop's ssh-agent to the host over one held connection (opt-in; the host can then use every key in it)")
    .option("--off", "Stop forwarding; the daemon closes the bridge within a minute")
    .action((id: string, o: { off?: boolean }) => {
      const h = pick(id, "no host registered");
      if (o.off) {
        patchHost(h.id, { forwardAgent: false });
        console.log(`${OK} agent bridge to ${h.id} is off — the daemon closes it within a minute`);
        return;
      }
      const refusal = forwardAgentRefusal(h);
      if (refusal) die(`cannot enable the agent bridge to ${h.id}`, refusal);
      if (!process.env.SSH_AUTH_SOCK) console.log(fmt.warning("  this shell has no SSH_AUTH_SOCK; the daemon forwards its own agent, if it has one"));
      patchHost(h.id, { forwardAgent: true });
      console.log(`${OK} agent bridge to ${h.id} is on — the daemon opens it within a minute while the host is awake`);
      console.log(fmt.warning(`  ${AGENT_BRIDGE_SECURITY_NOTE}`));
    });

  hosts
    .command("sync [id]")
    .description("Mirror this laptop's instruction files and agent config (~/.claude, ~/.codex, …) to a host, or to every reachable one")
    .option("--dry-run", "Show what would ship — files, kinds, what was skipped or scrubbed — without pushing")
    .option("--json", "Machine-readable output")
    .option("--bundle-out <file>", "Also write the bundle to this file (0600)")
    .option("--take-over", "Take ownership of a host another laptop last mirrored")
    .action(async (id: string | undefined, o: { dryRun?: boolean; json?: boolean; bundleOut?: string; takeOver?: boolean }) => {
      const { buildHomeMirror, mirrorHomeToHost, writeBundleFile } = await import("../cloud/mirror/push.js");
      const { isCloudMirrorEnabled } = await import("../config/types.js");
      const { listScalewayHosts, remoteHome } = await import("../remote/session-move.js");
      const { readProjectRegistrations } = await import("../cloud/mirror/projectRefresh.js");
      const { listCloudRemoteHosts, sshReachable } = await import("../browser/cloudHost.js");
      const config = (await import("../config/readLocalConfig.js")).readLocalConfig();
      if (!isCloudMirrorEnabled(config) && !o.dryRun) {
        die("the home mirror is off", "`cast config cloud_mirror_enabled true` to turn it on");
      }
      const previewHost = id ? pick(id, "no host registered") : readHosts().find((r) => r.provider === "aws");
      const previewHome = previewHost ? remoteHome(toRemoteHost(previewHost)) : "/home/ubuntu";
      let preview;
      try {
        preview = await buildHomeMirror({ config, hostHome: previewHome, takeOver: o.takeOver, projects: previewHost ? readProjectRegistrations(toRemoteHost(previewHost), undefined, previewHost.id) : [] });
      } catch (err) {
        die((err as Error).message);
      }
      if (o.bundleOut) {
        writeBundleFile(path.resolve(o.bundleOut), preview.bytes);
        if (!o.json) console.log(fmt.muted(`  bundle written to ${o.bundleOut}`));
      }
      const s = preview.summary;
      if (o.dryRun) {
        if (o.json) {
          console.log(JSON.stringify({ hash: preview.hash, target_home: previewHome, ...s }, null, 2));
          return;
        }
        console.log(`${fmt.highlight("home mirror")}  ${fmt.muted(`${s.files.length} files, ${(s.totalBytes / 1024).toFixed(0)} KiB, ${preview.hash.slice(0, 8)} → ${previewHome}`)}`);
        for (const f of s.files) console.log(`  ${f.path.padEnd(56)} ${fmt.muted(`${f.kind.padEnd(16)} ${f.mode} ${String(f.size).padStart(8)}`)}`);
        if (s.skipped.length) {
          console.log(`  ${fmt.warning("skipped")}`);
          for (const k of s.skipped) console.log(`    ${k.path}  ${fmt.muted(k.reason)}`);
        }
        if (s.scrubbed.length) {
          console.log(`  ${fmt.warning("scrubbed")}`);
          for (const k of s.scrubbed) console.log(`    ${k}`);
        }
        if (s.excludesApplied.length) console.log(`  ${fmt.muted(`excludes applied: ${s.excludesApplied.join(", ")}`)}`);
        for (const warning of s.warnings) console.log(`  ${fmt.warning(`compatibility: ${warning}`)}`);
        console.log(`  git identity: ${s.gitIdentity.email ? `${s.gitIdentity.name ?? ""} <${s.gitIdentity.email}>`.trim() + fmt.muted(" (shipped by the host git setup, not the mirror)") : fmt.muted("none found")}`);
        if (!isCloudMirrorEnabled(config)) console.log(fmt.muted("  (the mirror is off: cloud_mirror_enabled=false)"));
        return;
      }
      const results: Array<{ host: string; outcome: string; ok: boolean }> = [];
      const say = (m: string) => { if (!o.json) console.log(fmt.muted(`  ${m}`)); };
      if (id) {
        const h = pick(id, "no host registered");
        const up = await ensureUp(h, say);
        const r = await mirrorHomeToHost(toRemoteHost(up), { onProgress: say, force: true, takeOver: o.takeOver, config }).catch((err) => ({ pushed: false, reason: (err as Error).message, changed: 0, skipped: undefined, result: undefined, hash: undefined }));
        results.push({ host: up.id, outcome: describeOutcome(r), ok: r.pushed || r.skipped === "in step" });
      } else {
        const candidates = [...listScalewayHosts(), ...listCloudRemoteHosts()];
        const probes = await Promise.all(candidates.map((h) => sshReachable(h)));
        const reachable = candidates.filter((_, i) => probes[i]);
        if (!reachable.length) {
          if (o.json) { console.log("[]"); return; }
          die("no host is reachable right now", "`cast hosts sync <id>` wakes one; a sleeping host gets the mirror on its next wake");
        }
        for (const h of reachable) {
          const r = await mirrorHomeToHost(h, { onProgress: say, force: true, takeOver: o.takeOver, config }).catch((err) => ({ pushed: false, reason: (err as Error).message, changed: 0, skipped: undefined, result: undefined, hash: undefined }));
          results.push({ host: `${h.user}@${h.address}`, outcome: describeOutcome(r), ok: r.pushed || r.skipped === "in step" });
        }
      }
      if (o.json) { console.log(JSON.stringify(results, null, 2)); return; }
      for (const r of results) console.log(`${r.ok ? OK : fmt.warning(icons.cross)} ${r.host}  ${r.outcome}`);
    });

  hosts
    .command("view [id]")
    .description("Live view of the host's screen — VLC (RTSP) or any browser (HLS), over an SSH tunnel")
    .option("--vlc", "Open it in VLC")
    .action(async (id: string | undefined, o: { vlc?: boolean }) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureViewTunnel } = await import("../browser/liveView.js");
      try {
        const v = await ensureViewTunnel(toRemoteHost(up));
        console.log(`${OK} live view is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  VLC:     ${fmt.highlight(v.rtsp)}`);
        console.log(`  browser: ${fmt.highlight(v.hls)}`);
        console.log(fmt.muted("  the stream only encodes while someone is watching; closing the player stops it"));
        if (o.vlc) {
          try {
            execFileSync("open", ["-a", "VLC", v.rtsp], { stdio: "ignore", timeout: 10_000 });
            console.log(`${OK} opened in VLC`);
          } catch {
            console.log(fmt.warning("  VLC is not installed — `brew install --cask vlc`, or open the browser URL"));
          }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("vnc [id]")
    .description("Interactive view of the host's whole screen (noVNC in your browser) — for anything outside the agent's tab")
    .option("--no-open", "Print the URL without opening it")
    .action(async (id: string | undefined, o: { open: boolean }) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureVncTunnel } = await import("../browser/liveView.js");
      try {
        const v = await ensureVncTunnel(toRemoteHost(up));
        console.log(`${OK} VNC is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  ${fmt.highlight(v.url)}`);
        console.log(fmt.muted("  the whole display, with mouse and keyboard — for a page's own sign-in, prefer the CONTROL button in the session's browser view"));
        if (o.open) {
          try { execFileSync("open", [v.url], { stdio: "ignore", timeout: 10_000 }); } catch { /* headless shell */ }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("shot [id]")
    .description("One screenshot of the host's screen, saved locally")
    .action(async (id: string | undefined) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { machineShot } = await import("../browser/liveView.js");
      try {
        console.log(machineShot(toRemoteHost(up)));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("sleep [id]")
    .description("Stop a host so it stops costing money")
    .action((id: string | undefined) => {
      const h = pick(id, "no stoppable host registered");
      try {
        stopHost(h);
        console.log(`${OK} ${h.id} is stopping — it will cost only its disk until something wakes it`);
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("rm <id>")
    .description("Forget a host — the registry entry only, the instance is untouched")
    .option("--force", "Remove it even while it is awake")
    .action((id: string, o: { force?: boolean }) => {
      const rows = readHosts();
      const h = rows.find((r) => r.id === id);
      if (!h) die(`no host ${id} is registered`, "`cast hosts ls` to see what is");
      if (!o.force) {
        let state: HostState | null = null;
        try { state = hostState(h).state; } catch { /* unreadable: let the removal through */ }
        if (state === "running") {
          die(
            `${id} is awake — removing it now would leave it running and billing with nothing tracking it`,
            "put it to sleep first (`cast hosts sleep`), or pass --force",
          );
        }
      }
      writeHosts(rows.filter((r) => r.id !== id));
      console.log(`${OK} forgot ${id} — the machine itself still exists; delete it at the provider if you meant that`);
    });

  return hosts;
}

function describeOutcome(r: { pushed: boolean; changed?: number; hash?: string; reason?: string; skipped?: string; result?: { host_edited: string[]; pruned: string[]; errors: unknown[] } | undefined }): string {
  if (r.pushed) {
    const extra = [
      r.result?.host_edited.length ? `${r.result.host_edited.length} host-edited kept` : "",
      r.result?.pruned.length ? `${r.result.pruned.length} pruned` : "",
      r.result?.errors.length ? `${r.result.errors.length} error(s)` : "",
    ].filter(Boolean).join(", ");
    return `mirrored ${r.changed ?? 0} changed file(s) (${(r.hash ?? "").slice(0, 8)})${extra ? ` — ${extra}` : ""}`;
  }
  if (r.skipped === "in step") return `in step (${(r.hash ?? "").slice(0, 8)})`;
  return `incomplete: ${r.reason ?? "mirror did not finish"}`;
}

/** Mount the group at the top level as `cast hosts`. */
export function registerHostsCommand(program: Command): Command {
  return buildHostsCommand(program);
}
