/**
 * CLI side of the resident driver: a `CdpClient` whose far end is the daemon
 * rather than Chrome. Everything above it (actions, snapshot, observe, batch)
 * cannot tell the difference, which is the point — the verbs keep their code
 * and lose their setup cost.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { hookPortFile as loopbackHookPortFile } from "../../loopbackIdentity.js";
import { CdpTimeout, type CdpClient, type CdpEvent, type EventHandler } from "../cdp.js";
import { reviveError } from "../recovery.js";
import {
  RESIDENT_PROTOCOL_VERSION, RESIDENT_WS_PATH, isWireEvent,
  type AttachResult, type HelloResult, type ResidentStatus, type TargetsResult, type WireCall, type WireMessage,
} from "./protocol.js";

/** Where the daemon writes its loopback port. loopbackIdentity.ts owns the path. */
export function hookPortFile(): string {
  return loopbackHookPortFile(path.join(process.env.HOME || os.homedir(), ".codecast"));
}

export function readHookPort(): number | null {
  try {
    const n = parseInt(fs.readFileSync(hookPortFile(), "utf-8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
}

export class ResidentClient implements CdpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<EventHandler>();
  private closed = false;
  hello!: HelloResult;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
    ws.on("error", () => {
      /* surfaced through close */
    });
  }

  /**
   * Connect to the daemon and exchange hellos. Fails fast — the whole reason
   * to go through the daemon is speed, so a daemon that is slow to answer is
   * not worth waiting for; the caller falls back to driving Chrome directly.
   */
  static async connect(port: number, timeoutMs = 700): Promise<ResidentClient> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}${RESIDENT_WS_PATH}`, {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024,
      });
      const timer = setTimeout(() => {
        sock.terminate();
        reject(new Error(`resident driver did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      sock.once("open", () => {
        clearTimeout(timer);
        resolve(sock);
      });
      // A persistent handler, not `once`: a refused connect can emit "error"
      // more than once, and an unhandled "error" event throws out of the event
      // loop — in a CLI that is a crash instead of a clean fallback.
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const client = new ResidentClient(ws);
    client.hello = await client.send<HelloResult>("cast.hello", {}, undefined, 8000);
    if (client.hello.version !== RESIDENT_PROTOCOL_VERSION) {
      client.close();
      throw new Error(`resident driver speaks protocol v${client.hello.version}, this CLI v${RESIDENT_PROTOCOL_VERSION}`);
    }
    return client;
  }

  private onMessage(raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (isWireEvent(msg)) {
      const ev: CdpEvent = msg.event;
      for (const h of this.handlers) {
        try {
          h(ev);
        } catch {
          /* a bad listener must not kill the socket */
        }
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(reviveError(msg.error));
    else p.resolve(msg.result);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection is not open (${method})`));
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      // The daemon enforces the timeout against Chrome; this one only guards
      // against the daemon itself going quiet, so it sits a little behind.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(method, timeoutMs));
      }, timeoutMs + 1500);
      const settle = <R>(fn: (v: R) => void) => (v: R) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      const call: WireCall = { id, method, params, sessionId, timeoutMs };
      this.ws.send(JSON.stringify(call));
    });
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  waitFor(predicate: (ev: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on((ev) => {
        if (!predicate(ev)) return;
        off();
        clearTimeout(timer);
        resolve(ev);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a CDP event`));
      }, timeoutMs);
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ cast.* verbs

  targets() {
    return this.send<TargetsResult>("cast.targets", {}, undefined, 8000).then((r) => r.targets);
  }

  attach(targetId: string) {
    // The daemon's own attach may wait out two enable rounds on a busy tab.
    return this.send<AttachResult>("cast.attach", { targetId }, undefined, 30_000);
  }

  detach(targetId: string) {
    return this.send<{ ok: boolean }>("cast.detach", { targetId }, undefined, 5000);
  }

  status() {
    return this.send<ResidentStatus>("cast.status", {}, undefined, 3000);
  }
}
