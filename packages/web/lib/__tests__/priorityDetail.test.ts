// A priority's `show` answer as the store keeps it (lib/priorityDetail).
import { expect, test } from "bun:test";
import { detailRowOf } from "../priorityDetail";

test("a teammate's priority the list does not hold keeps the server's rank on its base", () => {
  const show = {
    _id: "p9", short_id: "pri-9", title: "Theirs", mine: false, rank: 3, status: "active", workspace: "team:t1",
    steps: [{ key: "s1", title: "One", tier: "critical", refs: [], done: false, sessions: [] }],
    corrections: [], other_sessions: [], links: [], plan: null,
  } as any;
  expect(detailRowOf(show, undefined, undefined, 0).base?.rank).toBe(3);
});
