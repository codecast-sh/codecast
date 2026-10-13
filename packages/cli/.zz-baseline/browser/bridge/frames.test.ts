import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { eventMessage, readEventFrame, readReplyFrame, replyId, replyMessage, TrafficMeter } from "./frames.js";

// What background.js send() puts on the wire: JSON.stringify of these literals.
const wire = (msg: unknown) => Buffer.from(JSON.stringify(msg));

describe("relay frames", () => {
  const params = { response: { payloadData: 'naïve “quoted” \\ {"nested":"}"} ✓ 🙂' }, n: [1, 2.5, -3], ok: null };

  test("an event is routed from its first bytes and its params pass through unchanged", () => {
    const ev = readEventFrame(wire({ op: "event", tabId: 4170, method: "Network.webSocketFrameReceived", params }))!;
    expect(ev.tabId).toBe(4170);
    expect(ev.method).toBe("Network.webSocketFrameReceived");
    expect(JSON.parse(String(ev.params))).toEqual(params);
    const out = JSON.parse(String(eventMessage(ev.method, ev.params, "ABC")));
    expect(out).toEqual({ method: "Network.webSocketFrameReceived", params, sessionId: "ABC" });
  });

  test("a successful reply keeps its result as bytes; errors and other shapes take the parsed path", () => {
    const r = readReplyFrame(wire({ id: 912, ok: true, result: params }))!;
    expect(r.id).toBe(912);
    expect(JSON.parse(String(replyMessage(r.id, r.result, "S1")))).toEqual({ id: 912, sessionId: "S1", result: params });
    expect(JSON.parse(String(replyMessage(7, Buffer.from("{}"))))).toEqual({ id: 7, result: {} });
    expect(readReplyFrame(wire({ id: 3, ok: false, error: "boom" }))).toBeNull();
    expect(replyId(wire({ id: 3, ok: false, error: "boom" }))).toBe(3);
    expect(readReplyFrame(wire({ id: 3, ok: true, tabs: [] }))).toBeNull();
  });

  test("anything not in the fixed shape is left to the parser", () => {
    expect(readEventFrame(wire({ tabId: 1, op: "event", method: "A.b", params: {} }))).toBeNull();
    expect(readEventFrame(wire({ op: "event", tabId: 1, params: {}, method: "A.b" }))).toBeNull();
    expect(readEventFrame(wire({ op: "tab", kind: "created", tab: {} }))).toBeNull();
    expect(readEventFrame(wire({ op: "event", tabId: "1", method: "A.b", params: {} }))).toBeNull();
    expect(readEventFrame(Buffer.from('{"op":"event","tabId":1,"method":"A\\"b","params":{}}'))).toBeNull();
    expect(replyId(wire({ op: "pong" }))).toBeNull();
  });
});

test("background.js still sends the two hot messages with the payload last", () => {
  // frames.ts slices the payload up to the closing brace, so a key added
  // after it would be relayed inside the payload. Change both together.
  const src = fs.readFileSync(path.join(import.meta.dir, "../../../../browser-extension/background.js"), "utf-8");
  expect(src).toContain('send({ op: "event", tabId: source.tabId, method, params: params || {} });');
  expect(src).toContain("send({ id: msg.id, ok: true, ...result });");
  expect(src).toContain("return { result: result || {} };");
});

describe("TrafficMeter", () => {
  test("reports a heavy window by method and receiving session, and stays quiet otherwise", () => {
    const lines: string[] = [];
    let now = 0;
    const m = new TrafficMeter((l) => lines.push(l), 60_000, 10 * 1024 * 1024, () => now);
    for (let i = 0; i < 30; i++) {
      m.note("Network.webSocketFrameReceived", 1024 * 1024);
      m.sent("env-a", 1024 * 1024);
    }
    m.note("Runtime.evaluate reply", 512 * 1024);
    expect(lines).toEqual([]);
    now = 61_000;
    m.note("Page.frameNavigated", 100);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Network.webSocketFrameReceived 30 MB x30");
    expect(lines[0]).toContain("to env-a 30 MB");
    // A light window that follows says nothing.
    now = 122_000;
    m.note("Page.frameNavigated", 100);
    expect(lines.length).toBe(1);
  });
});
