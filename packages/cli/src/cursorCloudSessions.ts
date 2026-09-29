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
    if (!watcher || !api) throw new Error("AGENT_STDIN_NOT_READY: no Cursor API key on this machine (run `cast keys set cursor`)");
    if (!session.agentId) {
      const { agent } = await api.createAgent({
        prompt: { text: content },
        ...(session.model ? { model: { id: session.model } } : {}),
        ...(session.repoUrl ? { repos: [{ url: session.repoUrl, ...(session.startingRef ? { startingRef: session.startingRef } : {}) }] } : {}),
      });
      session.agentId = agent.id;
      this.save();
      this.deps.bindSession(conversationId, agent.id, session.projectPath, session.repoUrl);
      this.deps.log(`cursor cloud: created agent ${agent.id} for conversation ${conversationId.slice(0, 12)} (${agent.url ?? ""})`);
    } else {
      try {
        await api.createRun(session.agentId, content);
      } catch (err) {
        if (err instanceof CursorCloudApiError && err.status === 409) throw new CursorCloudBusyError();
        throw err;
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

/** The GitHub repo and pushed branch a checkout is on, or null when it has no GitHub remote. */
export async function githubRepoAt(dir: string): Promise<{ repoUrl: string; startingRef?: string } | null> {
  const git = async (...args: string[]) => (await execFileAsync("git", ["-C", dir, ...args], { timeout: 15_000 })).stdout.trim();
  let remote: string;
  try { remote = await git("remote", "get-url", "origin"); } catch { return null; }
  const repoUrl = githubHttpsUrl(remote);
  if (!repoUrl) return null;
  // The agent clones the remote, so only a branch that exists there can be its
  // start; an unpushed one starts from the default branch instead.
  let branch: string | undefined;
  try { branch = await git("rev-parse", "--abbrev-ref", "HEAD"); } catch {}
  if (!branch || branch === "HEAD") return { repoUrl };
  try {
    const heads = await git("ls-remote", "--heads", "origin", branch);
    return heads ? { repoUrl, startingRef: branch } : { repoUrl };
  } catch {
    return { repoUrl };
  }
}
