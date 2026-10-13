import { EventEmitter } from "node:events";
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerWebSocket } from "bun";

const SOCKET_BUDGET = 65 * 1024 * 1024;
const SERVER_BUDGET = 256 * 1024 * 1024;

type Driver = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): number | void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};

type Upgrade = Response | ((socket: BridgeSocket) => void);

type Options = {
  port: number;
  maxPayload: number;
  fetch(request: Request): Promise<Response>;
  upgrade(request: Request): Upgrade;
  onOverflow?(detail: string): void;
  socketBudget?: number;
  serverBudget?: number;
};

export class BridgeSocket extends EventEmitter {
  private stopped = false;
  constructor(private driver: Driver, private owner: TransportState) {
    super();
    owner.sockets.add(this);
  }

  get readyState() { return this.stopped ? WebSocket.CLOSED : this.driver.readyState; }
  get bufferedAmount() { return this.driver.bufferedAmount; }

  send(data: string | Buffer, _options?: { binary: boolean }): void {
    if (this.readyState !== WebSocket.OPEN) return;
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    const buffered = this.owner.refresh(this);
    if (buffered + bytes > this.owner.socketBudget) {
      this.owner.overflow(this, `${buffered} bytes queued, ${bytes} byte frame`);
      return;
    }
    if (!this.owner.makeRoom(this, bytes)) return;
    const sent = this.driver.send(data);
    if (sent === 0) {
      this.owner.overflow(this, "transport refused a frame");
      return;
    }
    this.owner.sentBytes += bytes;
    this.owner.refresh(this);
    this.owner.peakBufferedBytes = Math.max(this.owner.peakBufferedBytes, this.owner.queuedBytes);
  }

  close(code?: number, reason?: string): void { this.driver.close(code, reason); }
  terminate(): void {
    this.stopped = true;
    this.driver.terminate();
    this.closed(1006, "");
  }
  closed(code: number, reason: string | Buffer): void {
    if (!this.owner.sockets.delete(this)) return;
    this.stopped = true;
    this.owner.record(this, 0);
    this.emit("close", code, reason);
  }
}

class TransportState {
  sockets = new Set<BridgeSocket>();
  private queued = new WeakMap<BridgeSocket, number>();
  queuedBytes = 0;
  overflows = 0;
  sentBytes = 0;
  peakBufferedBytes = 0;
  socketBudget: number;
  serverBudget: number;
  onOverflow: Options["onOverflow"];

  constructor(opts: Options) {
    this.socketBudget = opts.socketBudget ?? SOCKET_BUDGET;
    this.serverBudget = opts.serverBudget ?? SERVER_BUDGET;
    this.onOverflow = opts.onOverflow;
  }

  record(socket: BridgeSocket, bytes: number): number {
    this.queuedBytes += bytes - (this.queued.get(socket) ?? 0);
    this.queued.set(socket, bytes);
    return bytes;
  }

  refresh(socket: BridgeSocket): number { return this.record(socket, this.sockets.has(socket) ? socket.bufferedAmount : 0); }

  bufferedBytes(): number {
    for (const socket of this.sockets) this.refresh(socket);
    return this.queuedBytes;
  }

  overflow(socket: BridgeSocket, detail: string): void {
    this.overflows++;
    this.onOverflow?.(`closing slow bridge peer: ${detail}`);
    socket.terminate();
  }

  makeRoom(sender: BridgeSocket, bytes: number): boolean {
    if (this.queuedBytes + bytes <= this.serverBudget) return true;
    this.bufferedBytes();
    while (this.queuedBytes + bytes > this.serverBudget) {
      let largest: BridgeSocket | undefined;
      let largestBytes = 0;
      for (const socket of this.sockets) {
        const queued = this.queued.get(socket) ?? 0;
        if (queued > largestBytes) { largest = socket; largestBytes = queued; }
      }
      const victim = largest ?? sender;
      this.overflow(victim, `${largestBytes} bytes queued; whole-bridge queue budget reached`);
      if (victim === sender) return false;
    }
    return true;
  }

  stats() {
    return {
      sockets: this.sockets.size, bufferedBytes: this.bufferedBytes(),
      peakBufferedBytes: this.peakBufferedBytes, overflows: this.overflows, sentBytes: this.sentBytes,
      socketBudget: this.socketBudget, serverBudget: this.serverBudget,
    };
  }
}

export async function serveBridge(opts: Options) {
  const state = new TransportState(opts);
  if (typeof Bun !== "undefined") {
    type Peer = { accept: (socket: BridgeSocket) => void; socket?: BridgeSocket };
    const server = Bun.serve<Peer>({
      hostname: "127.0.0.1", port: opts.port, idleTimeout: 0,
      fetch(request, server) {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return opts.fetch(request);
        const decision = opts.upgrade(request);
        if (decision instanceof Response) return decision;
        if (server.upgrade(request, { data: { accept: decision } })) return;
        return new Response("bad upgrade\n", { status: 400 });
      },
      websocket: {
        maxPayloadLength: opts.maxPayload, backpressureLimit: state.socketBudget,
        closeOnBackpressureLimit: true, perMessageDeflate: false, idleTimeout: 0, sendPings: false,
        open(ws: ServerWebSocket<Peer>) {
          const socket = new BridgeSocket({
            get readyState() { return ws.readyState; },
            get bufferedAmount() { return ws.getBufferedAmount(); },
            send(data) { return ws.sendText(typeof data === "string" ? data : data.toString("utf8")); },
            close(code, reason) { ws.close(code, reason); },
            terminate() { ws.terminate(); },
          }, state);
          ws.data.socket = socket;
          ws.data.accept(socket);
        },
        message(ws, data) { ws.data.socket?.emit("message", typeof data === "string" ? Buffer.from(data) : data); },
        drain(ws) { if (ws.data.socket) state.refresh(ws.data.socket); },
        close(ws, code, reason) { ws.data.socket?.closed(code, reason); },
      },
    });
    return {
      stats: () => ({ runtime: "bun-native", ...state.stats() }),
      async close() {
        for (const socket of state.sockets) socket.terminate();
        void server.stop(true);
      },
    };
  }

  const requestFor = (req: http.IncomingMessage) => new Request(`http://127.0.0.1:${opts.port}${req.url ?? "/"}`, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  });
  const server = http.createServer((req, res) => {
    void opts.fetch(requestFor(req)).then(async response => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload, perMessageDeflate: false });
  server.on("upgrade", (req, stream, head) => {
    const decision = opts.upgrade(requestFor(req));
    if (decision instanceof Response) {
      stream.end(`HTTP/1.1 ${decision.status} ${decision.statusText || "Rejected"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, stream, head, ws => {
      const socket = new BridgeSocket({
        get readyState() { return ws.readyState; },
        get bufferedAmount() { return ws.bufferedAmount; },
        send(data) { ws.send(data, { binary: false }, () => state.refresh(socket)); },
        close(code, reason) { ws.close(code, reason); },
        terminate() { ws.terminate(); },
      }, state);
      ws.on("message", data => socket.emit("message", data));
      ws.on("close", (code, reason) => socket.closed(code, reason));
      ws.on("error", error => socket.emit("error", error));
      decision(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  return {
    stats: () => ({ runtime: "node-ws", ...state.stats() }),
    async close() {
      for (const socket of state.sockets) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
