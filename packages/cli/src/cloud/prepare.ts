/**
 * Preparing the cloud host for a session: wake it, put the repo there, copy
 * the manifest's secret files, and acquire an isolated worktree ON the host.
 *
 * One function, `prepareCloudHost`, is shared by every way a session can land
 * on the box — `cast spawn --cloud`, `cast fork --cloud`, `--subagent --cloud`
 * and the web's "run in the cloud" (which a local daemon serves through
 * `cast cloud start`). Nothing here touches Convex: the transfer uses the
 * same SSH transport as `cast remote move`. Placement (the Convex
 * side) is `cloud.placeConversation`, called by the entry points after this.
 *
 * The worktree is acquired by the HOST's own `cast ws acquire`, from the same
 * `.codecast/workspace.toml`, so install runs there and ports are probed on
 * the machine that will bind them — several spawns in one command get
 * distinct worktrees and non-colliding ports because the host allocates them.
 * A SHARED session (`--shared`, the composer's toggle) runs in the main
 * checkout instead: claimed in Convex first (cloud.claimSharedCheckout), then
 * `refreshCloudCheckout({ moveHead: true })` + `acquireRemoteRootCheckout`
 * (a fresh `codecast/cloud-<hex>` branch from origin/main and the host's
 * `cast ws root` for ports/install). Everything else is fetch-only.
 *
 * Before the checkout is touched, `readyHostHome` brings the host's HOME up
 * to date: the agent logins and the tools they need (remote/agentAuth.ts,
 * cloud/hostTools.ts), the host git setup (cloud/hostGit.ts) and the home
 * mirror (cloud/mirror), which ships this laptop's instruction files and
 * agent config there, stamp-gated so an in-step host costs no ssh.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  ensureUp,
  patchHost,
  readHosts,
  resolveCloudHost,
  toRemoteHost,
  type CloudHost,
} from "../browser/cloudHost.js";
import { readLocalConfig } from "../config/readLocalConfig.js";
import { isCloudMirrorEnabled, type Config } from "../config/types.js";
import {
  assertNoLaptopPaths,
  collectAgentAuthBundle,
  describeBundle,
  laptopHome,
  type AgentAuthBundle,
} from "../remote/agentAuth.js";
import { deviceId as localDeviceId } from "../remote/device.js";
import {
  copyAgentAuthToRemote,
  copyCredentialToRemote,
  remoteHome,
  remoteRepoPath,
  shq,
  ssh,
  sshBase,
  type AgentAuthPushOutcome,
  type CredentialPushOutcome,
  type RemoteHost,
} from "../remote/session-move.js";
import { ensureHostGitReady, noPushReason, parseOrigin, type HostGitState } from "./hostGit.js";
import { requiredHostTools, runHostTools, summarizeHostTools, type HostToolsReport } from "./hostTools.js";
import { readProjectRegistrations } from "./mirror/projectRefresh.js";
import {
  cloudCopyFiles,
  cloudSeedRef,
  CloudSeedUnavailable,
  dropLaptopSeed,
  finishSeededWorktree,
  planLaptopSeed,
  pushLaptopSeed,
  refreshRemoteCheckout,
  stageCloudInputs,
  type CloudSeed,
} from "./transfer.js";
import { ROOT_WORKSPACE_NAME } from "../workspace/lifecycle.js";
import { sharedCheckoutOccupant, type CheckoutOccupantRow, type CloudStartFrom, type CloudWorkspaceMode } from "@codecast/shared/contracts";
export { refreshRemoteCheckout, type CloudSeed } from "./transfer.js";
export type { HostGitState } from "./hostGit.js";
export type { CloudStartFrom } from "@codecast/shared/contracts";
export type { CloudWorkspaceMode } from "@codecast/shared/contracts";
export { ROOT_WORKSPACE_NAME } from "../workspace/lifecycle.js";

/** The alive session holding the host's main checkout (cloud.hostSessions row). */
export interface RootOccupant {
  conversation_id: string;
  short_id: string;
  title: string | null;
}

export interface PreparedHost {
  cloud: CloudHost;
  host: RemoteHost;
  /** The codecast device id of the daemon on the box. */
  deviceId: string;
  /** The repo's main checkout on the box; worktrees hang under it. */
  repoPath: string;
  /** The laptop's MAIN repo (its basename names the host repo; origin is read here). */
  repoRoot: string;
  /** The laptop worktree the user is in: the seed snapshot AND the manifest inputs come from it. */
  seedCwd: string;
  /** What the host git setup found: device key, access to the origin, identity. */
  git?: HostGitState;
  /** origin/main's commit on the host after refreshCloudCheckout (unset until then). */
  mainHead?: string;
  /** The registry address before the wake, so the mirror's project registrations follow an address change. */
  previousAddress?: string;
}

/**
 * The two laptop roots a cloud prepare needs, from any cwd inside a repo. In
 * a linked worktree `--show-toplevel` is the worktree itself (the tree to
 * seed and stage from) while the main repo — whose basename names the host
 * checkout and whose origin is refreshed — is the parent of the common dir.
 * That holds only when the common dir is a `.git` directory: a submodule's
 * lives under `<super>/.git/modules/<name>`, so there the toplevel is the
 * repo. Outside a repo both are the cwd (the manifest preflight then decides).
 */
export function resolveSeedRoots(cwd: string): { seedCwd: string; repoRoot: string } {
  const out = (args: string[]): string | undefined => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" });
    return r.error || r.status !== 0 ? undefined : r.stdout.trim() || undefined;
  };
  const seedCwd = out(["rev-parse", "--show-toplevel"]);
  if (!seedCwd) return { seedCwd: cwd, repoRoot: cwd };
  const common = out(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { seedCwd, repoRoot: common && path.basename(common) === ".git" ? path.dirname(common) : seedCwd };
}

