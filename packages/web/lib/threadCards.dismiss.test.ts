import { describe, expect, test } from "bun:test";
import { isDismissible, type ThreadCardModel } from "./threadCards";

// Which threads "Done" can archive.

describe("isDismissible", () => {
  const card = (kind: ThreadCardModel["kind"]): ThreadCardModel =>
    ({ id: kind, kind, chip: "task", activityAt: 0, unread: 1, href: "/", source: {} as any });
  test("thread_reads-backed kinds archive; projections of other state do not", () => {
    for (const k of ["chat", "comment", "code", "task", "page"] as const) expect(isDismissible(card(k))).toBe(true);
    for (const k of ["dm", "session", "question"] as const) expect(isDismissible(card(k))).toBe(false);
  });
});
