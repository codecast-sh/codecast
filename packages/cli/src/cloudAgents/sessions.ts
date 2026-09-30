/**
 * The daemon's side of a cloud agent session: which conversations run on a
 * provider's cloud agent, and the start / deliver / interrupt operations on
 * them.
 *
 * A cloud agent cannot exist without a prompt, so `start` only records the
 * conversation (repo, branch, model) and the first delivered message creates
 * the agent; every later message is a follow-up. The transcript comes back
 * through the provider's CloudAgentWatcher.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import { promisify } from "util";
import { cloudAgentLaunch, cloudAgentRootId, isCloudAgentId } from "@codecast/shared/contracts";
import { atomicWriteFile } from "../atomicWrite.js";
import { splitPatches } from "../repoMirror.js";
import { codecastPath } from "../codecastDir.js";
import { CloudApiError } from "./http.js";
import { git, githubOriginAt, gitRaw, porcelainEntries, repoRootFor } from "../gitPlane.js";
import { deviceLabel } from "../remote/device.js";
import { CloudAgentBusyError, CloudAgentSetupError, errorText, logTag, type AnyCloudAgentAdapter, type CloudAgentApplyPlan } from "./types.js";
import type { CloudAgentWatcher } from "./watcher.js";

const execFileAsync = promisify(execFile);

export interface CloudAgentSession {
  /** The provider's agent id, once the first message created it. */
  agentId?: string;
  projectPath?: string;
  repoUrl?: string;
  startingRef?: string;
  /** Provider model id; "" = the account's default. */
  model: string;
  /** Launch options the provider offers (CloudAgentProviderSpec.launchOptions): answer without changing code, and how many attempts to make. */
  ask?: boolean;
  attempts?: number;
  /** What the agent starts from when that differs from the checkout (see githubRepoAt). */
  notice?: string;
}

export interface CloudAgentSessionsDeps {
  /** The provider's mirror, once it runs: told to mirror an agent codecast just moved. */
  watcher: () => Pick<CloudAgentWatcher, "follow" | "setNotice" | "isRunning"> | null;
  /** Map the agent id to the conversation, locally and on the server. */
  bindSession: (conversationId: string, agentId: string, projectPath: string | undefined, repoUrl: string | undefined) => void;
  /** The agent id the conversation is already mapped to, from the session cache. */
  agentForConversation: (conversationId: string) => string | undefined;
  setStatus: (conversationId: string, status: "connected" | "working" | "idle" | "stopped") => void;
  log: (msg: string) => void;
}

export class CloudAgentSessions {
  private sessions: Record<string, CloudAgentSession> = {};
  private readonly file: string;
  private readonly tag: string;

