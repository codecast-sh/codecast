import { expect, test } from "bun:test";
import net from "node:net";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { recoveringWebSocket } from "@codecast/shared/network";

test("stalled handshakes close and a retained subscription recovers without replacing the client", async () => {
  let attempts = 0;
  let stalledClosed = 0;
  const sockets = new Set<net.Socket>();
  const endpoint = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.type !== "ModifyQuerySet") return;
        ws.send(JSON.stringify({
          type: "Transition",
          startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: 0 },
          endVersion: { querySet: message.newVersion, ts: "AQAAAAAAAAA=", identity: 0 },
          modifications: message.modifications.filter((m: { type: string }) => m.type === "Add").map((m: { queryId: number }) => ({
            type: "QueryUpdated", queryId: m.queryId, value: "recovered", logLines: [], journal: null,
          })),
        }));
      },
    },
  });
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    const stalled = ++attempts <= 2;
    socket.on("close", () => { sockets.delete(socket); if (stalled) stalledClosed++; });
    if (stalled) {
      socket.resume();
      return;
    }
    const upstream = net.connect(endpoint.port!, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as net.AddressInfo).port;
  const client = new ConvexClient(`http://127.0.0.1:${port}`, {
    webSocketConstructor: recoveringWebSocket({ timeoutMs: 500, completeMissingClose: true }), logger: false,
  });
  let unsubscribe: (() => void) | undefined;
  try {
    const query = makeFunctionReference<"query", Record<string, never>, string>("test:recovery");
    const result = new Promise((resolve) => { unsubscribe = client.onUpdate(query, {}, resolve); });
    expect(await Promise.race([result, Bun.sleep(10_000).then(() => "timed out")])).toBe("recovered");
    expect(attempts).toBe(3);
    expect(stalledClosed).toBe(2);
    expect(client.connectionState().isWebSocketConnected).toBe(true);
    await Bun.sleep(600);
    expect(client.connectionState().isWebSocketConnected).toBe(true);
  } finally {
    unsubscribe?.();
    const closing = client.close();
    for (const socket of sockets) socket.destroy();
    await closing;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    endpoint.stop(true);
  }
}, 15_000);

test("a missing native close event settles once and ignores a late native event", async () => {
  class SilentSocket extends EventTarget {
    static CONNECTING = 0;
    readyState = 0;
    close() { this.readyState = 2; }
  }
  const Recovering = recoveringWebSocket({ Native: SilentSocket as unknown as typeof WebSocket, timeoutMs: 10, completeMissingClose: true })!;
  const socket = new Recovering("ws://unused");
  const codes: number[] = [];
  socket.addEventListener("close", (event) => codes.push(event.code));
  await Bun.sleep(1_100);
  expect(codes).toEqual([1006]);
  socket.dispatchEvent(new Event("close"));
  expect(codes).toEqual([1006]);
});
