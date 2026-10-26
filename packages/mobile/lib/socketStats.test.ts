import { afterAll, expect, test } from "bun:test";

class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.dispatchEvent(new Event("close")); }
}
// The wrapper defaults to the global WebSocket; the fake stands in for this
// file only.
const realWebSocket = (globalThis as any).WebSocket;
(globalThis as any).WebSocket = Socket;
const { countingWebSocket, socketStats } = await import("./socketStats");
afterAll(() => {
  (globalThis as any).WebSocket = realWebSocket;
});

test("counts opens and messages without reading frame data, and sees held mutations", () => {
  const Counting = countingWebSocket()!;
  const socket = new Counting("ws://unused");
  expect(socketStats.lastConnectAt).toBeGreaterThan(0);
  socket.dispatchEvent(new Event("open"));
  expect(socketStats.opens).toBe(1);

  let reads = 0;
  const frame = (data: string) => Object.defineProperty(new Event("message"), "data", { get() { reads++; return data; } });
  socket.dispatchEvent(frame('{"type":"Transition"}'));
  expect(socketStats.messagesIn).toBe(1);
  expect(reads).toBe(0);

  for (let id = 0; id < 10; id++) socket.send(JSON.stringify({ type: "Mutation", requestId: id }));
  expect(socketStats.activeMutations).toBe(8);
  expect(socketStats.heldMutations).toBe(2);

  socket.close();
  expect(socketStats.activeMutations).toBe(0);
  expect(socketStats.heldMutations).toBe(0);
});
