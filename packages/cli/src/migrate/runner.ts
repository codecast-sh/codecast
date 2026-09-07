/**
 * The bulk-migration runner: `cast migrate run <batch>`, started detached by
 * the executor daemon (migrate_sessions). Drives every row of the batch that
 * names this machine as its executor through the server rail in
 * convex/sessionMigrations.ts:
 *
 *   begin (fence) → wait for the turn to end → quiesce the owner →
 *   transfer → finish (flip + resume + release + unfence) → confirm
 *
 * Kept free of SSH, git and Convex so the sequencing is testable: everything
 * that touches the world comes in through `RunnerIo` (see io.ts for the real
 * one). The rules worth reading:
 *
 *  - A row is fenced BEFORE the idle wait, so messages sent while we wait
 *    queue instead of starting new turns (a busy session would otherwise
 *    never go idle under steady traffic). They ride the resume.
 *  - "Idle" means no turn is in progress. A session stopped at a permission
 *    prompt is not producing and its answer could never arrive through the
 *    fence, so it is moved at once; the prompt re-asks on the destination.
 *  - The wait is bounded by the batch's wait_for_idle_ms; past it the turn is
 *    interrupted (quiesce mode "force"), and the row says so.
 *  - Sessions sharing one working tree push the tree once per host.
 */

import { MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";

export type RowDirection = "to_cloud" | "to_local";

export interface RunnerRow {
  migration_id: string;
  conversation_id: string;
  session_id: string | null;
  title: string | null;
  short_id: string | null;
  direction: RowDirection;
  from_device_id: string | null;
  to_device_id: string;
  status: string;
  position: number;
  source_path: string | null;
  destination_path: string | null;
}

export interface RunnerBatch {
  batch_id: string;
  to_device_id: string;
  cancelled_at: number | null;
  wait_for_idle_ms: number;
  concurrency: number;
  rows: RunnerRow[];
}

export type BeginResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      conversation_id: string;
      session_id: string;
      direction: RowDirection;
      owner_device_id: string | null;
      owner_is_remote: boolean;
      owner_online: boolean;
      owner_label: string | null;
      to_device_id: string;
      to_label: string | null;
      project_path: string | null;
      git_root: string | null;
      git_remote_url: string | null;
      worktree_name: string | null;
      worktree_branch: string | null;
      agent_status: string | null;
      title: string | null;
    };

export type SessionFacts = {
  status: string;
  batch_cancelled: boolean;
  owner_device_id: string | null;
  owner_online: boolean;
  agent_status: string | null;
  fenced: boolean;
};

export type CommandStatus = {
  executed_at: number | null;
  result: string | null;
  error: string | null;
};

export type TransferResult = {
  /** Where the session's files now live on the destination (its new project_path). */
  destinationPath: string;
  gitRoot?: string;
  /** Where they came from (recorded so a later batch can bring it back). */
  sourcePath: string;
  /** One line stating what the transfer proved. */
  verification: string;
};

export interface RunnerIo {
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  deviceId(): string;

  loadBatch(): Promise<RunnerBatch | null>;
  begin(migrationId: string): Promise<BeginResult>;
  facts(migrationId: string): Promise<SessionFacts | null>;
  report(migrationId: string, patch: { status?: "waiting_idle" | "quiescing" | "transferring" | "switching" | "resuming"; stage?: string }): Promise<void>;
  enqueueQuiesce(migrationId: string, mode: "idle" | "force"): Promise<{ command_id: string | null; target_device_id: string | null }>;
  commandStatus(commandId: string): Promise<CommandStatus | null>;
  finish(migrationId: string, args: { project_path: string; git_root?: string; verification?: string; source_path?: string }): Promise<{ ok: true; resume_command_id: string | null } | { ok: false; reason: string }>;
  confirm(migrationId: string, ok: boolean, detail?: { error?: string; stage?: string }): Promise<void>;
  fail(migrationId: string, error: string, cancelled?: boolean): Promise<void>;
  sendNotice(conversationId: string, text: string): Promise<void>;
  deviceOnline(deviceId: string): Promise<boolean>;

