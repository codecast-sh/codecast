import { expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

const detail = (id: string, short: string) => ({ _id: id, decision: { _id: id, short_id: short }, doc: null });

// A store-internal entry once replaced decisionDetails' registered isDelta with
// `{}`: each decision a page fed evicted the others, and the one on screen
// stayed "Loading the decision" (ct-59338 with its list's prefetch beside it).
test("two pages' decision details coexist: one decision's push never evicts another's", () => {
  const s = () => useInboxStore.getState();
  s().syncTable("decisionDetails", [detail("d_a", "sd-1")]);
  s().syncTable("decisionDetails", [detail("d_b", "sd-2")]);
  expect(Object.keys(s().decisionDetails).sort()).toEqual(["d_a", "d_b"]);
});
