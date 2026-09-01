import { describe, expect, it } from "bun:test";
import { cleanPromptSliceTitle, groupSessionsByTrigger, isTriggerFailing, latestLoadedTriggerMessage, partitionTriggerInbox, taskDisplayTitle, type TaskRow } from "./triggerTasks";
import { isSessionHardBlocked, type InboxSession } from "../store/inboxStore";
import { orderSections } from "../store/__tests__/placeTestHarness";

describe("taskDisplayTitle / cleanPromptSliceTitle", () => {
  it("prefers the haiku display_title", () => {
    expect(taskDisplayTitle({ display_title: "Growth blocker sweep", title: "MATCH/INTRO GROWTH WATCH (pl-126). ALL fixable blockers CLEA" })).toBe("Growth blocker sweep");
  });

  it("trims a dangling parenthetical from a slice title", () => {
    expect(cleanPromptSliceTitle("Check the deploy status and report back to the thread (sha 9")).toBe("Check the deploy status and report back to the thread");
  });

  it("drops a cut-off trailing word only at slice width", () => {
    // 60-char slice ending mid-word
    const sliced = "Verify the dashboards and alerting pipeline for the whole se";
    expect(sliced.length).toBe(61 - 1);
    expect(cleanPromptSliceTitle(sliced)).toBe("Verify the dashboards and alerting pipeline for the whole");
    // short explicit titles are untouched
    expect(cleanPromptSliceTitle("CI watch")).toBe("CI watch");
  });

  it("never returns empty", () => {
    expect(cleanPromptSliceTitle("(unclosed fragment")).toBe("(unclosed fragment");
  });
});

// The schedule → inbox projection under the synthesis model: one row per armed
// schedule, sessions absorbed behind rows (resting loop homes + uneventful
// runs), and escalation — anything needing a human stays a loose triage card.

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: Date.now(),
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

// A machine-delivered last turn (scheduled injection) — loops rest only then.
const MACHINE_TURN = '<scheduled-task title="t" task-id="x">go</scheduled-task>';

const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  _id: id,
  title: `Task ${id}`,
  prompt: "do the thing",
  status: "scheduled",
  schedule_type: "recurring",
  interval_ms: 3_600_000,
  run_at: Date.now() + 3_600_000,
  run_count: 1,
  created_at: Date.now() - 86_400_000,
  ...extra,
});

describe("isTriggerFailing", () => {
  it("is failing when the last run failed", () => {
    expect(isTriggerFailing(task("t1", { last_run_failed: true, retry_count: 1 }))).toBe(true);
  });

  it("is NOT failing when the last run succeeded", () => {
    expect(isTriggerFailing(task("t2", { last_run_failed: false, retry_count: 0 }))).toBe(false);
  });

  // The bug this pins: a trigger that failed once and has since recovered kept a
  // non-zero retry_count, so every surface keying on that counter called it
  // "retrying" forever — while its latest run was a clean success. Health is the
  // last run's outcome, never the streak history.
  it("a recovered trigger is healthy even if a stale retry_count survives", () => {
    expect(isTriggerFailing(task("t3", { last_run_failed: false, retry_count: 3 }))).toBe(false);
  });

  it("treats a never-run trigger as healthy", () => {
    expect(isTriggerFailing(task("t4"))).toBe(false);
  });
});

