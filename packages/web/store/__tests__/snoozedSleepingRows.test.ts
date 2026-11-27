// Sleeping lists a snoozed row on its own unless it was snoozed with its
// parent; the open row is always listed, so the rail and the keyboard walk
// (both pass it) never lose the row being viewed.
import { expect, test } from "bun:test";
import { snoozedSleepingRows } from "../inboxNesting";
import type { InboxSession } from "../inboxStore";

const row = (id: string, parent?: string) =>
  ({ _id: id, is_subagent: !!parent, parent_conversation_id: parent, inbox_snoozed_until: 1 }) as unknown as InboxSession;
const parent = row("p");
const child = row("c", "p");
const loose = row("l", "elsewhere");

test("a child snoozed with its parent rides the parent", () => {
  expect(snoozedSleepingRows([parent, child, loose]).map((r) => r._id)).toEqual(["p", "l"]);
});

test("the open child is listed", () => {
  expect(snoozedSleepingRows([parent, child], "c").map((r) => r._id)).toEqual(["p", "c"]);
});
