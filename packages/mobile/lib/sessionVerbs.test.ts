import { describe, expect, test } from "bun:test";
import type { TaskRow } from "@codecast/web/components/triggerTasks";
import { closeDetail, killReview } from "./sessionVerbs";

const NOW = 1_800_000_000_000;
const ID = "c".repeat(32);
const settled = { _id: ID, title: "Fix the sync", message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000, is_idle: true };
const trigger = (title: string, status = "scheduled"): TaskRow =>
  ({ _id: title, title, prompt: "", status, schedule_type: "recurring", originating_conversation_id: ID }) as TaskRow;

describe("the line under the menu's Close", () => {
  test("says the web tooltip's words without repeating Close", () => {
    expect(closeDetail(settled, [], NOW)).toBe("Stops it, clears it from the list");
  });

  test("counts the armed triggers from the store's roster", () => {
    const tasks = [trigger("Daily digest"), trigger("CI check"), trigger("Old one", "completed")];
    expect(closeDetail(settled, tasks, NOW)).toBe("Stops it, keeps its 2 triggers, comes back when one fires");
  });

  test("a role's own session closes without a retire question", () => {
    expect(closeDetail({ ...settled, standing_role_id: "r1" }, [], NOW)).toBe("Stops it, comes back on its next message");
  });

  test("a send this phone has not seen land is a turn starting: it is set aside", () => {
    expect(closeDetail(settled, [], NOW, true)).toBe("Hides it, lets it finish");
  });
});

describe("what Kill asks first", () => {
  test("nothing to cancel: no review, the kill goes behind the undo bar", () => {
    expect(killReview(settled, [trigger("Done", "completed")])).toBe(null);
  });

  test("names the triggers it cancels", () => {
    const r = killReview(settled, [trigger("Daily digest"), trigger("CI check")])!;
    expect(r.title).toBe("Kill session: Fix the sync");
    expect(r.message).toContain("Triggers: 2 triggers canceled (Daily digest, CI check)");
    expect(r.confirm).toBe("Kill it");
    expect(r.keep).toBe("Keep it");
  });

  test("names the queued messages it drops", () => {
    expect(killReview({ ...settled, has_pending: true }, [])!.message).toContain("Queued: Messages dropped");
  });

  test("names the turn it cuts off", () => {
    const r = killReview({ ...settled, is_idle: false }, [])!;
    expect(r.message).toContain("Lost: Unfinished turns");
    expect(r.keep).toBe("Keep running");
  });
});
