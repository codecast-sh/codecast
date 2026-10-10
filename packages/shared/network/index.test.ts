import { expect, test } from "bun:test";
import { recoveringWebSocket } from "./index";

test("idle mutation bookkeeping skips reading query frames without hiding them from subscribers", () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    send(_data: string) {}
    close() { this.dispatchEvent(new Event("close")); }
  }
  const Recovering = recoveringWebSocket({ Native: Socket as unknown as typeof WebSocket })!;
  const socket = new Recovering("ws://unused");
  socket.dispatchEvent(new Event("open"));
  let reads = 0;
  let delivered = 0;
  socket.addEventListener("message", () => delivered++);
  const frame = (data: string) => Object.defineProperty(new Event("message"), "data", {
    get() { reads++; return data; },
  });
  socket.dispatchEvent(frame('{"type":"Transition"}'));
  expect(reads).toBe(0);
  socket.send('{"type":"Mutation","requestId":1}');
  socket.dispatchEvent(frame('{"type":"MutationResponse","requestId":1}'));
  expect(reads).toBe(1);
  socket.dispatchEvent(frame('{"type":"Transition"}'));
  expect(reads).toBe(1);
  expect(delivered).toBe(3);
  socket.close();
});
