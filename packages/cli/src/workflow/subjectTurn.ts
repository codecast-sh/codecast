// When the run's subject has answered a brief (subjectStation.ts, runner.ts waitOnStation). Its answer is the end of
// its own turn after the brief, read from its agent's status: a row's work_state reads working while background agents
// it started still run or a notification waits for it, and ct-102698 sat at Fix findings for an hour after its subject
// pushed the fix and ended that turn, its row reading working on the agents it had left running. A push of the change's
// branch since the brief answers too, once the session has been quiet a while: the pushed commit is its fix, whatever a
// stale status says. While a pushed session still reads at work, the run's words say what it waits on.
import { promisify } from "node:util";
import { execFile } from "../proc.js";

export type SubjectTurnRow = { work_state?: string; agent_status?: string | null; message_count?: number };

// The agent's own word that its turn is over: background work still running, nothing to do, or a pin.
const TURN_OVER = new Set(["waiting", "idle", "done", "dormant"]);
// Inside a turn, whatever the row's work_state says.
const IN_TURN = new Set(["working", "thinking", "compacting"]);
/** How long a session that pushed the change's branch since the brief may stay quiet before the push is its answer. */
export const PUSHED_QUIET_MS = 15 * 60_000;
const HEAD_READ_MS = 60_000;
const SAY_EVERY_MS = 5 * 60_000;

type HeadRead = (cwd: string, branch: string) => Promise<string | null>;

/** The branch's head on origin, or null when it cannot be read within 15s. */
const originHead: HeadRead = async (cwd, branch) => {
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, "ls-remote", "origin", `refs/heads/${branch}`], { encoding: "utf-8", timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return String(stdout).split(/\s/)[0] || null;
  } catch {
    return null;
  }
};

export class SubjectTurn {
  private briefHead: string | null = null;
  private pushed: { sha: string; at: number } | null = null;
  private readAt = 0;
  private count = -1;
  private movedAt: number;
  private saidAt = 0;
  private readonly now: () => number;
  private readonly read: HeadRead;

  constructor(private readonly o: { cwd: string; branch: string | null; shortId: string; say: (words: string) => unknown; now?: () => number; readHead?: HeadRead }) {
    this.now = o.now ?? Date.now;
    this.read = o.readHead ?? originHead;
    this.movedAt = this.now();
  }

  /** Read the branch's head as it stands at the brief: only a push after this answers. */
  async begin(): Promise<this> {
    if (this.o.branch) this.briefHead = await this.read(this.o.cwd, this.o.branch);
    this.readAt = this.now();
    return this;
  }

  /** The branch moved on origin since the brief, and the session has been quiet the cap since. */
  private pushedQuiet(): boolean {
    return !!this.pushed && this.now() - this.movedAt >= PUSHED_QUIET_MS;
  }

  /** The row's work state as the subject's own turn has it: working only while its agent is inside a turn. */
  state(row: SubjectTurnRow): string {
    const state = row.work_state || "idle";
    return state === "working" && (TURN_OVER.has(row.agent_status ?? "") || this.pushedQuiet()) ? "dormant" : state;
  }

  /** Whether the subject is still at the brief: inside a turn, its transcript growing, or not yet past the brief and its reply. */
  async atWork(row: SubjectTurnRow, grew: boolean, sentAtCount: number): Promise<boolean> {
    const count = row.message_count ?? 0;
    if (count !== this.count) { this.count = count; this.movedAt = this.now(); }
    if (this.o.branch && this.briefHead && !this.pushed && this.now() - this.readAt >= HEAD_READ_MS) {
      this.readAt = this.now();
      const head = await this.read(this.o.cwd, this.o.branch);
      if (head && head !== this.briefHead) this.pushed = { sha: head, at: this.now() };
    }
    if (this.pushedQuiet()) return false;
    const status = row.agent_status ?? "";
    const working = grew || IN_TURN.has(status) || (row.work_state === "working" && !TURN_OVER.has(status)) || count < sentAtCount + 2;
    if (working && this.pushed && this.now() - this.saidAt >= SAY_EVERY_MS) {
      this.saidAt = this.now();
      const mins = Math.round((this.now() - this.pushed.at) / 60_000);
      await this.o.say(`waiting for ${this.o.shortId} to finish; it pushed ${this.pushed.sha.slice(0, 7)} ${mins < 1 ? "just now" : `${mins} min ago`}`);
    }
    return working;
  }
}
