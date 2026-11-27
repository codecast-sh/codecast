// A priority's rename paints the row's title at once and rides dispatch to
// renamePriorityTitle (convex/dispatch.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { priorityWrites } from "../../lib/priorityWrites";

const ID = "p".repeat(32);
const store = () => useInboxStore.getState() as any;
const title = () => store().priorities[ID].title;

let calls: Array<[string, unknown[]]> = [];
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ priorities: { [ID]: { _id: ID, short_id: "pri-1", title: "Trusted evals", steps: [] } } } as any);
  store()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; });
});
afterEach(() => store()._clearRuntimeBindings());

test("renamePriority paints the title before the server answers and dispatches it (the server trims)", async () => {
  priorityWrites(() => {}).renamePriority("pri-1", "  Evals people trust ");
  expect(title()).toBe("Evals people trust");
  await Promise.resolve();
  expect(calls).toEqual([["renamePriorityTitle", ["pri-1", "  Evals people trust "]]]);
});