describe("latestLoadedTriggerMessage", () => {
  const msg = (id: string, role: string, content: string | undefined, timestamp: number) =>
    ({ _id: id, role, content, timestamp });

  it("finds the NEWEST firing of the given task, skipping other tasks and non-user rows", () => {
    const messages = [
      msg("m1", "user", '<scheduled-task title="CI watch" task-id="task_a">check ci</scheduled-task>', 100),
      msg("m2", "assistant", 'echoing task-id="task_a" in prose', 200),
      msg("m3", "user", '<scheduled-task title="Other" task-id="task_b">other</scheduled-task>', 300),
      msg("m4", "user", '<scheduled-task title="CI watch" task-id="task_a">check ci</scheduled-task>', 400),
      msg("m5", "user", "a human turn", 500),
    ];
    expect(latestLoadedTriggerMessage(messages, "task_a")).toEqual({ messageId: "m4", timestamp: 400 });
    expect(latestLoadedTriggerMessage(messages, "task_b")).toEqual({ messageId: "m3", timestamp: 300 });
  });

  it("returns undefined when the window holds no firing (unloaded, contentless, or wrong task)", () => {
    expect(latestLoadedTriggerMessage(undefined, "task_a")).toBeUndefined();
    expect(latestLoadedTriggerMessage([], "task_a")).toBeUndefined();
    expect(latestLoadedTriggerMessage([msg("m1", "user", undefined, 100)], "task_a")).toBeUndefined();
    expect(
      latestLoadedTriggerMessage([msg("m1", "user", '<scheduled-task task-id="task_b">x</scheduled-task>', 100)], "task_a"),
    ).toBeUndefined();
  });
});

describe("partitionTriggerInbox rows", () => {
  it("gives every armed schedule exactly one row — inject, spawn, once, event alike", () => {
    const p = partitionTriggerInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "conv", schedule_type: "once" }),
        task("spawn", {}),
        task("done", { status: "completed" }),
      ],
      { home: session("home"), conv: session("conv") },
    );
    expect(p.rows.map((r) => r.task._id).sort()).toEqual(["loop", "once", "spawn"]);
  });

  it("sorts soonest fire first; paused sinks to the bottom", () => {
    const now = Date.now();
    const p = partitionTriggerInbox(
      [
        task("late", { run_at: now + 9_000_000 }),
        task("soon", { run_at: now + 60_000 }),
        task("paused", { status: "paused", run_at: now + 1 }),
      ],
      {},
    );
    expect(p.rows.map((r) => r.task._id)).toEqual(["soon", "late", "paused"]);
    expect(p.nextRunAt).toBe(now + 60_000);
  });

  it("puts a live (running) schedule at the very top, above sooner-scheduled ones", () => {
    const now = Date.now();
    const p = partitionTriggerInbox(
      [
        task("soon", { run_at: now + 60_000 }),
        task("live", { status: "running", run_at: now + 5_000_000 }),
        task("paused", { status: "paused", run_at: now + 1 }),
      ],
      {},
    );
    expect(p.rows.map((r) => r.task._id)).toEqual(["live", "soon", "paused"]);
  });

  it("counts unread outcomes against the watermark", () => {
    const now = Date.now();
    const p = partitionTriggerInbox(
      [
        task("new", { last_run_at: now - 1000 }),
        task("old", { last_run_at: now - 100_000 }),
        task("never", { last_run_at: undefined }),
      ],
      {},
      { seenAt: now - 50_000 },
    );
    expect(p.unreadCount).toBe(1);
    expect(p.rows.find((r) => r.task._id === "new")?.unread).toBe(true);
    expect(p.rows.find((r) => r.task._id === "old")?.unread).toBe(false);
  });
});