  constructor(readonly adapter: AnyCloudAgentAdapter, private readonly deps: CloudAgentSessionsDeps, file = codecastPath(adapter.spec.mirrorDir, "sessions.json")) {
    this.file = file;
    this.tag = logTag(adapter);
    try { this.sessions = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  }

  private save(): void {
    try {
      atomicWriteFile(this.file, JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
    } catch (err) {
      this.deps.log(`${this.tag} could not save sessions: ${errorText(err)}`);
    }
  }

  /** Whether codecast started this agent. */
  ownsAgent(agentId: string): boolean {
    return Object.values(this.sessions).some((s) => s.agentId === agentId);
  }

  /** Whether codecast started (or was bound to) any agent. */
  ownsAnyAgent(): boolean {
    return Object.values(this.sessions).some((s) => !!s.agentId);
  }

  /** The conversation's cloud session: one codecast started, or a mirrored agent it was bound to. */
  get(conversationId: string): CloudAgentSession | undefined {
    const known = this.sessions[conversationId];
    if (known) return known;
    const agentId = this.deps.agentForConversation(conversationId);
    if (!agentId || !isCloudAgentId(this.adapter.spec, agentId)) return undefined;
    const adopted: CloudAgentSession = { agentId, model: "" };
    this.sessions[conversationId] = adopted;
    this.save();
    return adopted;
  }

  /** Record a conversation that runs on this provider. `modelKey` is the launch key (`cloud`, `cloud:<id>`, `cloud:ask+x2`). */
  async start(conversationId: string, projectPath: string | undefined, modelKey: string): Promise<void> {
    const { model, ask, attempts } = cloudAgentLaunch(this.adapter.spec.agentType, modelKey) ?? { model: "", ask: false, attempts: 1 };
    const session: CloudAgentSession = { ...this.sessions[conversationId], projectPath, model, ...(ask ? { ask } : {}), ...(attempts > 1 ? { attempts } : {}) };
    await readRepo(session);
    this.sessions[conversationId] = session;
    this.save();
    this.deps.log(`${this.tag} conversation ${conversationId.slice(0, 12)} runs on ${this.adapter.spec.label} (${session.repoUrl ? `${session.repoUrl}${session.startingRef ? `@${session.startingRef}` : ""}` : "no repo"}, model ${model || "default"}${ask ? ", ask" : ""}${attempts > 1 ? `, ${attempts} attempts` : ""})`);
    this.deps.setStatus(conversationId, "connected");
  }

  /**
   * Send a message: the first creates the agent, later ones are follow-ups.
   * Resolves false when the conversation is not one of this provider's.
   */
  async deliver(conversationId: string, content: string): Promise<boolean> {
    const session = this.get(conversationId);
    if (!session) return false;
    const client = this.adapter.client();
    if (client instanceof CloudAgentSetupError) throw client;
    const watcher = this.deps.watcher();
    if (!session.agentId) {
      // Read again on every try: a message held for a missing remote or an unpushed branch goes out once it is fixed.
      await readRepo(session);
      let created: { agentId: string; url?: string };
      try {
        created = await this.adapter.create(client, session, content);
      } catch (err) {
        throw setupErrorOf(this.adapter, err, session) ?? err;
      }
      session.agentId = created.agentId;
      this.save();
      if (session.notice) watcher?.setNotice(created.agentId, session.notice);
      this.deps.bindSession(conversationId, created.agentId, session.projectPath, session.repoUrl);
      this.deps.log(`${this.tag} created agent ${created.agentId} for conversation ${conversationId.slice(0, 12)} (${created.url ?? ""})`);
    } else {
      // Last seen running: busy without asking the provider (each retry of a held message would be a read).
      if (watcher?.isRunning(session.agentId)) throw new CloudAgentBusyError(this.adapter.spec.label);
      try {
        await this.adapter.followUp(client, session.agentId, content);
      } catch (err) {
        if (!(err instanceof CloudAgentBusyError)) throw setupErrorOf(this.adapter, err, session) ?? err;
        // A turn started elsewhere (the provider's site): the mirror follows it, so the next retries are answered above.
        void watcher?.follow(session.agentId);
        throw err;
      }
    }
    this.deps.setStatus(conversationId, "working");
    void watcher?.follow(session.agentId!);
    return true;
  }

  /**
   * The folder codecast started this agent's work in (a branch shares its
   * task's), when it is a checkout of `repo`: the session stays there, and
   * Apply runs there, rather than in whichever checkout of the repository
   * this machine finds first.
   */
  async startedIn(agentId: string, repo: { owner: string; name: string }): Promise<string | null> {
    const root = cloudAgentRootId(agentId);
    const dir = Object.values(this.sessions).find((s) => s.projectPath && s.agentId && cloudAgentRootId(s.agentId) === root)?.projectPath;
    if (!dir) return null;
    return (await githubOriginAt(dir))?.toLowerCase() === `https://github.com/${repo.owner}/${repo.name}`.toLowerCase() ? dir : null;
  }

  /** Cancel the agent's running turn. Resolves false when there is none (or no cloud session). */
  async interrupt(conversationId: string): Promise<boolean> {
    const session = this.get(conversationId);
    const client = session?.agentId ? this.adapter.client() : null;
    if (!session?.agentId || !client || client instanceof CloudAgentSetupError) return false;
    const cancelled = await this.adapter.cancel(client, session.agentId);
    if (!cancelled) return false;
    this.deps.log(`${this.tag} cancelled ${cancelled} of ${session.agentId}`);
    void this.deps.watcher()?.follow(session.agentId);
    return true;
  }
}

/**
 * The setup problem an API error names: the adapter's vendor-specific cases
 * first, then the rule every provider shares (credentials the provider
 * refused). Null for anything else.
 */
export function setupErrorOf(adapter: AnyCloudAgentAdapter, err: unknown, session?: CloudAgentSession): CloudAgentSetupError | null {
  const specific = adapter.setupErrorOf?.(err, session);
  if (specific) return specific;
  return err instanceof CloudApiError && err.keyRejected ? CloudAgentSetupError.credentialsRejected(adapter, err.message) : null;
}

/** The session's repository, starting branch and notice, as its checkout is now. */
async function readRepo(session: CloudAgentSession): Promise<void> {
  if (!session.projectPath) return;
  const repo = await githubRepoAt(session.projectPath);
  session.repoUrl = repo?.repoUrl;
  session.startingRef = repo?.startingRef;
  session.notice = repo?.notice;
}

/**
 * The GitHub repo and pushed branch a checkout is on, or null when it has no
 * GitHub remote. A cloud agent clones the remote, so it starts from the local
 * branch only if that branch is on GitHub, else from the default branch; and
 * it never sees commits that are not pushed. `notice` says so when either
 * applies.
 */
export async function githubRepoAt(dir: string): Promise<{ repoUrl: string; startingRef?: string; notice?: string } | null> {
  const repoUrl = await githubOriginAt(dir);
  if (!repoUrl) return null;
  let branch: string | undefined;
  try { branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch {}
  if (!branch || branch === "HEAD") return { repoUrl };
  let onRemote: boolean;
  try {
    onRemote = !!(await git(dir, ["ls-remote", "--heads", "origin", branch]));
  } catch {
    return { repoUrl, notice: `Started from the repository's default branch: GitHub did not answer whether \`${branch}\` is there.` };
  }
  if (!onRemote) return { repoUrl, notice: `Started from the repository's default branch: \`${branch}\` is not on GitHub yet. Push it to start the agent from it.` };
  let ahead = 0;
  try { ahead = parseInt(await git(dir, ["rev-list", "--count", `origin/${branch}..HEAD`]), 10) || 0; } catch {}
  return {
    repoUrl,
    startingRef: branch,
    ...(ahead > 0 ? { notice: `Started from \`${branch}\` on GitHub. ${ahead} local commit${ahead === 1 ? " is" : "s are"} not pushed, so the agent can't see ${ahead === 1 ? "it" : "them"}.` } : {}),
  };
}

/**
 * Apply an agent's diff (CloudAgentAdapter.applyPlan) to a local checkout, at
 * its root whatever folder inside it `dir` is (the diff's paths are the
 * repository's), with `git apply`: left in the working tree, not staged or
 * committed. Refused when there is no checkout, or when it has local changes
 * to a file the diff touches. Resolves the root it applied to and the files it
 * changed; a failure throws git's own words.
 */
export async function applyInCheckout(plan: CloudAgentApplyPlan, dir: string | null): Promise<{ root: string; files: string[] }> {
  if (!dir) throw new Error(`${deviceLabel()} has no checkout of ${plan.repo}: clone it there, then apply again`);
  const root = await repoRootFor(dir);
  if (!root) throw new Error(`${dir} is not a git checkout of ${plan.repo}`);
  const files = [...splitPatches(plan.diff).keys()];
  const dirty = files.length ? porcelainEntries(await gitRaw(root, ["status", "--porcelain", "-z", "--", ...files])).map((e) => e.path) : [];
  if (dirty.length) {
    throw new Error(`${root} has local changes to ${dirty.length === 1 ? "a file" : `${dirty.length} files`} these changes touch (${dirty.slice(0, 5).join(", ")}): commit or stash them, then apply again`);
  }
  try {
    const run = execFileAsync("git", ["-C", root, "apply", "--whitespace=nowarn", "-"], { timeout: 120_000 });
    run.child.stdin?.end(plan.diff.endsWith("\n") ? plan.diff : `${plan.diff}\n`);
    await run;
    return { root, files };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const said = (e.stderr ?? "").trim();
    throw new Error(said ? said.split("\n").slice(-6).join("\n") : errorText(err));
  }
}
