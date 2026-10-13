import { describe, expect, test } from "bun:test";
import { formatMachineSwitchNotice } from "@codecast/shared/contracts";
import { classifyUserMessage } from "../components/conversation/classify";
import type { Message, TimelineItem, UserMessageKind } from "../components/conversation/types";
import { foldMachineMove } from "./useTimelineTurns";

const row = (id: string, role: "user" | "assistant", content: string): TimelineItem =>
  ({ type: "message", data: { _id: id, role, content, timestamp: 0 } as unknown as Message }) as TimelineItem;

function fold(timeline: TimelineItem[]) {
  const kinds = new Map<string, UserMessageKind>();
  for (const item of timeline) {
    const m = item.data as Message;
    if (m.role === "user") kinds.set(m._id, classifyUserMessage(m, "claude_code", null, null));
  }
  const consumed = new Set<string>();
  const extra = new Map<string, string>();
  foldMachineMove(timeline, 0, kinds, consumed, extra);
  return { kinds, consumed, extra };
}

const SHORT = formatMachineSwitchNotice({ toLabel: "Cloud Linux", fromLabel: "MacBook-Pro-182" });
const LONG = "[codecast] This session just moved to a different machine. It now runs on ubuntu@host in /home/ubuntu/src/app (previously /Users/a/src/app).";
const STOPPED = `<task-notification>
<task-id>w2y717k0s</task-id>
<status>stopped</status>
<summary>Background workflow "polish" didn't finish before the previous session ended</summary>
</task-notification>`;

describe("foldMachineMove", () => {
  // jx758nr: the resumed CLI reported the workflow the move stopped between the
  // two notices, and the timeline showed one move as two dividers.
  test("one move stays one divider across the stopped-task notice", () => {
    const { kinds, consumed, extra } = fold([row("a", "user", SHORT), row("b", "user", STOPPED), row("c", "user", LONG)]);
    expect(kinds.get("b")?.kind).toBe("task_notification");
    expect(consumed.has("c")).toBe(true);
    expect(extra.get("a")).toBe(LONG);
  });

  test("a human message ends the run", () => {
    const { consumed } = fold([row("a", "user", SHORT), row("b", "user", "continue"), row("c", "user", LONG)]);
    expect(consumed.size).toBe(0);
  });

  test("an assistant turn ends the run", () => {
    const { consumed } = fold([row("a", "user", SHORT), row("b", "assistant", "ok"), row("c", "user", LONG)]);
    expect(consumed.size).toBe(0);
  });
});