  /** Wake and resolve the cloud host behind a device id (throws when this machine cannot reach it). */
  prepareHost(deviceId: string): Promise<void>;
  transferToCloud(facts: Extract<BeginResult, { ok: true }>, opts: { skipTree: boolean }): Promise<TransferResult & { localCwd: string }>;
  transferToLocal(facts: Extract<BeginResult, { ok: true }>): Promise<TransferResult>;
  /** The reorientation notice for the moved agent, from what the transfer proved. */
  notice(facts: Extract<BeginResult, { ok: true }>, transfer: TransferResult): string | null;
}

/** Statuses that mean "a turn is being produced"; the wait is for these to end. */
export const WAIT_FOR_STATUSES: ReadonlySet<string> = new Set(
  [...MID_TURN_AGENT_STATUSES].filter((s) => s !== "permission_blocked"),
);

export const IDLE_POLL_MS = 5_000;
export const COMMAND_POLL_MS = 2_000;
/** Longer than the queue's 5-minute command TTL: an unclaimed command is dead by then. */
export const COMMAND_TIMEOUT_MS = 6 * 60_000;
export const RESUME_CONFIRM_TIMEOUT_MS = 3 * 60_000;
export const DEVICE_ONLINE_TIMEOUT_MS = 150_000;

const short = (s: string | null | undefined) => (s ? s.slice(0, 8) : "?");
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`;

export function describeRow(row: RunnerRow): string {
  return `${row.short_id ?? short(row.conversation_id)}${row.title ? ` "${row.title.slice(0, 40)}"` : ""}`;
}

/** Poll a daemon command until it reports or the TTL has surely killed it. */
export async function awaitCommand(io: RunnerIo, commandId: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandStatus | null> {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    const st = await io.commandStatus(commandId);
    if (st?.executed_at) return st;
    if (io.now() >= deadline) return null;
    await io.sleep(COMMAND_POLL_MS);
  }
}

export async function awaitDeviceOnline(io: RunnerIo, deviceId: string, timeoutMs = DEVICE_ONLINE_TIMEOUT_MS): Promise<boolean> {
  const deadline = io.now() + timeoutMs;
  for (;;) {
    if (await io.deviceOnline(deviceId)) return true;
    if (io.now() >= deadline) return false;
    await io.sleep(IDLE_POLL_MS);
  }
}

export type RowOutcome = { migration_id: string; outcome: "done" | "failed" | "skipped" | "cancelled"; detail?: string };

/**
 * Coordinates tree pushes between rows that share a working tree: the first
 * row to claim a (host, cwd) pushes it; later rows await that and skip it.
 */
export class SharedTreeLedger {
  private pushes = new Map<string, Promise<void>>();
  private resolvers = new Map<string, () => void>();
  /** Returns true when THIS caller owns the push for the key. */
  claim(key: string): boolean {
    if (this.pushes.has(key)) return false;
    let resolve!: () => void;
    this.pushes.set(key, new Promise<void>((r) => { resolve = r; }));
    this.resolvers.set(key, resolve);
    return true;
  }
  async awaitPushed(key: string): Promise<void> {
    await this.pushes.get(key);
  }
  settle(key: string): void {
    this.resolvers.get(key)?.();
  }
  /** A failed push must not leave followers waiting forever: release them to push themselves. */
  release(key: string): void {
    this.settle(key);
    this.pushes.delete(key);
    this.resolvers.delete(key);
  }
}

export async function migrateRow(
  io: RunnerIo,
  batch: RunnerBatch,
  row: RunnerRow,
  ledger: SharedTreeLedger,
): Promise<RowOutcome> {
  const id = row.migration_id;
  const tag = describeRow(row);
  const begun = await io.begin(id);
  if (!begun.ok) {
    io.log(`skip ${tag}: ${begun.reason}`);
    return { migration_id: id, outcome: "skipped", detail: begun.reason };
  }
  const facts = begun;
  const fail = async (error: string): Promise<RowOutcome> => {
    io.log(`FAILED ${tag}: ${error}`);
    await io.fail(id, error);
    return { migration_id: id, outcome: "failed", detail: error };
  };
  try {
    // ── 1. wait for the turn to end (fenced, so nothing new starts) ─────────
    const deadline = io.now() + Math.max(0, batch.wait_for_idle_ms);
    let status = facts.agent_status;
    let forced = false;
    for (;;) {
      const busy = WAIT_FOR_STATUSES.has(status ?? "");
      if (!busy) break;
      if (io.now() >= deadline) { forced = true; break; }
      await io.report(id, { status: "waiting_idle", stage: `waiting for the current turn to finish (${status}; up to ${minutes(deadline - io.now())} more)` });
      await io.sleep(IDLE_POLL_MS);
      const f = await io.facts(id);
      if (!f) return fail("the migration row disappeared");
      if (f.batch_cancelled) {
        io.log(`cancelled ${tag} before the transfer started`);
        await io.fail(id, "cancelled before the transfer started", true);
        return { migration_id: id, outcome: "cancelled" };
      }
      status = f.agent_status;
    }
    if (forced) io.log(`${tag}: still ${status} after the idle window — interrupting the turn`);
    else if (status === "permission_blocked") io.log(`${tag}: stopped at a permission prompt — moving now; the prompt re-asks on the destination`);

    // ── 2. quiesce the current owner so the transcript is final ─────────────
    // For a move back, the owner is the cloud host: wake it and wait for its
    // daemon before asking, or the command dies in the queue unclaimed.
    if (facts.direction === "to_local") {
      if (!facts.owner_device_id) return fail("the session has no owner device to bring it back from");
      await io.report(id, { status: "quiescing", stage: `waking ${facts.owner_label ?? "the cloud host"}` });
      await io.prepareHost(facts.owner_device_id);
      if (!(await awaitDeviceOnline(io, facts.owner_device_id))) {
        return fail(`${facts.owner_label ?? "the cloud host"} never came online`);
      }
    }
    let mode: "idle" | "force" = forced ? "force" : "idle";
    for (let attempt = 0; ; attempt++) {
      const q = await io.enqueueQuiesce(id, mode);
      if (!q.command_id) break; // nobody runs it — nothing to stop
      const st = await awaitCommand(io, q.command_id);
      if (!st) return fail(`the daemon on ${facts.direction === "to_local" ? (facts.owner_label ?? "the cloud host") : "this machine"} did not pick up the stop command (is it online and up to date?)`);
      if (st.error) return fail(`could not stop the session: ${st.error}`);
      let parsed: any = {};
      try { parsed = st.result ? JSON.parse(st.result) : {}; } catch { /* non-JSON result: treat as done */ }
      if (parsed.quiesced === false) {
        // A turn began between our check and the stop. Keep waiting inside
        // the same window; past it, force.
        if (io.now() >= deadline || attempt >= 60) { mode = "force"; forced = true; continue; }
        await io.report(id, { status: "waiting_idle", stage: `a turn started (${parsed.reason ?? "busy"}); waiting for it to finish` });
        await io.sleep(IDLE_POLL_MS);
        continue;
      }
      break;
    }

    // ── 3. transfer ─────────────────────────────────────────────────────────
    let transfer: TransferResult;
    if (facts.direction === "to_cloud") {
      await io.report(id, { status: "transferring", stage: `waking ${facts.to_label ?? "the cloud host"}` });
      await io.prepareHost(facts.to_device_id);
      if (!(await awaitDeviceOnline(io, facts.to_device_id))) {
        return fail(`${facts.to_label ?? "the cloud host"} never came online`);
      }
      // Sessions that share a working tree push it once per host.
      const key = `${facts.to_device_id}:${facts.project_path ?? facts.session_id}`;
      const owner = ledger.claim(key);
      if (!owner) {
        await io.report(id, { status: "transferring", stage: "waiting for a sibling session to push the shared worktree" });
        await ledger.awaitPushed(key);
      }
      await io.report(id, { status: "transferring", stage: owner ? "pushing worktree + transcript" : "pushing transcript (worktree already there)" });
      try {
        const t = await io.transferToCloud(facts, { skipTree: !owner });
        transfer = t;
        if (owner) ledger.settle(key);
      } catch (err) {
        if (owner) ledger.release(key);
        throw err;
      }
    } else {
      await io.report(id, { status: "transferring", stage: "pulling worktree + transcript from the cloud host" });
      transfer = await io.transferToLocal(facts);
    }
    io.log(`${tag}: ${transfer.verification}`);

    // ── 4. flip ─────────────────────────────────────────────────────────────
    await io.report(id, { status: "switching", stage: `handing the session to ${facts.to_label ?? "the destination"}` });
    const fin = await io.finish(id, {
      project_path: transfer.destinationPath,
      git_root: transfer.gitRoot,
      verification: transfer.verification,
      source_path: transfer.sourcePath,
    });
    if (!fin.ok) return fail(`handoff refused: ${fin.reason}`);
    const notice = io.notice(facts, transfer);
    if (notice) await io.sendNotice(facts.conversation_id, notice);

    // ── 5. confirm the resume landed ────────────────────────────────────────
    if (fin.resume_command_id) {
      const st = await awaitCommand(io, fin.resume_command_id, RESUME_CONFIRM_TIMEOUT_MS);
      if (st?.error) {
        const detail = `moved, but the resume on ${facts.to_label ?? "the destination"} failed: ${st.error}`;
        io.log(`${tag}: ${detail}`);
        await io.confirm(id, false, { error: detail });
        return { migration_id: id, outcome: "failed", detail };
      }
      const stage = st
        ? (forced ? `running on ${facts.to_label ?? "the destination"} (its turn was interrupted to move it)` : `running on ${facts.to_label ?? "the destination"}`)
        : `moved to ${facts.to_label ?? "the destination"}; its daemon has not confirmed the resume yet`;
      await io.confirm(id, true, { stage });
    } else {
      await io.confirm(id, true, { stage: `moved to ${facts.to_label ?? "the destination"}` });
    }
    io.log(`done ${tag} → ${transfer.destinationPath}`);
    return { migration_id: id, outcome: "done" };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run every queued row of the batch that this machine executes, `concurrency`
 * at a time, in batch order. Returns the outcomes (the process exit code is
 * the caller's call: a batch with one failed row still moved the rest).
 */
export async function runBatch(io: RunnerIo, opts: { concurrency?: number } = {}): Promise<RowOutcome[]> {
  const batch = await io.loadBatch();
  if (!batch) throw new Error("no such batch (or it belongs to another account)");
  const mine = batch.rows.filter((r) => r.status === "queued").sort((a, b) => a.position - b.position);
  io.log(`batch ${batch.batch_id}: ${mine.length} queued row(s) for this machine (device ${short(io.deviceId())}), concurrency ${opts.concurrency ?? batch.concurrency}`);
  if (mine.length === 0) return [];
  const ledger = new SharedTreeLedger();
  const outcomes: RowOutcome[] = [];
  const width = Math.max(1, opts.concurrency ?? batch.concurrency ?? 1);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const row = mine[next++];
      if (!row) return;
      outcomes.push(await migrateRow(io, batch, row, ledger));
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, mine.length) }, worker));
  const tally = outcomes.reduce((acc, o) => ({ ...acc, [o.outcome]: (acc[o.outcome] ?? 0) + 1 }), {} as Record<string, number>);
  io.log(`batch ${batch.batch_id} finished: ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to do"}`);
  return outcomes;
}