describe("absorption (behind-the-row) rules", () => {
  it("a resting loop home is absorbed; a once follow-up absorbs only a home settled in Done", () => {
    const sessions = {
      home: session("home", { last_user_message: MACHINE_TURN }),
      // Unclassified settle — the ball is still the human's, so the reminder
      // must not hide the card.
      conv: session("conv", { last_user_message: MACHINE_TURN }),
      // Delivered (declared done, no daemon status) + a named wake = parked.
      doneHome: session("doneHome", { last_user_message: MACHINE_TURN, thread_state_status: "done" }),
    };
    const p = partitionTriggerInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "conv", schedule_type: "once" }),
        task("onceDone", { originating_conversation_id: "doneHome", schedule_type: "once" }),
      ],
      sessions,
    );
    expect(p.absorbedIds.has("home")).toBe(true);
    expect(p.absorbedIds.has("conv")).toBe(false);
    expect(p.absorbedIds.has("doneHome")).toBe(true);
  });

  it("human-typed last turn, pinned, or hard-blocked homes are never absorbed", () => {
    const sessions = {
      human: session("human", { last_user_message: "hey can you check something" }),
      pinned: session("pinned", { is_pinned: true, last_user_message: MACHINE_TURN }),
      blocked: session("blocked", { agent_status: "permission_blocked", last_user_message: MACHINE_TURN }),
    };
    const p = partitionTriggerInbox(
      [
        task("t1", { originating_conversation_id: "human" }),
        task("t2", { originating_conversation_id: "pinned" }),
        task("t3", { originating_conversation_id: "blocked" }),
      ],
      sessions,
    );
    expect(p.absorbedIds.size).toBe(0);
    expect(p.rows).toHaveLength(3); // rows exist regardless — only absorption is conditional
  });

  it("the focused session is never absorbed — loop home or spawn run alike", () => {
    // Deep-linking into a resting loop home: its card must stay in the list so
    // selection highlight and auto-scroll have something to land on.
    const sessions = {
      home: session("home", { last_user_message: MACHINE_TURN }),
      run: session("run", { agent_task_id: "sp" }),
    };
    const focusedHome = partitionTriggerInbox(
      [task("loop", { originating_conversation_id: "home" }), task("sp", {})],
      sessions,
      { focusedId: "home" },
    );
    expect(focusedHome.absorbedIds.has("home")).toBe(false);
    expect(focusedHome.absorbedIds.has("run")).toBe(true);

    const focusedRun = partitionTriggerInbox(
      [task("loop", { originating_conversation_id: "home" }), task("sp", {})],
      sessions,
      { focusedId: "run" },
    );
    expect(focusedRun.absorbedIds.has("home")).toBe(true);
    expect(focusedRun.absorbedIds.has("run")).toBe(false);
  });

  it("uneventful spawn runs absorb; hard-blocked or flagged-latest runs escalate", () => {
    const sessions = {
      quiet: session("quiet", { agent_task_id: "sp", updated_at: 100 }),
      blocked: session("blocked", { agent_task_id: "sp", agent_status: "permission_blocked" }),
      latest: session("latest", { agent_task_id: "sp", updated_at: 5000 }),
    };
    const p = partitionTriggerInbox(
      [task("sp", { last_run_conversation_id: "latest", last_run_needs_attention: true })],
      sessions,
    );
    expect(p.absorbedIds.has("quiet")).toBe(true);
    expect(p.absorbedIds.has("blocked")).toBe(false);
    expect(p.absorbedIds.has("latest")).toBe(false);
  });

  it("a loop home with a flagged latest run (failed / needs-attention) escapes absorption", () => {
    const sessions = {
      flagged: session("flagged", { last_user_message: MACHINE_TURN }),
      failed: session("failed", { last_user_message: MACHINE_TURN }),
      resting: session("resting", { last_user_message: MACHINE_TURN }),
    };
    const p = partitionTriggerInbox(
      [
        task("t1", { originating_conversation_id: "flagged", last_run_needs_attention: true }),
        task("t2", { originating_conversation_id: "failed", last_run_failed: true }),
        task("t3", { originating_conversation_id: "resting" }),
      ],
      sessions,
    );
    expect(p.absorbedIds.has("flagged")).toBe(false);
    expect(p.absorbedIds.has("failed")).toBe(false);
    expect(p.absorbedIds.has("resting")).toBe(true);
  });

  it("row openId prefers home conv (inject) / newest absorbed run, falling back to last recorded run", () => {
    const sessions = {
      home: session("home"),
      r1: session("r1", { agent_task_id: "sp", updated_at: 1000 }),
      r2: session("r2", { agent_task_id: "sp", updated_at: 2000 }),
    };
    const p = partitionTriggerInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("sp", {}),
        task("neverrun", { last_run_conversation_id: "folded" }),
      ],
      sessions,
    );
    const byId = Object.fromEntries(p.rows.map((r) => [r.task._id, r]));
    expect(byId["loop"].openId).toBe("home");
    expect(byId["sp"].openId).toBe("r2");
    expect(byId["neverrun"].openId).toBe("folded");
  });

  it("armedInjectByConv maps every armed inject schedule (once included) for the kill toast", () => {
    const p = partitionTriggerInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "home", schedule_type: "once" }),
      ],
      { home: session("home") },
    );
    expect(p.armedInjectByConv.get("home")?.map((t) => t._id)).toEqual(["loop", "once"]);
  });
});

