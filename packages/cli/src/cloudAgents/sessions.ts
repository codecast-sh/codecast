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
import { cloudAgentModel, isCloudAgentId } from "@codecast/shared/contracts";
import { atomicWriteFile } from "../atomicWrite.js";
import { githubRepo } from "../cloud/gitOrigin.js";
import { codecastPath } from "../codecastDir.js";
import { CloudAgentBusyError, CloudAgentSetupError, logTag, type AnyCloudAgentAdapter } from "./types.js";
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
  /** What the agent starts from when that differs from the checkout (see githubRepoAt). */
  notice?: string;
}

export interface CloudAgentSessionsDeps {
  /** The provider's mirror, once it runs: told to mirror an agent codecast just moved. */
  watcher: () => Pick<CloudAgentWatcher, "follow" | "setNotice"> | null;
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
      this.deps.log(`${this.tag} could not save sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether codecast started this agent. */
  ownsAgent(agentId: string): boolean {
    return Object.values(this.sessions).some((s) => s.agentId === agentId);
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

  /** Record a conversation that runs on this provider. `modelKey` is the launch key (`cloud`, `cloud:<id>`). */
  async start(conversationId: string, projectPath: string | undefined, modelKey: string): Promise<void> {
    const model = cloudAgentModel(this.adapter.spec.agentType, modelKey) ?? "";
    const repo = projectPath ? await githubRepoAt(projectPath) : null;
    this.sessions[conversationId] = { ...this.sessions[conversationId], projectPath, model, ...(repo ?? {}) };
    this.save();
    this.deps.log(`${this.tag} conversation ${conversationId.slice(0, 12)} runs on ${this.adapter.spec.label} (${repo ? `${repo.repoUrl}${repo.startingRef ? `@${repo.startingRef}` : ""}` : "no repo"}, model ${model || "default"})`);
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
      let created: { agentId: string; url?: string };
      try {
        created = await this.adapter.create(client, session, content);
      } catch (err) {
        throw this.adapter.setupErrorOf(err, session) ?? err;
      }
      session.agentId = created.agentId;
      this.save();
      if (session.notice) watcher?.setNotice(created.agentId, session.notice);
      this.deps.bindSession(conversationId, created.agentId, session.projectPath, session.repoUrl);
      this.deps.log(`${this.tag} created agent ${created.agentId} for conversation ${conversationId.slice(0, 12)} (${created.url ?? ""})`);
    } else {
      try {
        await this.adapter.followUp(client, session.agentId, content);
      } catch (err) {
        if (err instanceof CloudAgentBusyError) throw err;
        throw this.adapter.setupErrorOf(err, session) ?? err;
      }
    }
    this.deps.setStatus(conversationId, "working");
    void watcher?.follow(session.agentId!);
    return true;
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
 * The GitHub repo and pushed branch a checkout is on, or null when it has no
 * GitHub remote. A cloud agent clones the remote, so it starts from the local
 * branch only if that branch is on GitHub, else from the default branch; and
 * it never sees commits that are not pushed. `notice` says so when either
 * applies.
 */
export async function githubRepoAt(dir: string): Promise<{ repoUrl: string; startingRef?: string; notice?: string } | null> {
  const git = async (...args: string[]) => (await execFileAsync("git", ["-C", dir, ...args], { timeout: 15_000 })).stdout.trim();
  let remote: string;
  try { remote = await git("config", "--get", "remote.origin.url"); } catch { return null; }
  const repo = githubRepo(remote);
  if (!repo) return null;
  const repoUrl = `https://github.com/${repo}`;
  let branch: string | undefined;
  try { branch = await git("rev-parse", "--abbrev-ref", "HEAD"); } catch {}
  if (!branch || branch === "HEAD") return { repoUrl };
  let onRemote: boolean;
  try { onRemote = !!(await git("ls-remote", "--heads", "origin", branch)); } catch { return { repoUrl }; }
  if (!onRemote) return { repoUrl, notice: `Started from the repository's default branch: \`${branch}\` is not on GitHub yet. Push it to start the agent from it.` };
  let ahead = 0;
  try { ahead = parseInt(await git("rev-list", "--count", `origin/${branch}..HEAD`), 10) || 0; } catch {}
  return {
    repoUrl,
    startingRef: branch,
    ...(ahead > 0 ? { notice: `Started from \`${branch}\` on GitHub. ${ahead} local commit${ahead === 1 ? " is" : "s are"} not pushed, so the agent can't see ${ahead === 1 ? "it" : "them"}.` } : {}),
  };
}
