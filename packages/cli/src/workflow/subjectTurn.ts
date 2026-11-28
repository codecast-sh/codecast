// When the run's subject has answered a brief (subjectStation.ts, runner.ts waitOnStation). The run never goes on
// while the subject may still be working on it: that freezes a fix half-made (ct-98624). Its answer is the end of its
// own turn after the brief, read from its agent's status (trusted as the server trusts it: an in-turn status quiet past
// STATUS_TRUST_TTL_MS reads idle), never from the row's work_state, which reads working while agents it left running
// produce or a notification waits for it:
//   - inside a turn (working, thinking, compacting): it waits, whatever else is true;
//   - idle, done, dormant: the turn is over;
//   - waiting (the turn ended, and background work it started will wake it again: a test run, an Agent making the fix):
//     over only once the session has pushed the change's branch since the brief and stayed quiet PUSHED_QUIET_MS since.
// ct-102698 sat at Fix findings for an hour after its subject pushed the fix and ended its turn on waiting. While a
// pushed session still reads at work, the run's words say what it waits on.
import { execFileAsync } from "../proc.js";
import { trustedAgentStatus } from "@codecast/shared/contracts";

export type SubjectTurnRow = { work_state?: string; agent_status?: string | null; message_count?: number; ts?: number; updated_at?: string };

const IN_TURN = new Set(["working", "thinking", "compacting"]);
const TURN_OVER = new Set(["idle", "done", "dormant"]);
/** How long a session waiting on its background work after pushing the change's branch stays quiet before the push is its answer. */
export const PUSHED_QUIET_MS = 15 * 60_000;
const HEAD_READ_MS = 60_000;
const SAY_EVERY_MS = 5 * 60_000;

/** The branch's head on origin: its sha, null when origin has no such branch, undefined when it could not be read. */
type HeadRead = (cwd: string, branch: string) => Promise<string | null | undefined>;

const originHead: HeadRead = async (cwd, branch) => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-remote", "origin", `refs/heads/${branch}`], { encoding: "utf-8", timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return String(stdout).split(/\s/)[0] || null;
  } catch {
    return undefined;
  }
};

export class SubjectTurn {
  /** The branch's head at the brief: undefined until a read of it succeeds (a failed read is tried again), null when origin had none. */
  private briefHead: string | null | undefined = undefined;
  private pushed: { sha: string; at: number } | null = null;
  private readAt = -Infinity;
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
    await this.readHead();
    return this;
  }

  private async readHead(): Promise<void> {
    if (!this.o.branch || this.pushed || this.now() - this.readAt < HEAD_READ_MS) return;
    this.readAt = this.now();
    const head = await this.read(this.o.cwd, this.o.branch);
    if (head === undefined) return;
    if (this.briefHead === undefined) this.briefHead = head;
    else if (head && head !== this.briefHead) this.pushed = { sha: head, at: this.now() };
  }

  /** The agent's status as the server trusts it. */
  private status(row: SubjectTurnRow): string {
    const at = typeof row.ts === "number" ? row.ts : row.updated_at ? Date.parse(row.updated_at) : undefined;
    return trustedAgentStatus(row.agent_status ?? undefined, Number.isFinite(at) ? at : undefined, this.now()) ?? "";
  }

  /** Its turn is over: its agent says so, or waits on background work after pushing its fix and keeping quiet since. */
  private over(row: SubjectTurnRow): boolean {
    const status = this.status(row);
    if (TURN_OVER.has(status)) return true;
    return status === "waiting" && !!this.pushed && this.now() - this.movedAt >= PUSHED_QUIET_MS;
  }

  /** The row's work state as the subject's own turn has it: a turn that is over reads dormant, so the wait settles. */
  state(row: SubjectTurnRow): string {
    const state = row.work_state || "idle";
    return state === "working" && this.over(row) ? "dormant" : state;
  }

  /** Whether the subject is still at the brief: inside a turn, its transcript growing, not yet past the brief and its reply, or its turn not over. */
  async atWork(row: SubjectTurnRow, grew: boolean, sentAtCount: number): Promise<boolean> {
    const count = row.message_count ?? 0;
    if (count !== this.count) { this.count = count; this.movedAt = this.now(); }
    await this.readHead();
    const status = this.status(row);
    const working = grew || count < sentAtCount + 2 || IN_TURN.has(status) || (status === "waiting" ? !this.over(row) : !TURN_OVER.has(status) && row.work_state === "working");
    if (working && this.pushed && this.now() - this.saidAt >= SAY_EVERY_MS) {
      this.saidAt = this.now();
      const mins = Math.round((this.now() - this.pushed.at) / 60_000);
      await this.o.say(`waiting for ${this.o.shortId} to finish; it pushed ${this.pushed.sha.slice(0, 7)} ${mins < 1 ? "just now" : `${mins} min ago`}`);
    }
    return working;
  }
}
