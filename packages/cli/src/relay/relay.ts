import { parsePollMessage } from "../pollMessage.js";
import { sanitizeForTerminal } from "./sanitize.js";
import type { DeliveryTarget, TargetAdapter } from "./targets.js";

export type PendingRow = {
  _id: string;
  content: string;
  session_id?: string;
  delivery_target?: DeliveryTarget;
  image_storage_id?: string;
  image_storage_ids?: string[];
  created_at?: number;
  _creationTime?: number;
};

export type RelayClient = {
  mutation(name: string, args: Record<string, unknown>): Promise<any>;
  query(name: string, args: Record<string, unknown>): Promise<any>;
};

export type RelayDeps = {
  client: RelayClient;
  adapter: TargetAdapter;
  apiToken: string;
  deviceId: string;
  log: (line: string) => void;
  now?: () => number;
};

type OwedStatus = "delivered" | "failed" | "undeliverable";

export const GONE_STRIKES_TO_END = 2;
export const HERDR_END_GRACE_MS = 3 * 60_000;

export function wrapForHandoff(content: string, imageCount = 0): string {
  const note = imageCount > 0 ? `\n[${imageCount} image(s) not delivered]` : "";
  return `<<<<<<\n${content}${note}\n>>>>>>`;
}

export function isControlMessage(content: string): boolean {
  return (parsePollMessage(content) as { __cc_poll?: unknown } | null)?.__cc_poll === true;
}

export class Relay {
  private rows: PendingRow[] = [];
  private owed = new Map<string, OwedStatus>();
  private settled = new Set<string>();
  private goneStrikes = new Map<string, number>();
  private running = false;
  private dirty = false;
  private runPromise: Promise<void> = Promise.resolve();
  private sweepPromise: Promise<void> = Promise.resolve();

  constructor(private deps: RelayDeps) {}

  private auth() {
    return { api_token: this.deps.apiToken, device_id: this.deps.deviceId };
  }

  async heartbeat(): Promise<void> {
    try {
      await this.deps.client.mutation("registeredSessions:relayHeartbeat", this.auth());
    } catch (err) {
      this.deps.log(`heartbeat failed: ${errorText(err)}`);
    }
  }

  onRows(rows: PendingRow[]): Promise<void> {
    this.rows = rows;
    this.settled.clear();
    const present = new Set(rows.map((r) => r._id));
    for (const id of this.owed.keys()) if (!present.has(id)) this.owed.delete(id);
    return this.process();
  }

  tick(): Promise<void> {
    return this.process();
  }

  async idle(): Promise<void> {
    await this.runPromise;
    await this.sweepPromise;
  }

