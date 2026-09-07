import { expect, it } from "bun:test";
import { applySyncPatch } from "./syncProtocol";
import type { PendingEntry } from "./types";

it("does not enumerate unrelated pending entries for a session overlay", () => {
  let scans = 0;
  const raw: Record<string, PendingEntry> = Object.fromEntries(
    Array.from({ length: 3015 }, (_, i) => [
      `tasks:${i}:status`, { type: "field", value: "done", ts: 1 },
    ]),
  );
  const pending = new Proxy(raw, {
    ownKeys(target) {
      scans++;
      return Reflect.ownKeys(target);
    },
  });
  for (let i = 0; i < 1950; i++) {
    const result = applySyncPatch("sessions", String(i), { agent_status: "working", is_idle: false }, [], pending);
    expect(result.pending).toBe(pending);
  }
  expect(scans).toBe(0);
});

it("copies pending only when an echo removes a lock", () => {
  const entry: PendingEntry = { type: "field", value: "idle", ts: 1 };
  const pending = {
    "sessions:a:agent_status": entry,
    "tasks:b:status": { type: "field" as const, value: "done", ts: 1 },
  };
  const result = applySyncPatch("sessions", "a", { agent_status: "idle" }, [], pending);
  expect(result.pending).not.toBe(pending);
  expect(result.pending["sessions:a:agent_status"]).toBeUndefined();
  expect(pending["sessions:a:agent_status"]).toBe(entry);
  expect(result.pending["tasks:b:status"]).toBe(pending["tasks:b:status"]);
});
