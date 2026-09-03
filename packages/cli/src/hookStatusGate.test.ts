import { describe, expect, test } from "bun:test";
import { HookStatusGate } from "./hookStatusGate.js";

type Payload = { status: string; ts: number };

function makeGate() {
  const deferred: Array<[string, Payload]> = [];
  const gate = new HookStatusGate<Payload>((sessionId, data) => {
    deferred.push([sessionId, data]);
  });
  return { gate, deferred };
}

describe("hook status gate", () => {
  test("before a sink a status is deferred, not dropped", () => {
    const { gate, deferred } = makeGate();
    expect(gate.ready()).toBe(false);
    const data = { status: "working", ts: 42 };
    expect(gate.deliver("sess-1", data)).toBe("deferred");
    expect(deferred).toEqual([["sess-1", data]]);
  });

  test("after setSink the status goes to the sink and nothing is deferred", () => {
    const { gate, deferred } = makeGate();
    const seen: Array<[string, Payload]> = [];
    gate.setSink((sessionId, data) => seen.push([sessionId, data]));
    expect(gate.ready()).toBe(true);

    const data = { status: "idle", ts: 7 };
    expect(gate.deliver("sess-2", data)).toBe("delivered");
    expect(seen).toEqual([["sess-2", data]]);
    expect(deferred).toEqual([]);
  });

  test("a throwing sink does not take the request down, and still reports delivered", () => {
    const { gate, deferred } = makeGate();
    gate.setSink(() => {
      throw new Error("handler blew up");
    });
    expect(gate.deliver("sess-3", { status: "working", ts: 1 })).toBe("delivered");
    // The hook has already moved on; falling back to the file here would write
    // a record the handler may have half processed.
    expect(deferred).toEqual([]);
  });
});
