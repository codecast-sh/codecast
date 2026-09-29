/**
 * The daemon's side of a Cursor Cloud session: which conversations run on a
 * cloud agent, and the start / deliver / interrupt operations on them.
 *
 * A cloud agent cannot exist without a prompt, so `start` only records the
 * conversation (repo, branch, model) and the first delivered message creates
 * the agent; every later message is a follow-up run. The transcript comes back
 * through CursorCloudWatcher, like any Cursor transcript.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { cursorCloudModel } from "@codecast/shared/contracts";
import { codecastPath } from "./codecastDir.js";
import { CursorCloudApiError, TERMINAL_RUN_STATUSES, githubHttpsUrl, type CursorCloudWatcher } from "./cursorCloud.js";

const execFileAsync = promisify(execFile);

export interface CursorCloudSession {
  /** The cloud agent (bc-…), once the first message created it. */
  agentId?: string;
  projectPath?: string;
  repoUrl?: string;
  startingRef?: string;
  /** Cloud model id; "" = the account's default. */
  model: string;
  /** What the agent starts from when that differs from the checkout (see githubRepoAt). */
  notice?: string;
}

export interface CursorCloudDeps {
  watcher: () => CursorCloudWatcher | null;
  /** Map the agent id to the conversation, locally and on the server. */
  bindSession: (conversationId: string, agentId: string, projectPath: string | undefined, repoUrl: string | undefined) => void;
  /** The conversation already mapped to a cloud agent id, from the session cache. */
  agentForConversation: (conversationId: string) => string | undefined;
  setStatus: (conversationId: string, status: "connected" | "working" | "idle" | "stopped") => void;
  log: (msg: string) => void;
}

/**
 * A Cursor Cloud message that cannot go out until someone fixes the setup:
 * no key on this machine, a key Cursor rejects, or a repo/branch Cursor's
 * GitHub app cannot reach. `message` is what the session shows; the delivery
 * layer holds the message and resends it once the setup changes.
 */
export class CursorCloudSetupError extends Error {
  constructor(readonly kind: "key_missing" | "key_invalid" | "repo", message: string) {
    super(message);
  }
}

/** A follow-up the agent cannot take yet (a run is still going). Retried by the delivery layer. */
export class CursorCloudBusyError extends Error {
  constructor() {
    super("AGENT_STDIN_NOT_READY: the Cursor Cloud agent is still running the previous message");
  }
}

export class CursorCloudSessions {
  private sessions: Record<string, CursorCloudSession> = {};
  private readonly file: string;