describe("isSessionHardBlocked", () => {
  it("blocks on poll, permission prompt, api error, and dead-with-messages — not a plain finished turn", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }))).toBe(true);
    expect(isSessionHardBlocked(session("b", { agent_status: "permission_blocked" }))).toBe(true);
    expect(isSessionHardBlocked(session("c", { pending_api_error: true } as Partial<InboxSession>))).toBe(true);
    expect(isSessionHardBlocked(session("d", { agent_status: "stopped" }))).toBe(true);
    expect(isSessionHardBlocked(session("e", { is_idle: true }))).toBe(false);
  });

  it("a queued outbound message means the user already acted", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }), new Set(["a"]))).toBe(false);
  });
});

describe("an armed trigger's resting home in the walk (the armed_trigger_kind fact)", () => {
  // Trigger absorption is no longer a nav/panel pass over the trigger
  // subscription: the home's armed_trigger_kind reaches the shared classifier
  // as data (identically on every replica), so a resting standing home files
  // DORMANT — it leaves Needs Input but stays reachable by Ctrl+J/K at the
  // end, where the panel renders it. Nothing vanishes from the walk.
  const sessions: Record<string, InboxSession> = {
    resting: session("resting", { is_idle: true, armed_trigger_kind: "standing", last_turn_allows_park: true }),
    ni: session("ni", { is_idle: true }),
    parked: session("parked", { is_idle: true, agent_status: "dormant" }),
  };

  it("walks the resting home with the DORMANT section, after the triage buckets", () => {
    const order = orderSections(sessions, new Set(), null, new Set(), {}).map((s) => s._id);
    expect(order[0]).toBe("ni");
    expect(order.slice(1).sort()).toEqual(["parked", "resting"]);
    // …and a collapsed Dormant section hides it from the walk.
    const collapsed = orderSections(sessions, new Set(), null, new Set(), {
      collapsedSections: { dormant: true },
    }).map((s) => s._id);
    expect(collapsed).toEqual(["ni"]);
  });

  it("a home whose last turn was a human's is NOT parked — the human is triaging it", () => {
    const order = orderSections(
      { ...sessions, resting: { ...sessions.resting, last_turn_allows_park: false } },
      new Set(), null, new Set(), { collapsedSections: { dormant: true } },
    ).map((s) => s._id);
    expect(order.sort()).toEqual(["ni", "resting"]);
  });
});