/** `--from checkout|origin-main` (either spelling) to the wire value; garbage throws. */
export function parseStartFrom(value: string | null | undefined): CloudStartFrom {
  if (value === undefined || value === null || value === "" || value === "checkout") return "checkout";
  if (value === "origin-main" || value === "origin_main") return "origin_main";
  throw new Error(`--from takes checkout or origin-main, not ${JSON.stringify(value)}`);
}

/** Two origins name the same repository (host + path, ignoring scheme, user, `.git`, trailing slash). */
export function sameGitOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  const pa = parseOrigin(a), pb = parseOrigin(b);
  if (pa && pb) return pa.host === pb.host && pa.repo.replace(/\/+$/, "") === pb.repo.replace(/\/+$/, "");
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export interface RemoteWorkspace {
  name: string;
  path: string;
  branch: string;
  ports: Record<string, number>;
  created: boolean;
}

type Progress = (message: string) => void;

export { remoteRepoPath } from "../remote/session-move.js";

/** The box's codecast device id, read from its own `cast remote hosts` line. */
export function readHostDeviceId(host: RemoteHost): string | undefined {
  try {
    const line = ssh(host, "cast remote hosts 2>/dev/null | head -1", 60_000);
    return /\(([0-9a-f-]{8,})\)/.exec(line)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The device id for a host, from the registry when already learned, else
 * over SSH — and then remembered, so the daemon can map a wake request (which
 * names a device) back to the instance it must boot.
 */
export async function learnHostDeviceId(cloud: CloudHost, host: RemoteHost): Promise<string | undefined> {
  if (cloud.deviceId) return cloud.deviceId;
  const deviceId = readHostDeviceId(host);
  if (deviceId) patchHost(cloud.id, { deviceId });
  return deviceId;
}

export interface MirrorForPrepareOptions {
  /** Push even when the local stamp says the host is in step (provisioning). */
  force?: boolean;
  config?: Config | null;
  /** The laptop repo being prepared, so `includeIf gitdir:` git config resolves. */
  localGitRoot?: string;
  /** Injection for tests: the push itself. */
  mirror?: typeof import("./mirror/push.js").mirrorHomeToHost;
}

/**
 * The home mirror step of readyHostHome: ship this laptop's instruction
 * files and agent config to the host, stamp-gated. A refused or failed
 * initial mirror throws (the session must not start on a host whose agent
 * config is missing or stale); the outcome is also reported through the
 * caller's progress log. Returns a one-line summary.
 */
export async function mirrorForPrepare(
  host: RemoteHost,
  cloudId: string,
  log: Progress,
  opts: MirrorForPrepareOptions = {},
): Promise<string> {
  const config = opts.config === undefined ? readLocalConfig() : opts.config;
  if (!isCloudMirrorEnabled(config)) return "config mirror disabled";
  try {
    const mirror = opts.mirror ?? (await import("./mirror/push.js")).mirrorHomeToHost;
    const r = await mirror(host, { onProgress: log, force: opts.force, config, localGitRoot: opts.localGitRoot });
    let line: string;
    if (r.result?.errors.length || r.result?.host_edited.length) throw new Error([
      ...r.result.errors.map((e) => `${e.path}: ${e.error}`),
      ...r.result.host_edited.map((p) => `${p}: remote edit conflict`),
    ].join("; "));
    if (r.skipped === "in step") line = `config mirror in step (${(r.hash ?? "").slice(0, 8)})`;
    else if (r.pushed) {
      const extra = [
        r.result?.host_edited.length ? `${r.result.host_edited.length} host-edited kept` : "",
        r.result?.pruned.length ? `${r.result.pruned.length} pruned` : "",
        r.result?.errors.length ? `${r.result.errors.length} error(s)` : "",
      ].filter(Boolean).join(", ");
      line = `mirrored ${r.changed} changed config file(s) (${(r.hash ?? "").slice(0, 8)})${extra ? ` — ${extra}` : ""}`;
    } else {
      const hint = r.reason === "unprovisioned" ? ` — cast hosts provision ${cloudId}`
        : r.reason === "other_device" ? " — cast hosts sync --take-over to take it over"
        : r.reason === "other_home" ? " — the bundle was built for a different home directory than the host's"
        : r.reason?.startsWith("host cast older") ? ` ${cloudId}` : "";
      throw new Error(`${r.reason ?? "incomplete mirror"}${hint}`);
    }
    log(line);
    return line;
  } catch (err) {
    const line = `config mirror failed: ${err instanceof Error ? err.message : String(err)}`;
    log(line);
    throw new Error(line);
  }
}

/**
 * The mirror's project hook, once a target exists on the host: record the
 * laptop repo to host root mapping (mirror/projectRefresh) and push the
 * project context there. A no-op while the config mirror is off.
 */
async function mirrorProjectContext(
  host: RemoteHost,
  localGitRoot: string,
  targetRoot: string,
  log: Progress,
  opts: { cloudId?: string; previousAddress?: string } = {},
): Promise<void> {
  if (!isCloudMirrorEnabled(readLocalConfig())) return;
  const { registerProjectContext } = await import("./mirror/projectRefresh.js");
  await registerProjectContext(host, localGitRoot, targetRoot, { hostId: opts.cloudId, previousAddress: opts.previousAddress });
  await mirrorForPrepare(host, opts.cloudId ?? host.address, log, { localGitRoot });
}

// ---------------------------------------------------------------------------
// Step 1: agent logins (remote/agentAuth.ts) and the tools they need
// ---------------------------------------------------------------------------

export interface AgentLoginsSources {
  home: string;
  now: number;
  userId: string;
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The bundle a prepare pushes for a host + laptop repo: every gated login,
 * the settings.json provider keys, and ONE codex trust table — the repo's
 * checkout on the host (codex trusts a worktree under a trusted checkout, so
 * no per-worktree entry). Pure, so tests can pin that nothing else in it is
 * path-derived.
 */
export function agentLoginsBundleFor(host: RemoteHost, localGitRoot: string | undefined, sources: AgentLoginsSources): ReturnType<typeof collectAgentAuthBundle> {
  return collectAgentAuthBundle({
    home: sources.home,
    env: sources.env,
    now: sources.now,
    userId: sources.userId,
    deviceId: sources.deviceId,
    codexTrustPaths: localGitRoot ? [remoteRepoPath(host, localGitRoot)] : [],
  });
}

export interface AgentLoginsReport {
  /** The bundle landed (some files may still have been kept or errored). */
  pushed: boolean;
  /** Why nothing was pushed: not logged in, a refusal, a transport failure. */
  reason?: string;
  /** Sources present on the laptop whose gate refused them, with why. */
  skipped: Array<{ id: string; reason: string }>;
  /** settings.json env keys left behind, with why. */
  envSkipped: Array<{ key: string; reason: string }>;
  /** What the host kept instead of overwriting (`codex host-fresher`). */
  kept: string[];
  /** The Claude credential push that runs first. */
  claude: CredentialPushOutcome;
  /** The receiver's outcome, when the bundle was sent. */
  receiver?: AgentAuthPushOutcome;
  /** Which harnesses shipped, for a log line. */
  shipped: string;
}

export interface PushAgentLoginsOptions {
  localGitRoot?: string;
  onProgress?: Progress;
  config?: Config | null;
  /** Injection for tests. */
  deps?: Partial<{
    pushClaude: (host: RemoteHost) => CredentialPushOutcome;
    push: (host: RemoteHost, bundle: AgentAuthBundle) => AgentAuthPushOutcome;
    sources: () => Omit<AgentLoginsSources, "userId">;
  }>;
}

/**
 * Push the Claude credential and the agent auth bundle to a host, now and
 * synchronously (the prepare path, the wake commands, provisioning,
 * `cast hosts sync-auth`). Never throws: a host with the Claude login alone
 * is still useful. Every skip, kept file and refusal is logged.
 */
export function pushAgentLoginsNow(host: RemoteHost, opts: PushAgentLoginsOptions = {}): AgentLoginsReport {
  const log = opts.onProgress ?? (() => {});
  const config = opts.config === undefined ? readLocalConfig() : opts.config;
  const pushClaude = opts.deps?.pushClaude ?? copyCredentialToRemote;
  let claude: CredentialPushOutcome;
  try {
    claude = pushClaude(host);
  } catch (err) {
    claude = { pushed: false, reason: `push failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!claude.pushed) log(`claude credential not pushed: ${claude.reason} — sessions there need a healthy local login`);
  const base: Omit<AgentLoginsReport, "pushed" | "shipped"> = { skipped: [], envSkipped: [], kept: [], claude };
  if (!config?.user_id) {
    log("agent logins not pushed: not logged in on this laptop — cast login");
    return { ...base, pushed: false, reason: "not logged in on this laptop — cast login", shipped: "" };
  }
  const src = opts.deps?.sources?.() ?? { home: laptopHome(), now: Date.now(), deviceId: localDeviceId() };
  const { bundle, skipped, envSkipped } = agentLoginsBundleFor(host, opts.localGitRoot, { ...src, userId: config.user_id });
  for (const s of skipped) log(`${s.id} login not pushed: ${s.reason}${s.reason === "access token expired" || s.reason === "logged-out stub" ? ` — run ${s.id} login on this machine` : ""}`);
  if (envSkipped.length) log(`settings.json env keys left behind: ${envSkipped.map((e) => `${e.key} (${e.reason})`).join(", ")}`);
  try {
    assertNoLaptopPaths(bundle, src.home);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`agent logins not pushed: ${reason}`);
    return { ...base, skipped, envSkipped, pushed: false, reason, shipped: describeBundle(bundle) };
  }
  const shipped = describeBundle(bundle);
  let receiver: AgentAuthPushOutcome;
  try {
    receiver = (opts.deps?.push ?? copyAgentAuthToRemote)(host, bundle);
  } catch (err) {
    receiver = { pushed: false, kept: [], reason: err instanceof Error ? err.message : String(err) };
  }
  if (!receiver.pushed) {
    log(`agent logins not pushed: ${receiver.reason}`);
    return { ...base, skipped, envSkipped, pushed: false, reason: receiver.reason, receiver, shipped };
  }
  for (const k of receiver.kept) log(`${k} — the host's copy is newer; run codex login on this machine to re-own the grant`);
  for (const e of receiver.errors ?? []) log(`agent login not written on the host: ${e}`);
  if (receiver.unparseableSettings) log("the host's ~/.claude/settings.json is not valid JSON — provider keys not merged");
  log(`agent logins pushed: ${shipped}${receiver.env?.length ? ` (env: ${receiver.env.join(", ")})` : ""}`);
  return { ...base, skipped, envSkipped, kept: receiver.kept, pushed: true, receiver, shipped };
}

export interface ToolsForPrepareOptions {
  localGitRoot?: string;
  /** Check only (a non-Linux host, `--check`). */
  install?: boolean;
  /** Injection for tests. */
  deps?: Partial<{ required: () => ReturnType<typeof requiredHostTools>; run: typeof runHostTools }>;
}

/**
 * The tools step: what the repo and the mirrored home need on the host,
 * checked and installed user-locally (cloud/hostTools.ts). Non-fatal and
 * logged: a missing tool is a readiness fact, not a lost session.
 */
export function toolsForPrepare(host: RemoteHost, log: Progress, opts: ToolsForPrepareOptions = {}): HostToolsReport | undefined {
  try {
    // The MCP roster covers the project MCP the mirror ships too, remapped to this host's roots, so a project-only pin is never cleared.
    const required = opts.deps?.required ? opts.deps.required() : requiredHostTools({ repoRoot: opts.localGitRoot, laptopHome: laptopHome(), hostHome: remoteHome(host), projects: readProjectRegistrations(host) });
    const report = (opts.deps?.run ?? runHostTools)(host, required, { install: opts.install });
    log(`host tools: ${summarizeHostTools(report)}${report.installed.length ? ` (installed ${report.installed.map((i) => i.tool).join(", ")})` : ""}`);
    for (const m of report.missing) log(`host tools: missing ${m.tool}${m.referenced_by ? ` (for ${m.referenced_by})` : ""}${m.error ? ` — ${m.error}` : ""}`);
    for (const u of report.unsupported) log(`host tools: ${u.tool} cannot run on Linux (${u.reason})`);
    // MCP: every Linux adjustment is reported, never silently applied.
    for (const m of report.mcp ?? []) if (m.status !== "ok") log(`host tools: mcp ${m.harness}/${m.name}${m.scope ? ` in ${m.scope}` : ""} (${m.command}) ${m.status}${m.reason ? ` — ${m.reason}` : ""}; ${m.action}`);
    if (report.mcpOverridesInvalid) log(`host tools: the host's ~/.codecast/host-mcp-overrides.json did not parse (${report.mcpOverridesInvalid}); treated as empty`);
    if (report.mcpOverridesWritten) log("host tools: ~/.codecast/host-mcp-overrides.json rewritten on the host");
    return report;
  } catch (err) {
    log(`host tools check skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export interface ReadyHostHomeOptions {
  localGitRoot?: string;
  repoPath?: string;
  /** The registry id, for hints in progress lines. */
  cloudId?: string;
  onProgress?: Progress;
  /** Provisioning: push everything regardless of stamps. */
  force?: boolean;
  /** `--git-identity "Name <email>"`: what the host's commits should carry. */
  gitIdentity?: string;
  /** The caller already ran ensureHostGitReady for this host (pushSession). */
  skipGit?: boolean;
  /** Leave the agent logins and tools out (tests of the other steps). */
  skipLogins?: boolean;
  /** Tools: check only, install nothing. */
  toolsInstall?: boolean;
  /** Injection for tests: the logins, tools and mirror steps. */
  loginsDeps?: PushAgentLoginsOptions["deps"];
  toolsDeps?: ToolsForPrepareOptions["deps"];
  mirrorDeps?: MirrorForPrepareOptions["mirror"];
}

export interface ReadyHostHomeReport {
  mirror: string;
  /** The host git setup's result, when the step ran and the host answered. */
  git?: HostGitState;
  /** The agent logins push (step 1), when it ran. */
  logins?: AgentLoginsReport;
  /** The host tools check/install (step 1), when the host answered. */
  tools?: HostToolsReport;
}

/**
 * The host git step of readyHostHome: known_hosts, the ssh config block,
 * the device key, the mirrored identity and the read/write probe (see
 * cloud/hostGit.ts). Never throws — a host that cannot push is a host whose
 * pushes fall back to the laptop, not a lost session. Records what it found
 * in the registry (gitPubkey, gitAccess) so `cast hosts ls` can say it
 * without ssh, and names the fix when there is no push access.
 */
export function gitForPrepare(
  host: RemoteHost,
  cloudId: string,
  log: Progress,
  opts: { localGitRoot?: string; repoPath?: string; gitIdentity?: string } = {},
): HostGitState | undefined {
  const entry = readHosts().find((h) => h.id === cloudId);
  let git: HostGitState | undefined;
  try {
    git = ensureHostGitReady(host, {
      localGitRoot: opts.localGitRoot,
      repoPath: opts.repoPath,
      gitIdentity: opts.gitIdentity,
      identitiesOnly: entry?.gitAccess?.write === true,
      keyComment: cloudId,
      onProgress: log,
    });
  } catch (err) {
    log(`host git setup skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  // The App token path pushes on its own, so the key hint belongs only to a
  // host that has neither.
  if (git.access.origin && !git.access.write && !git.app?.write) {
    log(`host has no push access to ${git.access.origin} (${noPushReason(git.access)}) — cast hosts key ${cloudId}`);
  }
  if (entry) {
    const { origin, read, write, readonly, error } = git.access;
    const app = git.app;
    patchHost(cloudId, {
      gitPubkey: git.pubkey ?? undefined,
      ...(origin ? { gitAccess: { origin, read, write, ...(readonly ? { readonly } : {}), checkedAt: git.checkedAt, ...(error ? { error } : {}) } } : {}),
      ...(app
        ? { gitAppAccess: { origin: app.origin, read: app.read, write: app.write, checkedAt: git.checkedAt, ...(app.error ? { error: app.error } : {}) } }
        : {}),
    });
  }
  return git;
}

/**
 * The host-home steps every wake/prepare runs, in a fixed order, each
 * non-fatal and logged: (1) agent logins (the Claude credential, the agent
 * auth bundle with the repo checkout as codex trust path, then the tools
 * the repo and the mirrored home need), (2) host git readiness, (3) the
 * home mirror. Callers: prepareCloudHost, `cast cloud wake`,
 * `cast hosts wake`, `cast hosts sync-auth`, provisionLinuxHost (with
 * force), performMoveToRemote.
 */
export async function readyHostHome(host: RemoteHost, opts: ReadyHostHomeOptions = {}): Promise<ReadyHostHomeReport> {
  const log = opts.onProgress ?? (() => {});
  const cloudId = opts.cloudId ?? host.address;
  let logins: AgentLoginsReport | undefined;
  let tools: HostToolsReport | undefined;
  if (!opts.skipLogins) {
    try {
      logins = pushAgentLoginsNow(host, { localGitRoot: opts.localGitRoot, onProgress: log, deps: opts.loginsDeps });
    } catch (err) {
      log(`agent logins step failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    tools = toolsForPrepare(host, log, { localGitRoot: opts.localGitRoot, install: opts.toolsInstall, deps: opts.toolsDeps });
  }
  const git = opts.skipGit ? undefined : gitForPrepare(host, cloudId, log, { localGitRoot: opts.localGitRoot, repoPath: opts.repoPath, gitIdentity: opts.gitIdentity });
  const mirror = await mirrorForPrepare(host, cloudId, log, { force: opts.force, localGitRoot: opts.localGitRoot, mirror: opts.mirrorDeps });
  return { mirror, ...(git ? { git } : {}), ...(logins ? { logins } : {}), ...(tools ? { tools } : {}) };
}

/**
 * Wake the host and bring its HOME up to date, touching nothing in the
 * checkout: manifest preflight, registry lookup, ensureUp, the daemon's
 * device id, the host-home steps (readyHostHome). What a shared placement
 * runs BEFORE its Convex claim, so a refused claim has changed nothing on
 * the box.
 */
export interface PrepareCloudHostOptions {
  hostArg?: string;
  /** The laptop worktree the seed and manifest inputs come from (resolveSeedRoots). */
  seedCwd: string;
  /** The laptop's main repo (resolveSeedRoots). */
  repoRoot: string;
  /** Recorded for the seed step; the wake itself is the same either way. */
  startFrom?: CloudStartFrom;
  onProgress?: Progress;
}

export async function wakeCloudHost(opts: PrepareCloudHostOptions): Promise<PreparedHost> {
  const log = opts.onProgress ?? (() => {});
  cloudCopyFiles(opts.seedCwd);
  const cloud = resolveCloudHost(opts.hostArg);
  const up = await ensureUp(cloud, log);
  const host = toRemoteHost(up);
  const deviceId = await learnHostDeviceId(up, host);
  if (!deviceId) {
    throw new Error(`${up.id} runs no codecast daemon — provision it first: cast hosts provision ${up.id}`);
  }
  const repoPath = remoteRepoPath(host, opts.repoRoot);
  // Host-home steps BEFORE the checkout: the known_hosts pin and the device
  // key are what let the host's own clone/fetch succeed.
  const home = await readyHostHome(host, { localGitRoot: opts.repoRoot, repoPath, cloudId: up.id, onProgress: log });
  return { cloud: { ...up, deviceId }, host, deviceId, repoPath, repoRoot: opts.repoRoot, seedCwd: opts.seedCwd, previousAddress: cloud.address, ...(home.git ? { git: home.git } : {}) };
}

/**
 * Refresh the host's main checkout from origin/main (transfer.ts
 * refreshRemoteCheckout). Fetch-only unless `moveHead`, which only the shared
 * placement passes after its claim. Stamps `mainHead` on the prepared host.
 *
 * The checkout's origin url follows the credential the host git step just
 * proved: https while the GitHub App token path answers for this repository,
 * ssh otherwise.
 */
export function refreshCloudCheckout(
  prepared: PreparedHost,
  opts: { moveHead: boolean },
  onProgress: Progress = () => {},
): ReturnType<typeof refreshRemoteCheckout> {
  const r = refreshRemoteCheckout(prepared.host, prepared.repoRoot, prepared.repoPath, onProgress, {
    moveHead: opts.moveHead,
    appToken: prepared.git?.app?.write === true,
  });
  prepared.mainHead = r.head;
  return r;
}

/**
 * Everything an ISOLATED session needs before it can be placed on the host:
 * wakeCloudHost, then a fetch-only refresh — the root's HEAD is never moved
 * here, so spawn, fork and the web coexist with a live shared session.
 */
export async function prepareCloudHost(opts: PrepareCloudHostOptions): Promise<PreparedHost> {
  const log = opts.onProgress ?? (() => {});
  const prepared = await wakeCloudHost(opts);
  refreshCloudCheckout(prepared, { moveHead: false }, log);
  await mirrorProjectContext(prepared.host, opts.repoRoot, prepared.repoPath, log, { cloudId: prepared.cloud.id, previousAddress: prepared.previousAddress });
  return prepared;
}

// ---------------------------------------------------------------------------
// The seed: what a worktree on the host starts from
// ---------------------------------------------------------------------------

function checkRefFormatBranch(name: string): boolean {
  return spawnSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore" }).status === 0;
}

/**
 * The branch names the host tries for a seeded worktree: the laptop's own
 * branch first, then `<branch>-<hex>` (hex = the worktree name's suffix)
 * when the host already has that branch — decided on the host by git's
 * atomic ref creation, never by a laptop-side read. A detached laptop HEAD
 * seeds `codecast/<name>` with no alternate. Both names pass git's own
 * branch-name check here, before anything reaches the host.
 */
export function seedBranchNames(laptopBranch: string | undefined, worktreeName: string): { primary: string; alt?: string } {
  if (!laptopBranch || laptopBranch === "HEAD") {
    const primary = `codecast/${worktreeName}`;
    if (!checkRefFormatBranch(primary)) throw new Error(`invalid worktree branch name ${JSON.stringify(primary)}`);
    return { primary };
  }
  const suffix = worktreeName.includes("-") ? worktreeName.slice(worktreeName.lastIndexOf("-") + 1) : worktreeName;
  const names = { primary: laptopBranch, alt: `${laptopBranch}-${suffix}` };
  for (const n of [names.primary, names.alt]) {
    if (!checkRefFormatBranch(n)) throw new Error(`laptop branch ${JSON.stringify(laptopBranch)} is not a usable branch name for the host (${n})`);
  }
  return names;
}

const startPointSupport = new Map<string, boolean>();

/** Tests: forget what `hostSupportsStartPoint` learned. */
export function forgetHostCapabilities(): void {
  startPointSupport.clear();
}

/**
 * Does the host's `cast ws acquire` know `--start-point`? One `--help` over
 * ssh, remembered per address for the process. A host whose cast predates
 * seeded worktrees gets origin/main with a visible reason instead of an
 * opaque commander error minutes into the prepare. Only an ANSWER is cached:
 * a probe that never ran (ssh refused, timed out, cast missing) throws, so a
 * user who asked for their checkout never gets origin/main with a wrong
 * reason because the network blinked.
 */
export function hostSupportsStartPoint(host: RemoteHost): boolean {
  const cached = startPointSupport.get(host.address);
  if (cached !== undefined) return cached;
  let help: string;
  try {
    help = ssh(host, `${HOST_PATH}; cast ws acquire --help`, 60_000);
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const detail = (e.stderr?.toString() || e.message || String(err)).trim().split("\n").filter(Boolean).pop() ?? "";
    throw new Error(`cannot check whether the host's cast supports seeded worktrees${detail ? `: ${detail}` : ""}`);
  }
  const supported = help.includes("--start-point");
  startPointSupport.set(host.address, supported);
  return supported;
}

/**
 * The seed for a fan-out on a prepared host — computed ONCE (one laptop
 * snapshot) and reused for every worktree name. `origin_main` is the plain
 * origin/main worktree at the host's refreshed head. `checkout` snapshots the
 * laptop tree; it degrades to origin/main, with the reason recorded, only
 * when the checkout cannot be a seed in principle (not a repo, no commits)
 * or the host's cast predates `--start-point`. Any other failure is fatal:
 * a user who asked for their checkout must not silently get origin/main.
 */
export async function seedForHost(prepared: PreparedHost, opts: { startFrom: CloudStartFrom }): Promise<CloudSeed> {
  if (!prepared.mainHead) throw new Error("seedForHost needs a refreshed checkout (refreshCloudCheckout first)");
  const deviceId = (() => { try { return localDeviceId(); } catch { return undefined; } })();
  const originMain = (reason?: string): CloudSeed => ({ source: "origin_main", base: prepared.mainHead!, ...(deviceId ? { deviceId } : {}), ...(reason ? { reason } : {}) });
  if (opts.startFrom === "origin_main") return originMain();
  if (!hostSupportsStartPoint(prepared.host)) {
    return originMain(`host cast predates seeded worktrees — cast hosts provision ${prepared.cloud.id}`);
  }
  try {
    const seed = await planLaptopSeed(prepared.seedCwd);
    return { ...seed, ...(deviceId ? { deviceId } : {}) };
  } catch (err) {
    if (err instanceof CloudSeedUnavailable) return originMain(err.message);
    throw err;
  }
}

/**
 * The laptop's pre-flight for the host's main checkout: who holds it, by the
 * shared occupancy rule over cloud.hostSessions. `cast remote move` and
 * `cast spawn --shared` ask before any transfer; the server re-checks
 * authoritatively (claimSharedCheckout / performMoveSessionToDevice).
 */
export async function fetchRootOccupant(
  client: any,
  api: any,
  token: string,
  deviceId: string,
  repoPath: string,
  excludeId?: string,
): Promise<RootOccupant | null> {
  const rows = (await client.query(api.cloud.hostSessions, { api_token: token, device_id: deviceId })) as CheckoutOccupantRow[];
  const hit = sharedCheckoutOccupant(rows ?? [], { projectPath: repoPath, excludeId });
  return hit ? { conversation_id: hit.conversation_id, short_id: hit.short_id ?? hit.conversation_id.slice(0, 7), title: hit.title ?? null } : null;
}

/**
 * A signal guard for a CLI phase that mutates a row it must not strand: the
 * blocking ssh steps of `cast spawn --shared` run for minutes, and a Ctrl-C
 * in the middle would otherwise exit with the pending claim intact (nothing
 * times a CLI park out). Armed, a SIGINT/SIGTERM/SIGHUP only records itself;
 * the caller asks `reason()` after each step and turns it into the error it
 * stamps on the row. A second signal exits at once.
 */
export function armInterruptGuard(signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]): { reason: () => string | null; disarm: () => void } {
  let seen: string | null = null;
  const onSignal = (signal: string): void => {
    if (seen) process.exit(130);
    seen = signal;
  };
  const handlers = signals.map((signal) => {
    const h = () => onSignal(signal);
    process.on(signal, h);
    return [signal, h] as const;
  });
  return {
    reason: () => (seen ? `spawn interrupted (${seen})` : null),
    // bun-types narrows removeListener past Node's signal overloads (see
    // browser/instance.ts); the EventEmitter surface is what both implement.
    disarm: () => { for (const [signal, h] of handlers) (process as NodeJS.EventEmitter).removeListener(signal, h); },
  };
}

export interface AcquireRemoteOptions {
  onProgress?: Progress;
  /**
   * The registration barrier: awaited with the acquired target (the worktree
   * path, or the shared checkout root) as the LAST step before return, so a
   * caller can register the target with the host before anything launches
   * in it. Default: nothing.
   */
  onTargetAcquired?: (target: string) => Promise<void> | void;
  /** Shared checkout only: the laptop's main repo the mirror registers against (default: the seed cwd). */
  localGitRoot?: string;
  /** The host's cloud id and the address it had before this wake, so the mirror migrates a registration keyed by the old address. */
  cloudId?: string;
  previousAddress?: string;
}

const HOST_PATH = `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"`;

export type AcquiredRemoteWorkspace = RemoteWorkspace & { head: string; seed: CloudSeed };

/**
 * Acquire a worktree on the host with ITS `cast ws acquire --json`. Install
 * runs there (minutes on a cold node_modules), so the timeout is generous.
 *
 * The name is reserved first (stageCloudInputs). A `checkout` seed is then
 * pushed to the host's hidden ref for that name — only after the
 * reservation, so a refused name never leaves a pinned copy of the laptop's
 * uncommitted tree behind — and the worktree is created at it with
 * `--branch <laptop branch> [--alt-branch <branch>-<hex>] --start-point`,
 * then reset to the laptop HEAD (finishSeededWorktree) so the snapshot is
 * uncommitted work again. Any failure after the push drops the ref. An
 * `origin_main` seed (or none) pre-creates the branch from
 * `refs/remotes/origin/main` so the worktree's base is origin/main whatever
 * the root's HEAD is; `cast ws acquire` attaches to that branch.
 */
export async function acquireRemoteWorkspace(
  host: RemoteHost,
  repoPath: string,
  name: string,
  seedCwd: string,
  seed?: CloudSeed,
  opts: AcquireRemoteOptions = {},
): Promise<AcquiredRemoteWorkspace> {
  // A checkout seed's ref name and branch names are checked here, before
  // any ssh: a name git would refuse must not reserve anything on the host.
  const names = seed?.source === "checkout" ? (cloudSeedRef(name), seedBranchNames(seed.branch, name)) : null;
  const inputRoot = stageCloudInputs(host, seedCwd, repoPath, name, { warn: opts.onProgress });
  const sshRun = (command: string) => spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, command],
    { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const acquireArgs = `--input-root ${shq(inputRoot)} --skip-pool --json`;
  const failed = (result: ReturnType<typeof sshRun>): Error => {
    const detail = (result.stderr || "").trim().split("\n").filter(Boolean).pop() ?? "";
    return new Error(`cast ws acquire ${name} failed on the host (${result.signal ?? `exit ${result.status}`})${detail ? `: ${detail}` : ""}; workspace retained for inspection`);
  };
  let ws: RemoteWorkspace;
  let effective: CloudSeed;
  if (seed?.source === "checkout" && names) {
    effective = pushLaptopSeed(host, seedCwd, repoPath, name, seed);
    try {
      const result = sshRun(`${HOST_PATH}; export CODECAST_CLOUD_WORKSPACE=1; cd ${shq(repoPath)} && cast ws acquire ${shq(name)} ${acquireArgs} --branch ${shq(names.primary)}${names.alt ? ` --alt-branch ${shq(names.alt)}` : ""} --start-point ${shq(effective.ref!)}`);
      if (result.error || result.status !== 0) throw failed(result);
      ws = parseAcquireOutput(name, result.stdout);
      finishSeededWorktree(host, ws.path, effective);
    } catch (err) {
      dropLaptopSeed(host, repoPath, name);
      throw err;
    }
  } else {
    const result = sshRun(`${HOST_PATH}; export CODECAST_CLOUD_WORKSPACE=1; cd ${shq(repoPath)} && git branch --no-track ${shq(`codecast/${name}`)} refs/remotes/origin/main 2>/dev/null || true; cast ws acquire ${shq(name)} ${acquireArgs}`);
    if (result.error || result.status !== 0) throw failed(result);
    ws = parseAcquireOutput(name, result.stdout);
    effective = seed ?? { source: "origin_main", base: originMainHead(host, repoPath) };
  }
  await mirrorProjectContext(host, seedCwd, ws.path, opts.onProgress ?? (() => {}));
  await opts.onTargetAcquired?.(ws.path);
  return { ...ws, head: effective.base, seed: effective };
}

/** origin/main's commit in the host checkout (a caller that brought no seed); a base is never empty. */
function originMainHead(host: RemoteHost, repoPath: string): string {
  const head = ssh(host, `cd ${shq(repoPath)} && git rev-parse --verify refs/remotes/origin/main^{commit}`, 60_000).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`cannot resolve origin/main in ${repoPath} on the host`);
  return head;
}

/**
 * The SHARED counterpart of acquireRemoteWorkspace, run only AFTER the Convex
 * claim: check out a fresh per-session branch from origin/main in the main
 * checkout, stage the laptop's secret files under the reserved
 * `shared-checkout` record, and run the host's `cast ws root` there (ports,
 * the secret copies overwriting the root's, install). The tracked manifest is
 * never written into the root; setup that dirties the tree fails the
 * placement naming the files, so the fix lands upstream (commit the lockfile)
 * instead of in a `git checkout -- .` that would destroy legitimate outputs.
 */
export async function acquireRemoteRootCheckout(host: RemoteHost, repoPath: string, seedCwd: string, branch: string, opts: AcquireRemoteOptions = {}): Promise<RemoteWorkspace> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..") || branch.endsWith("/")) {
    throw new Error(`invalid shared checkout branch ${JSON.stringify(branch)}`);
  }
  const q = shq(repoPath);
  const co = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
    `cd ${q} && git checkout -q -b ${shq(branch)} refs/remotes/origin/main`,
  ], { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 300_000 });
  if (co.error || co.status !== 0) {
    throw new Error(`checkout of ${branch} from origin/main failed in the host checkout (${co.signal ?? `exit ${co.status}`})`);
  }
  const inputRoot = stageCloudInputs(host, seedCwd, repoPath, ROOT_WORKSPACE_NAME, { warn: opts.onProgress, reuse: true });
  const result = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
    `${HOST_PATH}; cd ${q} && cast ws root --input-root ${shq(inputRoot)} --json`,
  ], { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    // Only commander's own refusal (or no cast at all, 127) means an old
    // host; any other failure is reported as itself, with its last line.
    if (result.status === 127 || /error: unknown command/i.test(result.stderr ?? "")) {
      throw new Error(`host cast predates shared checkouts — re-provision it: cast hosts provision ${host.address}`);
    }
    const detail = (result.stderr || "").trim().split("\n").filter(Boolean).pop() ?? "";
    throw new Error(`cast ws root failed on the host (${result.signal ?? `exit ${result.status}`})${detail ? `: ${detail}` : ""}; the checkout is on ${branch} for inspection`);
  }
  const ws = parseAcquireOutput(ROOT_WORKSPACE_NAME, result.stdout);
  // `cast ws root` prints the checkout's real path; stageCloudInputs has
  // already refused a symlink anywhere in repoPath, so the two agree unless
  // the host answered for another repo.
  if (ws.path !== repoPath) throw new Error(`cast ws root on the host reported ${ws.path}, not the checkout ${repoPath}`);
  const status = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
    `cd ${q} && git status --porcelain --untracked-files=all`,
  ], { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 300_000 });
  if (status.error || status.status !== 0) throw new Error("could not read the host checkout's status after setup");
  const dirtied = status.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (dirtied.length) {
    throw new Error(`setup left the host checkout dirty (${dirtied.slice(0, 5).join(", ")}${dirtied.length > 5 ? ", …" : ""}) — fix that upstream (e.g. commit the lockfile) or run isolated`);
  }
  const target: RemoteWorkspace = { name: ROOT_WORKSPACE_NAME, path: repoPath, branch, ports: ws.ports, created: ws.created };
  await mirrorProjectContext(host, opts.localGitRoot ?? seedCwd, target.path, opts.onProgress ?? (() => {}), { cloudId: opts.cloudId, previousAddress: opts.previousAddress });
  await opts.onTargetAcquired?.(target.path);
  return target;
}