  private process(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.runPromise;
    }
    this.running = true;
    this.runPromise = (async () => {
      try {
        do {
          this.dirty = false;
          await Promise.all(groupBySession(this.rows).map((group) => this.runGroup(group)));
        } while (this.dirty);
      } finally {
        this.running = false;
      }
    })();
    return this.runPromise;
  }

  private async runGroup(group: PendingRow[]): Promise<void> {
    for (const row of group) if (!(await this.handle(row))) return;
  }

  private async handle(row: PendingRow): Promise<boolean> {
    if (this.settled.has(row._id)) return true;
    try {
      const status = this.owed.get(row._id) ?? (isControlMessage(row.content) ? "undeliverable" : undefined);
      if (status) {
        await this.settle(row, status);
        return true;
      }
      return await this.deliver(row);
    } catch (err) {
      this.deps.log(`message ${row._id}: ${errorText(err)}; will retry`);
      return false;
    }
  }

  private async settle(row: PendingRow, status: OwedStatus): Promise<void> {
    const res = await this.deps.client.mutation("pendingMessages:updateMessageStatus", {
      message_id: row._id,
      status,
      ...(status === "delivered" ? { delivered_at: (this.deps.now ?? Date.now)() } : {}),
      ...this.auth(),
    });
    this.owed.delete(row._id);
    this.settled.add(row._id);
    this.deps.log(res?.skipped ? `message ${row._id}: ${status} skipped, already settled` : `message ${row._id}: ${status}`);
  }

  private async deliver(row: PendingRow): Promise<boolean> {
    if (!row.delivery_target || !row.session_id) {
      this.deps.log(`message ${row._id}: no delivery target on its session; leaving pending`);
      return false;
    }
    const images = row.image_storage_ids?.length ?? (row.image_storage_id ? 1 : 0);
    if (images > 0) this.deps.log(`message ${row._id}: ${images} image(s) skipped, delivering text only`);
    const content = row.delivery_target.kind === "herdr" ? sanitizeForTerminal(row.content) : row.content;
    const result = await this.deps.adapter.deliver(row.delivery_target, wrapForHandoff(content, images));
    if (result.kind === "ok") {
      this.owed.set(row._id, "delivered");
      this.goneStrikes.delete(row.session_id);
      this.deps.log(`message ${row._id}: handed off to ${describe(row.delivery_target)}`);
      await this.settle(row, "delivered");
      return true;
    }
    if (result.kind === "uncertain") {
      this.owed.set(row._id, "failed");
      this.deps.log(`message ${row._id}: ${result.reason}; it may have landed, marking failed and not resending`);
      await this.settle(row, "failed");
      return false;
    }
    this.deps.log(`message ${row._id}: ${result.kind} (${result.reason}); left pending${result.kind === "gone" ? " for the sweep to judge" : ", will retry"}`);
    return false;
  }

  private strike(sessionId: string): number {
    const strikes = (this.goneStrikes.get(sessionId) ?? 0) + 1;
    this.goneStrikes.set(sessionId, strikes);
    return strikes;
  }

  private async endSession(sessionId: string, target: DeliveryTarget): Promise<void> {
    await this.deps.client.mutation("registeredSessions:markEnded", { session_id: sessionId, delivery_target: target, device_id: this.deps.deviceId, api_token: this.deps.apiToken });
    this.goneStrikes.delete(sessionId);
    this.rows = this.rows.filter((r) => r.session_id !== sessionId);
  }

  sweep(): Promise<void> {
    this.sweepPromise = this.runSweep();
    return this.sweepPromise;
  }

  private async runSweep(): Promise<void> {
    let registered: Array<{ session_id: string; delivery_target: DeliveryTarget; short_id: string; registered_at?: number }>;
    try {
      registered = await this.deps.client.query("registeredSessions:registeredForDevice", this.auth());
    } catch (err) {
      this.deps.log(`sweep: could not list registered sessions: ${errorText(err)}`);
      return;
    }
    await Promise.all(registered.map(async (reg) => {
      const live = await this.deps.adapter.probe(reg.delivery_target);
      if (live.kind !== "gone") {
        this.goneStrikes.delete(reg.session_id);
        return;
      }
      if (reg.delivery_target.kind === "herdr" && reg.registered_at !== undefined && (this.deps.now ?? Date.now)() - reg.registered_at < HERDR_END_GRACE_MS) {
        this.goneStrikes.delete(reg.session_id);
        this.deps.log(`sweep: ${reg.short_id} looks gone (${live.reason}) but registered moments ago; herdr may still be detecting its agent`);
        return;
      }
      const strikes = this.strike(reg.session_id);
      if (strikes < GONE_STRIKES_TO_END) {
        this.deps.log(`sweep: ${reg.short_id} looks gone (${live.reason}); confirming on the next reading`);
        return;
      }
      try {
        await this.endSession(reg.session_id, reg.delivery_target);
        this.deps.log(`sweep: ${reg.short_id} ended (${live.reason})`);
      } catch (err) {
        this.deps.log(`sweep: could not end ${reg.short_id}: ${errorText(err)}`);
      }
    }));
  }
}

function groupBySession(rows: PendingRow[]): PendingRow[][] {
  const groups = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const key = row.session_id ?? `row:${row._id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const at = (row: PendingRow) => row.created_at ?? row._creationTime ?? 0;
  return [...groups.values()].map((group) => group.map((row, index) => ({ row, index })).sort((a, b) => at(a.row) - at(b.row) || a.index - b.index).map((x) => x.row));
}

function describe(target: DeliveryTarget): string {
  return target.kind === "herdr" ? `herdr pane ${target.pane}` : `paseo agent ${target.agent_id}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
