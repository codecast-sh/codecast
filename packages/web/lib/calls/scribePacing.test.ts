import { describe, expect, test } from "bun:test";
import { feedTargetsOf, storePacing } from "./scribePacing";

const now = Date.now();
const row = (id: string, status: string, name: string) => ({
  _id: id,
  agent_status: status,
  updated_at: now,
  last_heartbeat: now,
  agent_type: "claude_code",
  character_name: name,
});

describe("feedTargetsOf", () => {
  test("only session routes feed agents", () => {
    expect(
      feedTargetsOf({ routes: [{ kind: "session", target: "c1" }, { kind: "doc", target: "d1" }, { kind: "session", target: "c2" }] }),
    ).toEqual(["c1", "c2"]);
    expect(feedTargetsOf(null)).toEqual([]);
  });
});

describe("storePacing", () => {
  test("busy only while every fed agent is mid-turn", () => {
    const state = { sessions: { c1: row("c1", "working", "Ember"), c2: row("c2", "idle", "Moss") } };
    expect(storePacing(() => ["c1"], () => state).busy()).toBe(true);
    expect(storePacing(() => ["c1", "c2"], () => state).busy()).toBe(false);
    expect(storePacing(() => [], () => state).busy()).toBe(false);
  });

  test("follows targets added after the run began", () => {
    let targets: string[] = [];
    const state = { sessions: { c1: row("c1", "working", "Ember") } };
    const pacing = storePacing(() => targets, () => state);
    expect(pacing.busy()).toBe(false);
    targets = ["c1"];
    expect(pacing.busy()).toBe(true);
  });

  test("a line that names a fed agent addresses it", () => {
    const state = { sessions: { c1: row("c1", "working", "Ember") } };
    const pacing = storePacing(() => ["c1"], () => state);
    expect(pacing.addressed("Ember, can you check the deploy?")).toBe(true);
    expect(pacing.addressed("nice weather today")).toBe(false);
  });
});