// Pseudo rows: harness loops (ScheduleWakeup) projected into the trigger set.
// See loopTaskRow in triggerTasks.
describe("loop pseudo rows", () => {
  const NOW = Date.now();
  const loop = (extra: Record<string, unknown> = {}) => ({
    status: "armed" as const,
    wakeup_at: NOW + 20 * 60_000,
    armed_at: NOW - 60_000,
    event_at: NOW - 60_000,
    reason: "watching CI run",
    prompt: "/loop check ci",
    ...extra,
  });

  it("an armed loop rows into the trigger set and absorbs its idle home", () => {
    const p = partitionTriggerInbox(undefined, { home: session("home", { loop_state: loop() }) }, { now: NOW });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].kind).toBe("loop");
    expect(p.rows[0].openId).toBe("home");
    expect(p.rows[0].task.status).toBe("scheduled");
    expect(p.rows[0].task.run_at).toBe(NOW + 20 * 60_000);
    expect(p.rows[0].task.title).toBe("watching CI run");
    expect(p.absorbedIds.has("home")).toBe(true);
    expect(p.nextRunAt).toBe(NOW + 20 * 60_000);
  });

  it("a human-engaged home (working, still armed) keeps its triage card", () => {
    const p = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop(), is_idle: false, agent_status: "working" }) },
      { now: NOW },
    );
    expect(p.rows).toHaveLength(1);
    expect(p.absorbedIds.has("home")).toBe(false);
  });

  it("a waking loop (machine's own turn) stays absorbed and reads running", () => {
    const p = partitionTriggerInbox(
      undefined,
      {
        home: session("home", {
          loop_state: loop({ status: "waking", fired_at: NOW - 30_000 }),
          is_idle: false,
          agent_status: "working",
        }),
      },
      { now: NOW },
    );
    expect(p.rows[0].task.status).toBe("running");
    expect(p.absorbedIds.has("home")).toBe(true);
  });

  it("a long-overdue armed wakeup is a dead harness — no row, no absorption", () => {
    const p = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop({ wakeup_at: NOW - 20 * 60_000 }) }) },
      { now: NOW },
    );
    expect(p.rows).toHaveLength(0);
    expect(p.absorbedIds.size).toBe(0);
  });

  it("dismissing the home retires its loop row; stash keeps it", () => {
    const dismissed = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop(), inbox_dismissed_at: NOW }) },
      { now: NOW },
    );
    expect(dismissed.rows).toHaveLength(0);
    const stashed = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop(), inbox_stashed_at: NOW }) },
      { now: NOW },
    );
    expect(stashed.rows).toHaveLength(1);
    // Already out of triage — absorption is moot for a hidden session.
    expect(stashed.absorbedIds.has("home")).toBe(false);
  });

  // The killSession mutation (the web's convCommand path) stamps
  // inbox_killed_at WITHOUT inbox_dismissed_at, so a home killed that way kept
  // a loop row for a harness that no longer exists. Stash must still keep its
  // row — it is the standing-loop home, which is why this gate deliberately
  // isn't isSessionHidden. ct-41083.
  it("killing the home retires its loop row too, while stash still keeps it", () => {
    const killed = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop(), inbox_killed_at: NOW }) },
      { now: NOW },
    );
    expect(killed.rows).toHaveLength(0);
    const stashed = partitionTriggerInbox(
      undefined,
      { home: session("home", { loop_state: loop(), inbox_stashed_at: NOW }) },
      { now: NOW },
    );
    expect(stashed.rows).toHaveLength(1);
  });

  it("the focused home is never absorbed", () => {
    const p = partitionTriggerInbox(undefined, { home: session("home", { loop_state: loop() }) }, { now: NOW, focusedId: "home" });
    expect(p.rows).toHaveLength(1);
    expect(p.absorbedIds.has("home")).toBe(false);
  });

  // Regression: subagents are transient labor, not standing triggers — a
  // running worker must never appear in the roster (a five-agent review
  // fan-out was stacking five "running" rows above every real trigger). It
  // already renders nested under its parent session's card.
  it("a live subagent never gets a trigger row", () => {
    const p = partitionTriggerInbox(
      undefined,
      {
        live: session("live", { is_subagent: true, is_idle: false, agent_status: "working", updated_at: NOW }),
        done: session("done", { is_subagent: true, is_idle: true }),
      },
      { now: NOW },
    );
    expect(p.rows).toHaveLength(0);
  });

  it("a subagent sleeping on its own loop still rows in as the loop", () => {
    const p = partitionTriggerInbox(
      undefined,
      {
        sub: session("sub", {
          is_subagent: true,
          loop_state: loop({ status: "waking", fired_at: NOW - 30_000 }),
          is_idle: false,
          agent_status: "working",
          updated_at: NOW,
        }),
      },
      { now: NOW },
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].kind).toBe("loop");
  });

  it("loop rows compose with real trigger rows and sort by soonest fire", () => {
    const p = partitionTriggerInbox(
      [task("t1", { run_at: NOW + 3_600_000 })],
      { home: session("home", { loop_state: loop() }) },
      { now: NOW },
    );
    // Soonest fire first (the loop at +20m), then t1 at +1h.
    expect(p.rows.map((r) => r.kind ?? "trigger")).toEqual(["loop", "trigger"]);
  });
});

