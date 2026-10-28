import { describe, expect, test } from "bun:test";
import { formatTimeline } from "./timelineCommand";

describe("formatTimeline", () => {
  test("one line per event, the digest by project, then the cursor", () => {
    const at = Date.UTC(2026, 9, 27, 3, 36);
    const text = formatTimeline({
      events: [
        { id: "a", at, kind: "task_opened", by: "Cam", task: { short_id: "ct-1", title: "Fix the pitch", status: "open", project: "AgentWatch" } },
        { id: "b", at, kind: "task_closed", detail: "merged", into: "ct-9", task: { short_id: "ct-2", title: "Dup", status: "dropped" } },
        { id: "c", at, kind: "change_landed", detail: "abc1234567", task: { short_id: "ct-3", title: "Landed", status: "done" } },
      ],
      cursor: 42,
      landed_cursor: 41,
      digest: { in_progress: [{ project: "AgentWatch", count: 3, titles: ["Fix the pitch"] }], problems_opened: 7 },
    });
    expect(text).toBe([
      "2026-10-27 03:36  ct-1  opened by Cam  Fix the pitch  (AgentWatch)",
      "2026-10-27 03:36  ct-2  closed merged into ct-9  Dup",
      "2026-10-27 03:36  ct-3  landed abc1234567  Landed",
      "",
      "In progress (7 problems opened since the digest time):",
      "  AgentWatch: 3  Fix the pitch",
      "",
      "cursor 42  landed_cursor 41",
    ].join("\n"));
  });
});
