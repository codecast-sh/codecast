import { expect, test } from "bun:test";
import { createPendingDeliveryBatches } from "./pendingDeliveryBatches";
import { isMachineDeliveredMessage } from "@codecast/shared/contracts";

test("production message content prioritizes direct requests without a human field", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const dispatch = createPendingDeliveryBatches<{ conversation_id: string; content: string }>(async rows => {
    started.push(rows[0].conversation_id);
    await gate;
  }, message => !isMachineDeliveredMessage(message.content));
  const background = Array.from({ length: 20 }, (_, i) => ({ conversation_id: String(i), content: '<scheduled-task title="Check">Check progress</scheduled-task>' }));
  const run = dispatch([...background, { conversation_id: "human", content: "Please continue my work" }]);
  await Bun.sleep(0);
  expect(started).toHaveLength(8);
  expect(started[0]).toBe("human");
  release();
  await run;
});

test("a stalled conversation does not block a human message in another conversation", async () => {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const dispatch = createPendingDeliveryBatches<{ conversation_id: string; human?: boolean; content: string }>(async rows => {
    calls.push(rows.map(row => row.content));
    if (rows[0].conversation_id === "old") await stalled;
  });
  const rows = [
    { conversation_id: "old", content: "background" },
    { conversation_id: "new", content: "first", human: true },
    { conversation_id: "new", content: "second", human: true },
  ];
  const first = dispatch(rows);
  await Bun.sleep(0);
  expect(calls).toEqual([["first", "second"], ["background"]]);
  await dispatch([rows[0]]);
  expect(calls).toHaveLength(2);
  release();
  await first;
  await dispatch([rows[0]]);
  expect(calls).toHaveLength(3);
});

test("overlapping scans share one concurrency limit", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const dispatch = createPendingDeliveryBatches(async () => { started++; await gate; });
  const run = dispatch(Array.from({ length: 30 }, (_, i) => ({ conversation_id: String(i) })));
  const overlap = dispatch(Array.from({ length: 10 }, (_, i) => ({ conversation_id: String(i + 30) })));
  await Bun.sleep(0);
  expect(started).toBe(8);
  release();
  await Promise.all([run, overlap]);
  expect(started).toBe(40);
});

test("a failed batch releases its slot and does not strand queued conversations", async () => {
  let calls = 0;
  const dispatch = createPendingDeliveryBatches(async () => { calls++; throw new Error("offline"); });
  const rows = Array.from({ length: 20 }, (_, i) => ({ conversation_id: String(i) }));
  await expect(dispatch(rows)).rejects.toThrow("Pending delivery batches failed");
  expect(calls).toBe(20);
  await expect(dispatch(rows)).rejects.toThrow("Pending delivery batches failed");
  expect(calls).toBe(40);
});
