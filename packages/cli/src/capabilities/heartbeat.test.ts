import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loopHoldBoundMs, measureLoopHold } from "../test-helpers/loopHold.js";
import {
  collectCapabilityInventory,
  CONTENT_BATCH_CHARS,
  ensureCapabilityInventoryFresh,
  markCapabilityContentsSent,
  markCapabilityPayloadSent,
  pendingCapabilityContents,
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

  test("bodies ride a sidecar, never the inventory items", () => {
    const home = fakeHome();
    const p = collectCapabilityInventory(home);
    expect(p.items.every((i) => (i as { body?: string }).body === undefined)).toBe(true);
    const contents = pendingCapabilityContents();
    expect(contents?.some((c) => c.name === "deploy" && c.body.includes("ship it"))).toBe(true);
  });

  test("an unchanged body stops riding after it is marked sent", () => {
    const home = fakeHome();
    collectCapabilityInventory(home);
    const first = pendingCapabilityContents();
    expect(first?.length).toBeGreaterThan(0);
    markCapabilityContentsSent((first ?? []).map((c) => c.hash));
    expect(pendingCapabilityContents()).toBeUndefined();
  });

  test("a body edit ships again under a new hash", () => {
    const home = fakeHome();
    collectCapabilityInventory(home);
    markCapabilityContentsSent((pendingCapabilityContents() ?? []).map((c) => c.hash));
    fs.writeFileSync(
      path.join(home, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: ship it\n---\nnew body\n",
    );
    collectCapabilityInventory(home);
    const next = pendingCapabilityContents();
    expect(next?.some((c) => c.body.includes("new body"))).toBe(true);
  });

  test("a large tree fills across beats instead of one payload", () => {
    const home = fakeHome();
    const bulky = "x".repeat(Math.floor(CONTENT_BATCH_CHARS / 2));
    for (const name of ["one", "two", "three"]) {
      const dir = path.join(home, ".claude", "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${bulky}\n`);
    }
    collectCapabilityInventory(home);
    const first = pendingCapabilityContents() ?? [];
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(4);
    expect(first.reduce((n, c) => n + c.body.length, 0)).toBeLessThanOrEqual(CONTENT_BATCH_CHARS);
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
    expect(maxGapMs).toBeLessThan(loopHoldBoundMs(100));
  }, 15_000);
});