// The "By trigger" lens: roster rows become group headers, each claiming the
// sessions it drives; unclaimed sessions return as `rest` for the project tier.
describe("groupSessionsByTrigger", () => {
  const row = (t: TaskRow, kind?: "loop") => ({ task: t, unread: false, kind });

  it("an inject trigger claims its home conversation", () => {
    const home = session("home");
    const other = session("other");
    const { triggerGroups, rest } = groupSessionsByTrigger(
      [row(task("t1", { originating_conversation_id: "home" }))],
      [home, other],
    );
    expect(triggerGroups).toHaveLength(1);
    expect(triggerGroups[0].items.map((s) => s._id)).toEqual(["home"]);
    expect(rest.map((s) => s._id)).toEqual(["other"]);
  });

  it("a spawn trigger claims its runs, newest activity first", () => {
    const run1 = session("run1", { agent_task_id: "t1", updated_at: 100 });
    const run2 = session("run2", { agent_task_id: "t1", updated_at: 200 });
    const { triggerGroups, rest } = groupSessionsByTrigger([row(task("t1"))], [run1, run2]);
    expect(triggerGroups[0].items.map((s) => s._id)).toEqual(["run2", "run1"]);
    expect(rest).toEqual([]);
  });

  it("first roster row wins a contested session; groups keep roster order", () => {
    const home = session("home");
    const { triggerGroups } = groupSessionsByTrigger(
      [
        row(task("t1", { originating_conversation_id: "home" })),
        row(task("t2", { originating_conversation_id: "home" })),
      ],
      [home],
    );
    expect(triggerGroups.map((g) => g.key)).toEqual(["t1", "t2"]);
    expect(triggerGroups[0].items.map((s) => s._id)).toEqual(["home"]);
    expect(triggerGroups[1].items).toEqual([]);
  });

  it("a trigger with no visible sessions keeps its (empty) group", () => {
    const { triggerGroups, rest } = groupSessionsByTrigger(
      [row(task("t1", { originating_conversation_id: "gone" }))],
      [session("loose")],
    );
    expect(triggerGroups).toHaveLength(1);
    expect(triggerGroups[0].items).toEqual([]);
    expect(rest.map((s) => s._id)).toEqual(["loose"]);
  });

  it("claims a stashed home from the hidden pool without leaking hidden sessions into rest", () => {
    const stashedHome = session("home", { inbox_stashed_at: 1 });
    const stashedLoose = session("loose", { inbox_stashed_at: 1 });
    const { triggerGroups, rest } = groupSessionsByTrigger(
      [row(task("t1", { originating_conversation_id: "home" }))],
      [session("active")],
      { hidden: [stashedHome, stashedLoose] },
    );
    expect(triggerGroups[0].items.map((s) => s._id)).toEqual(["home"]);
    // Unclaimed hidden stays in its bucket; unclaimed active falls to rest.
    expect(rest.map((s) => s._id)).toEqual(["active"]);
  });

  it("loop pseudo rows claim their own session like inject homes", () => {
    const home = session("home");
    const { triggerGroups, rest } = groupSessionsByTrigger(
      [row(task("loop:home", { originating_conversation_id: "home" }), "loop")],
      [home],
    );
    expect(triggerGroups[0].items.map((s) => s._id)).toEqual(["home"]);
    expect(rest).toEqual([]);
  });
});
