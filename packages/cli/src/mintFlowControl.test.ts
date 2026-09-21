import { expect, test } from "bun:test";
import { MintFlowControl, mintApprovalCode } from "./mintFlowControl";

test("late verification cannot store a token or finish a newer mint", async () => {
  const flow = new MintFlowControl();
  const first = flow.begin(1, true)!;
  let release!: () => void;
  const verifying = new Promise<void>(r => release = r);
  const writes: number[] = [];
  const finish = (async () => { await verifying; await flow.run(async () => { if (flow.current(first)) writes.push(first); }); })();
  const second = await flow.run(async () => flow.begin(2, true)!);
  release(); await finish;
  expect(writes).toEqual([]);
  expect(flow.current(second)).toBe(true);
  expect(flow.begin(2, true)).toBeNull();
});

test("a cancellation received before the delayed start fences that start", () => {
  const flow = new MintFlowControl();
  expect(flow.cancel(2)).toBe(true);
  expect(flow.begin(2, true)).toBeNull();
  const next = flow.begin(3, true)!;
  expect(flow.cancel(2)).toBe(false);
  expect(flow.current(next)).toBe(true);
});

test("pane replacement waits for the preceding kill; errors do not wedge the queue", async () => {
  const flow = new MintFlowControl();
  let release!: () => void;
  const killing = new Promise<void>(r => release = r);
  const events: string[] = [];
  const first = flow.run(async () => { events.push("kill"); await killing; throw new Error("closed"); });
  const rejected = first.catch(error => error.message);
  const second = flow.run(async () => { events.push("start"); });
  await Promise.resolve(); expect(events).toEqual(["kill"]);
  release(); expect(await rejected).toBe("closed"); await second;
  expect(events).toEqual(["kill", "start"]);
});

test("only a single approval code can be sent to the terminal", () => {
  expect(mintApprovalCode(" code_123#state-456 \n")).toBe("code_123#state-456");
  for (const value of ["abc\nexit", "abc\x1b[", "", "$(id)", "https://example.com", "x".repeat(4097)]) {
    expect(() => mintApprovalCode(value)).toThrow("approval code");
  }
});
