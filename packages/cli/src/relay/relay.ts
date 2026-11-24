import { parsePollMessage } from "../pollMessage.js";
import type { DeliveryTarget, TargetAdapter } from "./targets.js";

export type PendingRow = {
  _id: string;
  content: string;
  session_id?: string;
  delivery_target?: DeliveryTarget;
  image_storage_id?: string;
  image_storage_ids?: string[];
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

export const GONE_STRIKES_TO_END = 2;

export function wrapForHandoff(content: string): string {
  return `<<<<<<\n${content}\n>>>>>>`;
}

export function isControlMessage(content: string): boolean {
  return (parsePollMessage(content) as { __cc_poll?: unknown } | null)?.__cc_poll === true;
}

export class Relay {
  private rows: PendingRow[] = [];
  private handedOff = new Set<string>();
  private settled = new Set<string>();
  private goneStrikes = new Map<string, number>();
  private running = false;
  private dirty = false;

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

  async onRows(rows: PendingRow[]): Promise<void> {
    this.rows = rows;
    await this.process();
  }

  async tick(): Promise<void> {
    await this.process();
  }

  private async process(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        await Promise.all(this.rows.map((row) => this.handle(row)));
      } while (this.dirty);
    } finally {
      this.running = false;
    }
  }

  private async handle(row: PendingRow): Promise<void> {
    if (this.settled.has(row._id)) return;
    try {
      if (isControlMessage(row.content)) return await this.settleControl(row);
      if (this.handedOff.has(row._id)) return await this.ack(row);
      await this.deliver(row);
    } catch (err) {
      this.deps.log(`message ${row._id}: ${errorText(err)}; will retry`);
    }
  }

  private async settleControl(row: PendingRow): Promise<void> {
    const res = await this.deps.client.mutation("pendingMessages:updateMessageStatus", {
      message_id: row._id, status: "undeliverable", ...this.auth(),
    });
    this.settled.add(row._id);
    this.deps.log(`message ${row._id}: poll-keystroke row settled undeliverable${res?.skipped ? " (already settled)" : ""}`);
  }

  private async ack(row: PendingRow): Promise<void> {
    const res = await this.deps.client.mutation("pendingMessages:updateMessageStatus", {
      message_id: row._id, status: "delivered", delivered_at: (this.deps.now ?? Date.now)(), ...this.auth(),
    });
    this.settled.add(row._id);
    this.deps.log(res?.skipped ? `message ${row._id}: ack skipped, already settled` : `message ${row._id}: delivered`);
  }

  private async deliver(row: PendingRow): Promise<void> {
    if (!row.delivery_target || !row.session_id) {
      this.deps.log(`message ${row._id}: no delivery target on its session; leaving pending`);
      return;
    }
    if (row.image_storage_id || row.image_storage_ids?.length) {
      this.deps.log(`message ${row._id}: image skipped, delivering text only`);
    }
    const result = await this.deps.adapter.deliver(row.delivery_target, wrapForHandoff(row.content));
    if (result.kind === "ok") {
      this.handedOff.add(row._id);
      this.goneStrikes.delete(row.session_id);
      this.deps.log(`message ${row._id}: handed off to ${describe(row.delivery_target)}`);
      return await this.ack(row);
    }
    if (result.kind === "gone") {
      this.deps.log(`message ${row._id}: ${result.reason}; ending session ${row.session_id}`);
      await this.endSession(row.session_id);
      return;
    }
    this.deps.log(`message ${row._id}: ${result.kind} (${result.reason}); will retry`);
  }

  private async endSession(sessionId: string): Promise<void> {
    await this.deps.client.mutation("registeredSessions:markEnded", { session_id: sessionId, api_token: this.deps.apiToken });
    this.goneStrikes.delete(sessionId);
    this.rows = this.rows.filter((r) => r.session_id !== sessionId);
  }

  async sweep(): Promise<void> {
    let registered: Array<{ session_id: string; delivery_target: DeliveryTarget; short_id: string }>;
    try {
      registered = await this.deps.client.query("registeredSessions:registeredForDevice", this.auth());
    } catch (err) {
      this.deps.log(`sweep: could not list registered sessions: ${errorText(err)}`);
      return;
    }
    await Promise.all(registered.map(async (reg) => {
      const live = await this.deps.adapter.probe(reg.delivery_target, reg.session_id);
      if (live.kind !== "gone") {
        this.goneStrikes.delete(reg.session_id);
        return;
      }
      const strikes = (this.goneStrikes.get(reg.session_id) ?? 0) + 1;
      this.goneStrikes.set(reg.session_id, strikes);
      if (strikes < GONE_STRIKES_TO_END) {
        this.deps.log(`sweep: ${reg.short_id} looks gone (${live.reason}); confirming on the next sweep`);
        return;
      }
      try {
        await this.endSession(reg.session_id);
        this.deps.log(`sweep: ${reg.short_id} ended (${live.reason})`);
      } catch (err) {
        this.deps.log(`sweep: could not end ${reg.short_id}: ${errorText(err)}`);
      }
    }));
  }
}

function describe(target: DeliveryTarget): string {
  return target.kind === "herdr" ? `herdr pane ${target.pane}` : `paseo agent ${target.agent_id}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
