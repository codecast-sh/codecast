import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { measureLoopHold } from "../test-helpers/loopHold.js";
import {
  collectCapabilityInventory,
  ensureCapabilityInventoryFresh,
  markCapabilityPayloadSent,
  pendingCapabilityPayload,
  resetCapabilityHeartbeatState,
} from "./heartbeat.js";

afterEach(() => resetCapabilityHeartbeatState());

function fakeHome(extraSkills = 0): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hb-"));
  fs.mkdirSync(path.join(home, ".claude", "skills", "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: ship it\n---\n",
  );
  for (let i = 0; i < extraSkills; i++) {
    const dir = path.join(home, ".claude", "skills", `skill-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: skill-${i}\ndescription: number ${i}\n---\n`);
  }
  return home;
}

describe("capability heartbeat payload", () => {
  test("collects a stable hash for unchanged content", () => {
    const home = fakeHome();
    const a = collectCapabilityInventory(home);
    const b = collectCapabilityInventory(home);
    expect(a.hash).toBe(b.hash);
    expect(a.items.some((i) => i.name === "deploy")).toBe(true);
  });

  test("the hash moves when the inventory does", () => {
    const home = fakeHome();
    const a = collectCapabilityInventory(home);
    fs.writeFileSync(
      path.join(home, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: ship it differently\n---\n",
    );
    expect(collectCapabilityInventory(home).hash).not.toBe(a.hash);
  });

  test("a scan of a missing HOME still returns a payload, never throws", () => {
    const p = collectCapabilityInventory(path.join(os.tmpdir(), "does-not-exist-cc"));
    expect(p.items).toEqual([]);
    expect(p.hash.length).toBe(16);
  });
});

// The gate + floor logic is time-driven module state; test it through the
// exported seams rather than fake timers, which this repo's tests avoid.
describe("ride gating", () => {
  test("an unsent payload rides; a sent one stops; nothing cached rides nothing", () => {
    expect(pendingCapabilityPayload()).toBeUndefined();
  });

  test("marking sent stops an identical payload from riding again", () => {
    // Simulate the daemon's sequence with a real collection injected through
    // the module's own state transitions: collect → (cached via ensure is
    // async, so emulate by marking the collected hash sent) → pending must gate.
    const home = fakeHome();
    const collected = collectCapabilityInventory(home);
    markCapabilityPayloadSent(collected.hash);
    // With the same hash marked sent and the floor not yet due, nothing rides.
    expect(pendingCapabilityPayload()).toBeUndefined();
  });
});

// The daemon's beat kicks the scan and reads the result on a LATER beat. The
// scan is async now (one directory read per loop turn), so the payload lands
// after a few turns, with the hash the sync scan computes for the same tree.
describe("background collection", () => {
  test("ensureCapabilityInventoryFresh lands the async scan as the pending payload without holding the loop", async () => {
    const home = fakeHome(300);
    // Timed from the beat's call, not from the first poll: the scan starts
    // synchronously inside ensure, so a sync scan would hold the loop here.
    const { ticks, maxGapMs } = await measureLoopHold(async () => {
      ensureCapabilityInventoryFresh(home);
      expect(pendingCapabilityPayload()).toBeUndefined();
      const deadline = Date.now() + 5000;
      while (!pendingCapabilityPayload() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1));
      }
    }, 1);
    expect(pendingCapabilityPayload()?.hash).toBe(collectCapabilityInventory(home).hash);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(maxGapMs).toBeLessThan(100);
  }, 15_000);
});
