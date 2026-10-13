import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "../proc.js";
import { HeldConnections } from "./heldConnection.js";
import { AGENT_BRIDGE_TICK_MS } from "./agentBridge.js";

function fakeChild(): ChildProcess & { die: (code: number | null, stderr?: string) => void } {
  const c = new EventEmitter() as ChildProcess & { die: (code: number | null, stderr?: string) => void };
  (c as { stderr: EventEmitter }).stderr = new EventEmitter();
  c.die = (code, stderr) => {
    if (stderr) c.stderr!.emit("data", Buffer.from(stderr));
    c.emit("exit", code, null);
  };
  return c;
}

function setup() {
  let now = 1_000_000;
  const logs: string[] = [];
  const stopped: ChildProcess[] = [];
  const exits: Array<{ key: string; closedOnPurpose: boolean; refused: string | null }> = [];
  const held = new HeldConnections({
    tag: "[T]",
    log: (m) => logs.push(m),
    refusal: (code, key) => (code === 4 ? `refused ${key}` : null),
    stop: (c) => stopped.push(c),
    onExit: (key, i) => exits.push({ key, closedOnPurpose: i.closedOnPurpose, refused: i.refused }),
    now: () => now,
  });
  return { held, logs, stopped, exits, advance: (ms: number) => { now += ms; } };
}

describe("HeldConnections", () => {
  test("a fast failure backs off a tick, then doubles; a connection that lived starts over", () => {
    const { held, advance } = setup();
    let c = fakeChild();
    held.hold("k", "conn k", "1.2.3.4", c);
    expect(held.canOpen("k")).toBe(false);
    c.die(255, "Connection reset\n");
    expect(held.canOpen("k")).toBe(false);
    advance(AGENT_BRIDGE_TICK_MS);
    expect(held.canOpen("k")).toBe(true);
    c = fakeChild();
    held.hold("k", "conn k", "1.2.3.4", c);
    c.die(255);
    advance(AGENT_BRIDGE_TICK_MS);
    expect(held.canOpen("k")).toBe(false);
    advance(AGENT_BRIDGE_TICK_MS);
    expect(held.canOpen("k")).toBe(true);
    c = fakeChild();
    held.hold("k", "conn k", "1.2.3.4", c);
    advance(10 * AGENT_BRIDGE_TICK_MS);
    c.die(255);
    expect(held.canOpen("k")).toBe(false);
    advance(AGENT_BRIDGE_TICK_MS);
    expect(held.canOpen("k")).toBe(true);
  });

  test("a reserved exit refuses until forgotten", () => {
    const { held, exits } = setup();
    const c = fakeChild();
    held.hold("k", "conn k", "a", c);
    c.die(4);
    expect(held.refusedReason("k")).toBe("refused k");
    expect(held.canOpen("k")).toBe(false);
    expect(exits).toEqual([{ key: "k", closedOnPurpose: false, refused: "refused k" }]);
    held.forget("k");
    expect(held.canOpen("k")).toBe(true);
  });

  test("close stops the child and its exit neither backs off nor counts as a failure", () => {
    const { held, stopped, exits } = setup();
    const c = fakeChild();
    held.hold("k", "conn k", "a", c);
    held.close("k", "turned off");
    expect(stopped).toEqual([c]);
    expect(held.get("k")).toBeUndefined();
    c.die(null);
    expect(held.canOpen("k")).toBe(true);
    expect(exits[0]!.closedOnPurpose).toBe(true);
  });

  test("an old connection exiting after its replacement opened leaves the replacement alone", () => {
    const { held } = setup();
    const old = fakeChild();
    held.hold("k", "conn k", "a", old);
    held.close("k", "address changed");
    const next = fakeChild();
    held.hold("k", "conn k", "b", next);
    old.die(255);
    expect(held.get("k")?.child).toBe(next);
  });
});