/**
 * Drop a worktree this laptop just acquired on the host but could not place
 * (the row was re-pointed or re-parked while the ssh ran). Best-effort: the
 * host's `cast ws destroy` runs teardown, removes the worktree and its state;
 * a failure is reported, never thrown — the placement refusal is the outcome
 * the caller prints, and an orphan is cheaper than a crashed child.
 */
export function releaseRemoteWorkspace(host: RemoteHost, repoPath: string, name: string): { removed: boolean; error?: string } {
  const result = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
      `${HOST_PATH}; cd ${shq(repoPath)} && cast ws destroy ${shq(name)}`,
  ], { encoding: "utf-8", stdio: "pipe", env: process.env, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").pop() ?? "";
    return { removed: false, error: `cast ws destroy ${name} failed on the host (${result.signal ?? `exit ${result.status}`})${detail ? `: ${detail}` : ""}` };
  }
  return { removed: true };
}

/**
 * The workspace from `cast ws acquire --json` output. Install output may
 * precede the JSON line (bun prints to stdout), so the LAST line that looks
 * like JSON is the answer. A broken contract is an error, not a workspace.
 */
export function parseAcquireOutput(name: string, out: string): RemoteWorkspace {
  const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line) throw new Error(`cast ws acquire ${name} printed no JSON on the host`);
  let ws;
  try {
    ws = JSON.parse(line);
  } catch {
    throw new Error(`cast ws acquire ${name} printed invalid JSON on the host`);
  }
  if (ws.name !== name) throw new Error(`cast ws acquire ${name} returned a different workspace`);
  if (ws.state !== "ready" || ws.contract?.ok !== true || !Array.isArray(ws.contract.failures) || ws.contract.failures.length > 0) {
    throw new Error(`workspace ${name} on the host is broken: ready state and a successful contract are required`);
  }
  if (typeof ws.path !== "string" || !ws.path.startsWith("/") || ws.path === "/"
    || /[\x00-\x1f\x7f\\]/.test(ws.path) || path.posix.normalize(ws.path) !== ws.path
    || typeof ws.branch !== "string" || !ws.branch.trim() || /[\x00-\x20\x7f]/.test(ws.branch)
    || typeof ws.created !== "boolean" || !ws.ports || typeof ws.ports !== "object" || Array.isArray(ws.ports)
    || Object.values(ws.ports).some((port) => typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`cast ws acquire ${name} returned invalid workspace fields`);
  }
  return { name: ws.name, path: ws.path, branch: ws.branch, ports: ws.ports, created: ws.created };
}

/** A worktree name nobody has to think about: cloud-<6 hex>. */
export function freshWorktreeName(): string {
  return `cloud-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * The host's daemon has said hello since it booted. "Running" and "online"
 * are two clocks (the instance is up seconds before systemd starts the
 * daemon and it heartbeats), and a start routed at an offline device queues
 * in a 5-minute command TTL — so the entry points wait here first.
 */
export async function waitForDeviceOnline(
  client: any,
  api: any,
  token: string,
  deviceId: string,
  onProgress: Progress = () => {},
  timeoutMs = 150_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let said = false;
  for (;;) {
    const devices = await client.query(api.devices.listDevices, { api_token: token });
    const d = (devices as Array<{ device_id: string; online: boolean }>).find((x) => x.device_id === deviceId);
    if (d?.online) return;
    if (Date.now() > deadline) throw new Error(`the daemon on device ${deviceId.slice(0, 8)} never came online`);
    if (!said) { onProgress("waiting for the host's daemon to come online…"); said = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