  constructor(private readonly deps: CursorCloudDeps, file = codecastPath("cursor-cloud", "sessions.json")) {
    this.file = file;
    try { this.sessions = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.deps.log(`cursor cloud: could not save sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether codecast started this cloud agent. */
  ownsAgent(agentId: string): boolean {
    return Object.values(this.sessions).some((s) => s.agentId === agentId);
  }

  /** The conversation's cloud session: one codecast started, or a mirrored agent it was bound to. */
  get(conversationId: string): CursorCloudSession | undefined {
    const known = this.sessions[conversationId];
    if (known) return known;
    const agentId = this.deps.agentForConversation(conversationId);
    if (!agentId?.startsWith("bc-")) return undefined;
    const adopted: CursorCloudSession = { agentId, model: "" };
    this.sessions[conversationId] = adopted;
    this.save();
    return adopted;
  }

  /** Record a conversation that runs on Cursor Cloud. `modelKey` is the picker key (`cloud`, `cloud:<id>`). */
  async start(conversationId: string, projectPath: string | undefined, modelKey: string): Promise<void> {
    const model = cursorCloudModel(modelKey) ?? "";
    const repo = projectPath ? await githubRepoAt(projectPath) : null;
    this.sessions[conversationId] = { ...this.sessions[conversationId], projectPath, model, ...(repo ?? {}) };
    this.save();
    this.deps.log(`cursor cloud: conversation ${conversationId.slice(0, 12)} runs on Cursor Cloud (${repo ? `${repo.repoUrl}${repo.startingRef ? `@${repo.startingRef}` : ""}` : "no repo"}, model ${model || "default"})`);
    this.deps.setStatus(conversationId, "connected");
  }

  /**
   * Send a message: the first creates the agent, later ones start a run.
   * Resolves false when the conversation is not a cloud session.
   */
  async deliver(conversationId: string, content: string): Promise<boolean> {
    const session = this.get(conversationId);
    if (!session) return false;
    const watcher = this.deps.watcher();
    const api = watcher?.api();
    if (!watcher || !api) throw new CursorCloudSetupError("key_missing", "Cursor Cloud needs a Cursor API key on this machine.");
    if (!session.agentId) {
      let created: Awaited<ReturnType<typeof api.createAgent>>;
      try {
        created = await api.createAgent({
          prompt: { text: content },
          ...(session.model ? { model: { id: session.model } } : {}),
          ...(session.repoUrl ? { repos: [{ url: session.repoUrl, ...(session.startingRef ? { startingRef: session.startingRef } : {}) }] } : {}),
        });
      } catch (err) {
        throw setupErrorOf(err, session) ?? err;
      }
      const { agent } = created;
      session.agentId = agent.id;
      this.save();
      if (session.notice) watcher.setNotice(agent.id, session.notice);
      this.deps.bindSession(conversationId, agent.id, session.projectPath, session.repoUrl);
      this.deps.log(`cursor cloud: created agent ${agent.id} for conversation ${conversationId.slice(0, 12)} (${agent.url ?? ""})`);
    } else {
      try {
        await api.createRun(session.agentId, content);
      } catch (err) {
        if (err instanceof CursorCloudApiError && err.status === 409) throw new CursorCloudBusyError();
        throw setupErrorOf(err, session) ?? err;
      }
    }
    this.deps.setStatus(conversationId, "working");
    void watcher.follow(session.agentId!);
    return true;
  }

  /** Cancel the agent's active run. Resolves false when there is none (or no cloud session). */
  async interrupt(conversationId: string): Promise<boolean> {
    const session = this.get(conversationId);
    const api = this.deps.watcher()?.api();
    if (!session?.agentId || !api) return false;
    const runs = await api.listRuns(session.agentId);
    const active = runs.find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
    if (!active) return false;
    await api.cancelRun(session.agentId, active.id);
    this.deps.log(`cursor cloud: cancelled run ${active.id} of ${session.agentId}`);
    void this.deps.watcher()?.follow(session.agentId);
    return true;
  }
}

/** The setup problem an API error names, in words the session can show; null for anything else. */
function setupErrorOf(err: unknown, session: CursorCloudSession): CursorCloudSetupError | null {
  if (!(err instanceof CursorCloudApiError)) return null;
  if (err.status === 401 || err.status === 403) return new CursorCloudSetupError("key_invalid", `Cursor rejected the API key on this machine (${err.message}).`);
  if (err.status === 400 && err.code === "validation_error" && /repositor|branch/i.test(err.message)) {
    const repo = session.repoUrl?.replace("https://github.com/", "") ?? "this repository";
    return new CursorCloudSetupError("repo", `Cursor Cloud can't reach ${repo}: ${err.message} Give Cursor's GitHub app access to the repository, then send again.`);
  }
  return null;
}

/**
 * The GitHub repo and pushed branch a checkout is on, or null when it has no
 * GitHub remote. The agent clones the remote, so it starts from the local
 * branch only if that branch is on GitHub, else from the default branch; and
 * it never sees commits that are not pushed. `notice` says so when either
 * applies.
 */
export async function githubRepoAt(dir: string): Promise<{ repoUrl: string; startingRef?: string; notice?: string } | null> {
  const git = async (...args: string[]) => (await execFileAsync("git", ["-C", dir, ...args], { timeout: 15_000 })).stdout.trim();
  let remote: string;
  try { remote = await git("config", "--get", "remote.origin.url"); } catch { return null; }
  const repoUrl = githubHttpsUrl(remote);
  if (!repoUrl) return null;
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
