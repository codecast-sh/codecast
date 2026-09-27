import { describe, expect, test } from "bun:test";
import { liveTriggersFor, pillsShown } from "../TriggerContextPanel";
import type { TaskRow } from "../triggerTasks";

// The strip above a conversation shows the triggers that are still live there.
// A session that has armed many triggers over its life carries a long tail of
// finished ones; the header once counted those as "12 more schedules" beside
// the three that could still fire.

const NOW = 1_700_000_000_000;
const HOME = "conv-home";

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  _id: id,
  title: id,
  prompt: id,
  status: "scheduled",
  schedule_type: "recurring",
  run_count: 0,
  created_at: NOW,
  ...over,
});

describe("liveTriggersFor", () => {
  test("keeps only armed triggers, soonest fire first, running on top", () => {
    const matched = [
      task("weekly", { run_at: NOW + 7 * 86_400_000, created_by_conversation_id: HOME }),
      task("done-1", { status: "completed", originating_conversation_id: HOME }),
      task("daily", { run_at: NOW + 86_400_000, originating_conversation_id: HOME }),
      task("done-2", { status: "cancelled", created_by_conversation_id: HOME }),
      task("paused", { status: "paused", originating_conversation_id: HOME }),
      task("live", { status: "running", originating_conversation_id: HOME }),
    ];
    expect(liveTriggersFor(matched, null, HOME).map((t) => t._id)).toEqual(["live", "daily", "weekly", "paused"]);
  });

  test("a live loop joins the set after the triggers", () => {
    const loop = task(HOME, { title: "loop" });
    const matched = [task("daily", { run_at: NOW + 1, originating_conversation_id: HOME })];
    expect(liveTriggersFor(matched, loop, HOME).map((t) => t._id)).toEqual(["daily", HOME]);
  });

  test("with nothing armed, only a trigger this session is a spawned run of remains", () => {
    const matched = [
      task("finished-home", { status: "completed", originating_conversation_id: HOME, last_run_conversation_id: HOME }),
      task("parent", { status: "completed", last_run_conversation_id: HOME }),
    ];
    expect(liveTriggersFor(matched, null, HOME).map((t) => t._id)).toEqual(["parent"]);
  });

  test("an inject trigger's runs landing in its home do not make the home a run", () => {
    const matched = [task("finished-home", { status: "completed", originating_conversation_id: HOME, last_run_conversation_id: HOME })];
    expect(liveTriggersFor(matched, null, HOME)).toEqual([]);
  });
});

describe("pillsShown", () => {
  const live = ["a", "b", "c", "d", "e", "f"].map((id) => task(id));

  test("up to four triggers each get a pill", () => {
    expect(pillsShown(live.slice(0, 4), undefined).map((t) => t._id)).toEqual(["a", "b", "c", "d"]);
  });

  test("past four, three pills and a fold", () => {
    expect(pillsShown(live, undefined).map((t) => t._id)).toEqual(["a", "b", "c"]);
  });

  test("the focused trigger keeps its pill past the fold", () => {
    expect(pillsShown(live, live[5]).map((t) => t._id)).toEqual(["a", "b", "f"]);
  });
});
