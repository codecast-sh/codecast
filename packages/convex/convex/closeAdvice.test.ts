import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { closeTooltip, type CloseFacts } from "@codecast/shared/contracts/closeKind";
import { classifyNamedWorkState } from "./conversations";
import { adviceFromFacts, buildCloseAdvicePrompt, gatherCloseAdviceInput, parseCloseAdvice, type SessionFacts } from "./closeAdvice";

setDefaultTimeout(60_000);

const NOW = Date.now();
const none: CloseFacts = { inFlight: null, role: false, returnsOnDone: true, triggers: 0, parkedWake: null, waitingOnRun: false, takesDown: 0 };

describe("adviceFromFacts", () => {
  test("closing loses nothing in flight or armed, and says so in the Close tooltip's words", () => {
    const cases: Array<Partial<CloseFacts>> = [
      { inFlight: "live" }, { inFlight: "nested" }, { inFlight: "background" }, { inFlight: "loop" }, { inFlight: "limit" },
      { triggers: 2 }, { parkedWake: "blocker" }, { parkedWake: "wait", role: true }, { waitingOnRun: true },
    ];
    for (const c of cases) {
      const f = { ...none, ...c };
      expect(adviceFromFacts(f)).toEqual({ verdict: "close", reason: closeTooltip(f).replace(/^Close: /, ""), decided_by: "facts" });
    }
    expect(adviceFromFacts({ ...none, inFlight: "live" })?.reason).toBe("hides it, back when it's done or needs you");
    expect(adviceFromFacts({ ...none, parkedWake: "blocker" })?.reason).toBe("stops it, wakes when its blocker clears, back when it's done or needs you");
  });

  test("an open question or permission prompt is the person's", () => {
    expect(adviceFromFacts({ ...none, inFlight: "awaiting", triggers: 1 })).toEqual({
      verdict: "needs_input", reason: "Answer its open question or permission prompt", decided_by: "facts",
    });
  });

  test("so is one a member of its nested group waits on", () => {
    expect(adviceFromFacts({ ...none, inFlight: "nested_awaiting", triggers: 1 })).toEqual({
      verdict: "needs_input", reason: "Answer the question or permission prompt one of its agents waits on", decided_by: "facts",
    });
  });

  test("nothing will wake it: the call is the model's, a role's own session included", () => {
    expect(adviceFromFacts(none)).toBeNull();
    expect(adviceFromFacts({ ...none, role: true })).toBeNull();
  });
});

describe("parseCloseAdvice", () => {
  test("reads the two lines", () => {
    expect(parseCloseAdvice("VERDICT: needs_you\nREASON: Choose between the two schemas")).toEqual({
      verdict: "needs_input", reason: "Choose between the two schemas", decided_by: "model",
    });
    expect(parseCloseAdvice("```\nverdict: Close\nreason: Shipped the fix\n```")?.verdict).toBe("close");
  });

  test("a verdict cut short still names its side", () => {
    expect(parseCloseAdvice("VERDICT: needs_v\nREASON: Name the Slack channel")).toEqual({ verdict: "needs_input", reason: "Name the Slack channel", decided_by: "model" });
    expect(parseCloseAdvice("VERDICT: needs")?.verdict).toBe("needs_input");
    expect(parseCloseAdvice("VERDICT: needs_input\nREASON: Answer it")?.verdict).toBe("needs_input");
  });

  test("markdown and trailing punctuation around the verdict carry nothing", () => {
    for (const raw of ["VERDICT: close.\nREASON: Shipped it", "**VERDICT:** close\n**REASON:** Shipped it", "VERDICT: `close`\nREASON: Shipped it"]) {
      expect([raw, parseCloseAdvice(raw)]).toEqual([raw, { verdict: "close", reason: "Shipped it", decided_by: "model" }]);
    }
    expect(parseCloseAdvice("**VERDICT:** `needs_you`.\nREASON: Pick a schema")?.verdict).toBe("needs_input");
  });

  test("the reason keeps its code marks; only the verdict word is unwrapped", () => {
    expect(parseCloseAdvice("**VERDICT:** `close`.\nREASON: Merged `#42` into **main**")).toEqual({ verdict: "close", reason: "Merged `#42` into **main**", decided_by: "model" });
  });

  test("a model keep is no verdict: it cannot verify a wake", () => {
    expect(parseCloseAdvice("VERDICT: keep\nREASON: It is watching the deploy")).toBeNull();
    expect(parseCloseAdvice("I think it is done")).toBeNull();
  });
});

test("the prompt carries the facts and marks the final message", () => {
  const facts: SessionFacts = {
    now: NOW, lastActivityAt: NOW - 3 * 3_600_000, title: "Fix login",
    pin: { text: "Login fix shipped", status: "done", at: NOW - 3 * 3_600_000, predatesTurn: false },
    settle: null, closeKeeps: null, dormantClaim: true, task: { title: "Fix login", status: "in_review" }, plan: null,
    children: [{ title: "Reviewer", status: "done", pin: null, updatedAt: NOW - 4 * 3_600_000 }],
    git: { branch: "main", dirty: true, ahead: 2, behind: 0, at: NOW - 600_000 },
  };
  const prompt = buildCloseAdvicePrompt(facts, [
    { role: "user", content: "fix the login", isFinal: false },
    { role: "assistant", content: "Shipped.", isFinal: true },
  ]);
  expect(prompt).toContain("Pinned status (done, 3 h ago, current): Login fix shipped");
  expect(prompt).toContain("It declared itself dormant, but none of the wakes above is armed.");
  expect(prompt).toContain("Task it holds: Fix login (in_review)");
  expect(prompt).toContain("- Reviewer (done, 4 h ago)");
  expect(prompt).toContain("branch main, uncommitted changes, 2 commits not pushed");
  expect(prompt).toContain("Agent [FINAL MESSAGE]: Shipped.");
  // Close keeps nothing: the prompt says nothing will wake it.
  expect(prompt).toContain("Armed wakes: none (no trigger, loop, background work, running subagent, queued message or parked wake)");
  expect(prompt).toContain("Nothing the system can see will wake this session");

  // Close keeps a trigger: the prompt names it and claims no silence.
  const kept = buildCloseAdvicePrompt({ ...facts, closeKeeps: "stops it, runs its trigger out of sight, back when it's done or needs you" }, [{ role: "assistant", content: "I set a trigger for 2 AM.", isFinal: true }]);
  expect(kept).toContain("Armed wakes: closing keeps one: stops it, runs its trigger out of sight, back when it's done or needs you");
  expect(kept).toContain("It declared itself dormant.");
  expect(kept).not.toContain("Nothing the system can see will wake this session");
  expect(kept).not.toContain("none of the wakes above is armed");
  expect(kept).not.toContain("Armed wakes: none");
  // A closed session's wakes run it out of sight (#212): only a person's message brings it back by itself.
  expect(prompt).toContain("a person's message brings it back, and a wake runs it out of sight until it reports");
  expect(prompt).not.toContain("a new message brings it back");
  // The verdict words are the graded ones either way.
  for (const p of [prompt, kept]) expect(p).toContain("VERDICT: <close | needs_you>");
});

describe("closeAdviceInput", () => {
  async function world(opts: {
    feature: boolean; conv?: Record<string, unknown>; managed?: Record<string, unknown>; openTasks?: boolean; outsider?: boolean;
    spawnedChild?: "working" | "finished"; privateChild?: boolean; personal?: boolean;
    /** An agent-team teammate in its nested group, with this agent_status. */
    teammate?: string;
    /** Triggers injecting into it, oldest first. */
    triggers?: Array<Record<string, unknown>>;
    /** Children of its own owner filed under another workspace or team. */
    foreignChildren?: boolean;
    /** Its task and plan belong to someone the caller cannot read for. */
    foreignWork?: boolean;
    /** Its task is the team's, while the lead is private. */
    teamTask?: boolean;
    /** Also return the inbox's own placement of the session (classifyNamedWorkState), as `inbox`. */
    inbox?: boolean;
  }) {
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Riley" } as any);
      const outsider = await ctx.db.insert("users", { name: "Sam" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1, ...(opts.feature ? { features: { close_advice: true } } : {}) } as any);
      await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "member", joined_at: 1 } as any);
      const otherTeam = await ctx.db.insert("teams", { name: "Side", created_at: 1 } as any);
      const workOwner = opts.foreignWork ? outsider : user;
      const task = await ctx.db.insert("tasks", { short_id: "ct-1", title: "Fix login", status: "in_progress", user_id: workOwner, created_at: 1, updated_at: 1, ...(opts.foreignWork ? { workspace: `user:${outsider}` } : opts.teamTask ? { team_id: team, workspace: `team:${team}` } : { workspace: `user:${user}` }) } as any);
      const plan = opts.foreignWork ? await ctx.db.insert("plans", { short_id: "pl-1", title: "Secret plan", goal: "x", status: "active", user_id: outsider, workspace: `user:${outsider}`, created_at: 1, updated_at: 1 } as any) : undefined;
      const conv = await ctx.db.insert("conversations", {
        short_id: "jx7lead", user_id: user, ...(opts.personal ? {} : { team_id: team }), is_private: true, agent_type: "claude_code", status: "active", session_id: "s-1",
        started_at: NOW - 7_200_000, updated_at: NOW - 3_600_000, message_count: 2, last_message_role: "assistant",
        title: "Fix login", active_task_id: task, ...(plan ? { active_plan_id: plan } : {}), thread_state: "Waiting on CI", thread_state_status: "dormant", thread_state_at: NOW - 3_600_000,
        last_turn_at: NOW - 3_700_000, git_branch: "main", git_dirty: false, git_ahead: 0, git_behind: 0, git_state_at: NOW - 60_000,
        ...opts.conv,
      } as any);
      await ctx.db.insert("managed_sessions", {
        session_id: "s-1", conversation_id: conv, user_id: user, agent_status: "idle", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000,
        ...(opts.openTasks ? { agent_status: "waiting", open_tasks: [{ id: "b1", kind: "bash", description: "watch deploy" }], open_tasks_at: NOW - 30_000 } : {}),
        ...opts.managed,
      } as any);
      if (opts.teammate) {
        const mate = await ctx.db.insert("conversations", {
          user_id: user, team_id: team, is_private: true, agent_type: "claude_code", status: "active", session_id: "s-mate", spawned_by_conversation_id: conv,
          agent_team_name: "crew", agent_name: "reviewer", started_at: NOW - 600_000, updated_at: NOW - 60_000, message_count: 4, last_message_role: "assistant", title: "Reviewer",
        } as any);
        await ctx.db.insert("managed_sessions", {
          session_id: "s-mate", conversation_id: mate, user_id: user, agent_status: opts.teammate, agent_status_updated_at: NOW - 60_000, last_heartbeat: NOW - 1000,
        } as any);
      }
      for (const [i, task] of (opts.triggers ?? []).entries()) {
        await ctx.db.insert("agent_tasks", {
          user_id: user, title: `Trigger ${i}`, prompt: "check", schedule_type: "once", mode: "apply", status: "completed",
          retry_count: 0, run_count: 1, created_at: i, originating_conversation_id: conv, ...task,
        } as any);
      }
      if (opts.foreignChildren) {
        // The same owner's sessions, spawned by the lead: one filed under another team, one shared with the team while the lead is private.
        for (const [title, extra] of [["Other team worker", { team_id: otherTeam, is_private: true }], ["Team-visible worker", { team_id: team, is_private: false, team_visibility: "full" }]] as const) {
          await ctx.db.insert("conversations", {
            user_id: user, agent_type: "claude_code", status: "completed", session_id: `s-${title}`, spawned_by_conversation_id: conv,
            started_at: NOW - 600_000, updated_at: NOW - 60_000, message_count: 4, last_message_role: "assistant", title, ...extra,
          } as any);
        }
      }
      if (opts.spawnedChild) {
        // A `cast spawn` worker: spawned_by but not a Task child, so not in the nested group a close takes down.
        const working = opts.spawnedChild === "working";
        const child = await ctx.db.insert("conversations", {
          user_id: user, team_id: team, is_private: true, agent_type: "claude_code", status: "active", session_id: "s-child", spawned_by_conversation_id: conv,
          started_at: NOW - 600_000, updated_at: working ? NOW - 5_000 : NOW - 3_600_000, message_count: 4, last_message_role: "assistant", title: "Worker",
        } as any);
        await ctx.db.insert("managed_sessions", {
          session_id: "s-child", conversation_id: child, user_id: user, agent_status: working ? "working" : "idle", agent_status_updated_at: working ? NOW - 5_000 : NOW - 3_600_000, last_heartbeat: NOW - 1000,
        } as any);
      }
      if (opts.privateChild) {
        // Spawned by the lead but owned by someone else, private: the caller cannot read it.
        await ctx.db.insert("conversations", {
          user_id: outsider, team_id: team, is_private: true, agent_type: "claude_code", status: "completed", session_id: "s-other", spawned_by_conversation_id: conv,
          started_at: NOW - 600_000, updated_at: NOW - 60_000, message_count: 4, last_message_role: "assistant", title: "Secret title", thread_state: "Secret pin",
        } as any);
      }
      await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "fix the login please", timestamp: NOW - 7_000_000, message_uuid: "m1" } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Pushed the fix; I'll watch CI and report back.", timestamp: NOW - 3_600_000, message_uuid: "m2" } as any);
      return { conv, caller: opts.outsider ? outsider : user };
    });
    const out: any = await t.withIdentity({ subject: `${ids.caller}|session` })
      .query(internal.closeAdvice.closeAdviceInput, { session: "jx7lead", now: NOW })
      .catch((e: Error) => ({ error: e.message }));
    if (!out.error) {
      expect(out).toMatchObject({ short_id: "jx7lead", conversation_id: String(ids.conv) });
      delete out.short_id;
      delete out.conversation_id;
    }
    if (opts.inbox) out.inbox = (await t.run(async (ctx) => classifyNamedWorkState(ctx, await ctx.db.get(ids.conv), NOW))).state;
    return out;
  }

  test("off for a team without the feature: no facts read, no model call", async () => {
    expect(await world({ feature: false })).toEqual({ off: "team" });
  });

  test("a personal session borrows the feature from its owner's teams", async () => {
    expect(await world({ feature: false, personal: true })).toEqual({ off: "personal" });
    expect(await world({ feature: true, personal: true })).toHaveProperty("facts");
  });

  test("a session another person cannot read is refused", async () => {
    expect(await world({ feature: true, outsider: true })).toEqual({ error: 'No session found for "jx7lead"' });
  });

  test("background work still running: close sets it aside to finish, no model", async () => {
    expect(await world({ feature: true, openTasks: true })).toEqual({
      advice: { verdict: "close", reason: "hides it, keeps its background work, back when it's done or needs you", decided_by: "facts" },
    });
  });

  test("an armed standing trigger: close, it runs its trigger out of sight", async () => {
    expect(await world({ feature: true, conv: { armed_trigger_kind: "standing" } })).toEqual({
      advice: { verdict: "close", reason: "stops it, runs its trigger out of sight, back when it needs you", decided_by: "facts" },
    });
  });

  test("a park the server stands behind: close, it comes back when the park wakes it", async () => {
    // The inbox rests it on the park while its daemon declares it dormant.
    expect(await world({ feature: true, conv: { parked_wake_kind: "blocker" }, managed: { agent_status: "dormant" } })).toEqual({
      advice: { verdict: "close", reason: "stops it, wakes when its blocker clears, back when it's done or needs you", decided_by: "facts" },
    });
  });

  test("a spawned worker, working or not, is a fact for the model: it never reports back", async () => {
    for (const [spawnedChild, updatedAt] of [["working", NOW - 5_000], ["finished", NOW - 3_600_000]] as const) {
      const out: any = await world({ feature: true, spawnedChild });
      expect(out.facts.children).toEqual([{ title: "Worker", status: "open", pin: null, updatedAt }]);
    }
  });

  test("a child the caller cannot read never reaches the facts", async () => {
    const out: any = await world({ feature: true, privateChild: true });
    expect(out.facts.children).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("Secret");
  });

  test("only a settle verdict that still describes the latest turn reaches the model", async () => {
    // A daemon-declared dormancy nothing Close keeps: the inbox rests it, the model reads the rest.
    const claimed = { managed: { agent_status: "dormant" } };
    const current: any = await world({ feature: true, ...claimed, conv: { settle_verdict: "needs_input", settle_verdict_at: NOW - 3_500_000, idle_summary: "Asked which schema" } });
    expect(current.facts.settle).toEqual({ verdict: "needs_input", summary: "Asked which schema" });
    const stale: any = await world({ feature: true, ...claimed, conv: { settle_verdict: "needs_input", settle_verdict_at: NOW - 5_000_000 } });
    expect(stale.facts.settle).toBeNull();
    const junk: any = await world({ feature: true, ...claimed, conv: { settle_verdict: "maybe", settle_verdict_at: NOW - 3_500_000 } });
    expect(junk.facts.settle).toBeNull();
  });

  test("a teammate waiting on a permission prompt is the person's, whatever the lead is doing", async () => {
    const needs = { advice: { verdict: "needs_input", reason: "Answer the question or permission prompt one of its agents waits on", decided_by: "facts" } };
    expect(await world({ feature: true, teammate: "permission_blocked" })).toEqual(needs);
    // The lead's own background work is in flight too, and comes first in the group scan's order: the waiting teammate still decides.
    expect(await world({ feature: true, teammate: "permission_blocked", openTasks: true })).toEqual(needs);
    // A teammate merely working sets the close aside of a lead the inbox rests (its stop read done), nothing more.
    expect(await world({ feature: true, teammate: "working", conv: { settle_verdict: "done", settle_verdict_at: NOW - 3_500_000 } })).toEqual({ advice: { verdict: "close", reason: "hides it, back when it's done or needs you", decided_by: "facts" } });
  });

  test("a current settle verdict decides without the model, when the agent declared no wake", async () => {
    const done = { thread_state_status: "done", settle_verdict: "done", settle_verdict_at: NOW - 3_500_000, idle_summary: "Shipped the login fix" };
    expect(await world({ feature: true, conv: done })).toEqual({ advice: { verdict: "close", reason: "Shipped the login fix", decided_by: "settle" } });
    // idle_summary is a past-tense headline (sessionInsights rewrites it), never the person's action.
    expect(await world({ feature: true, conv: { ...done, settle_verdict: "needs_input", idle_summary: "Asked which schema" } })).toEqual({
      advice: { verdict: "needs_input", reason: "Read its last message: it asks something of you", decided_by: "settle" },
    });
    // A pinned dormant under the daemon's own idle: the inbox reads the daemon, and the stop's done.
    expect(await world({ feature: true, conv: { ...done, thread_state_status: "dormant" } })).toEqual({ advice: { verdict: "close", reason: "Shipped the login fix", decided_by: "settle" } });
    // The daemon declared it dormant with nothing Close keeps: the model weighs that claim.
    expect(await world({ feature: true, conv: done, managed: { agent_status: "dormant" } })).toHaveProperty("facts");
    // Its own pin says it is blocked: a "done" read of the stop does not outrank that.
    expect(await world({ feature: true, conv: { ...done, thread_state_status: "blocked" } })).toMatchObject({ advice: { verdict: "needs_input", decided_by: "pin" } });
    // Recorded before the last activity.
    expect(await world({ feature: true, conv: { ...done, settle_verdict_at: NOW - 5_000_000 } })).toHaveProperty("facts");
  });

  test("a session the person filed Done closes: closing it is theirs, whatever its last message asked", async () => {
    const filed = { inbox_rest: "done", inbox_rest_at: NOW - 1_000, settle_verdict: "needs_input", settle_verdict_at: NOW - 3_500_000, thread_state: undefined, thread_state_status: undefined, thread_state_at: undefined };
    const out: any = await world({ feature: true, conv: filed, inbox: true });
    expect(out.inbox).toBe("done");
    expect(out.advice).toEqual({ verdict: "close", reason: "You filed it done", decided_by: "facts" });
  });

  test("a done pin alone never closes: only the classifier's current done does", async () => {
    // The daemon carries the agent's own done, so the inbox files it Done.
    const declaredDone = { managed: { agent_status: "done" } };
    const noSettle: any = await world({ feature: true, ...declaredDone, inbox: true, conv: { thread_state_status: "done", thread_state: "Delivered the audit" } });
    expect(noSettle.inbox).toBe("done");
    expect(noSettle).toHaveProperty("facts");
    // A needs_input verdict its own `cast state` made stale (recorded before the last activity).
    expect(await world({ feature: true, ...declaredDone, conv: { thread_state_status: "done", settle_verdict: "needs_input", settle_verdict_at: NOW - 5_000_000 } })).toHaveProperty("facts");
    expect(await world({ feature: true, ...declaredDone, conv: { thread_state_status: "done", settle_verdict: "done", settle_verdict_at: NOW - 3_500_000, idle_summary: "Delivered the audit" } })).toEqual({
      advice: { verdict: "close", reason: "Delivered the audit", decided_by: "settle" },
    });
  });

  test("a pin written before the latest turn is not the agent's word on it", async () => {
    // A turn opened after the pin, and the classifier read the stop that ended it.
    const newerTurn = { updated_at: NOW - 3_500_000, last_turn_at: NOW - 3_550_000, settle_verdict: "done", settle_verdict_at: NOW - 3_450_000, idle_summary: "Shipped the login fix" };
    const closes = { advice: { verdict: "close", reason: "Shipped the login fix", decided_by: "settle" } };
    // The world's pin says dormant (the old turn's claim) and still decides nothing.
    expect(await world({ feature: true, conv: newerTurn })).toEqual(closes);
    // A block stands until the agent's next declaration, as in the inbox: an older blocked pin still claims the person.
    expect(await world({ feature: true, conv: { ...newerTurn, thread_state_status: "blocked" } })).toMatchObject({ advice: { verdict: "needs_input", decided_by: "pin" } });
    // A current dormancy the daemon carries, with nothing Close keeps: the model weighs it.
    expect(await world({ feature: true, conv: newerTurn, managed: { agent_status: "dormant" } })).toHaveProperty("facts");
  });

  test("its own declared block outranks a wake: a trigger brings the agent back, not the person's answer", async () => {
    const armed = { armed_trigger_kind: "standing", thread_state_at: NOW - 3_600_000, thread_state_status: "blocked" };
    const pin = (thread_state: string) => world({ feature: true, conv: { ...armed, thread_state } });
    const asks = (reason: string) => ({ advice: { verdict: "needs_input", reason, decided_by: "pin" } });
    // The ask, read the way the inbox card reads it (threadStateCardLine): `You:`, a bulleted one, or an older note's `Blocked:`.
    expect(await pin("Should I merge #42?\nYou: approve or decline the merge")).toEqual(asks("approve or decline the merge"));
    expect(await pin("Should I merge #42?\n- You: approve or decline the merge")).toEqual(asks("approve or decline the merge"));
    expect(await pin("Merge is waiting\nBlocked: needs a reviewer for #42")).toEqual(asks("needs a reviewer for #42"));
    expect(await pin("Should I merge #42?")).toEqual(asks("Answer its pinned status: Should I merge #42?"));
  });

  test("a blocked pin the daemon has a newer status over is not a declared block (declaredBlockHolds)", async () => {
    const blocked = { thread_state_at: NOW - 3_600_000, thread_state_status: "blocked", thread_state: "Should I merge #42?" };
    // The daemon carries a newer declaration (dormant): nothing armed, so the model weighs it.
    expect(await world({ feature: true, conv: blocked, managed: { agent_status: "dormant" } })).toHaveProperty("facts");
  });

  test("a wake the inbox rests it on outranks the settle classifier, which only answers done or needs_input", async () => {
    const asks = { settle_verdict: "needs_input", settle_verdict_at: NOW - 3_500_000 };
    const closes = (reason: string) => ({ advice: { verdict: "close", reason, decided_by: "facts" } });
    const trigger = "stops it, runs its trigger out of sight, back when it needs you";
    // A pin older than the latest turn: a turn opened after it, the activity moved with it.
    const predating = { thread_state_at: NOW - 3_600_000, last_turn_at: NOW - 3_590_000, updated_at: NOW - 3_580_000 };
    const noPin = { thread_state: undefined, thread_state_status: undefined, thread_state_at: undefined };
    expect(await world({ feature: true, conv: { ...asks, armed_trigger_kind: "standing", ...predating } })).toEqual(closes(trigger));
    expect(await world({ feature: true, conv: { ...asks, ...noPin }, openTasks: true })).toEqual(closes("hides it, keeps its background work, back when it's done or needs you"));
    expect(await world({ feature: true, conv: { ...asks, armed_trigger_kind: "standing", ...noPin } })).toEqual(closes(trigger));
    // A pinned done with the classifier asking, and a trigger: the wake decides.
    expect(await world({ feature: true, conv: { ...asks, armed_trigger_kind: "standing", thread_state_status: "done" } })).toEqual(closes(trigger));
  });

  // Anti-drift: advice is the inbox's placement plus what Close does, so it
  // says needs_input exactly when the inbox's own one-session classifier
  // (classifyNamedWorkState, the inbox's placement path) files the session
  // needs_input, for the declared-block rows and for the rest orders advice
  // once restated (a once trigger, a person's last turn, a park).
  test("advice says needs_input exactly when the inbox files the session needs_input", async () => {
    const agents: Record<string, { managed: Record<string, unknown>; conv?: Record<string, unknown> }> = {
      idle: { managed: { agent_status: "idle" } },
      "working-fresh": { managed: { agent_status: "working", agent_status_updated_at: NOW - 5_000 }, conv: { updated_at: NOW - 5_000 } },
      "working-stale": { managed: { agent_status: "working", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 3_600_000 } },
      stopped: { managed: { agent_status: "stopped", last_heartbeat: NOW - 3_600_000 } },
      hibernated: { managed: { agent_status: "hibernated" } },
      dormant: { managed: { agent_status: "dormant" } },
    };
    const pins = { current: NOW - 3_600_000, predating: NOW - 3_800_000 };
    const rows: string[] = [];
    const check = async (label: string, opts: Parameters<typeof world>[0]) => {
      const out: any = await world({ ...opts, feature: true, inbox: true });
      const advice = out.advice?.verdict ?? "model";
      rows.push(`${label}: inbox ${out.inbox}, advice ${advice}${out.advice ? ` (${out.advice.decided_by})` : ""}`);
      expect([label, advice === "needs_input"]).toEqual([label, out.inbox === "needs_input"]);
    };
    for (const [agent, a] of Object.entries(agents)) {
      for (const [pin, pinnedAt] of Object.entries(pins)) {
        for (const wake of ["trigger", "none"] as const) {
          await check(`${agent} / ${pin} pin / ${wake}`, {
            managed: { agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000, ...a.managed },
            conv: {
              updated_at: NOW - 3_600_000, last_turn_at: NOW - 3_700_000, ...a.conv,
              thread_state_status: "blocked", thread_state: "Should I merge #42?", thread_state_at: pinnedAt,
              settle_verdict: "done", settle_verdict_at: NOW - 1_000,
              ...(wake === "trigger" ? { armed_trigger_kind: "standing" } : {}),
            },
          });
        }
      }
    }
    const asks = { settle_verdict: "needs_input", settle_verdict_at: NOW - 1_000, thread_state: undefined, thread_state_status: undefined, thread_state_at: undefined };
    // A once trigger is a reminder: it never hides an open ask.
    await check("once trigger / settle asks", { conv: { ...asks, armed_trigger_kind: "once" }, triggers: [{ status: "scheduled", schedule_type: "once" }] });
    // A standing trigger parks only while the machine delivered the last turn; a person spoke last.
    await check("standing trigger / person spoke last / settle asks", { conv: { ...asks, armed_trigger_kind: "standing", last_message_preview: "can you also check the deploy?" } });
    // A park without a fresh dormant pin rests nothing.
    await check("parked blocker / predating pin / hibernated / settle asks", {
      managed: { agent_status: "hibernated" },
      conv: { ...asks, parked_wake_kind: "blocker", thread_state: "Waiting on #42", thread_state_status: "dormant", thread_state_at: NOW - 3_800_000 },
    });
    // Work in flight the inbox still files Needs You: advice follows the inbox, not the aside.
    await check("queued message on a dead daemon / settle asks", { managed: { agent_status: "idle", last_heartbeat: NOW - 3_600_000 }, conv: { ...asks, has_pending_messages: true } });
    const loop = { status: "armed", wakeup_at: NOW + 600_000, event_at: NOW - 60_000 };
    await check("fresh loop / person spoke last / settle asks", { conv: { ...asks, loop_state: loop, last_message_preview: "also look at the flaky test" } });
    await check("fresh loop / machine turn / settle asks", { conv: { ...asks, loop_state: loop } });
    await check("usage-limit park / settle asks", { conv: { ...asks, pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: NOW - 60_000 } });
    await check("fleet slot queued / settle asks", { conv: { ...asks, subagent_slot: "queued" } });
    // The two round-6 probes, and the round-7 rows: all in Needs You.
    for (const row of [
      "stopped / current pin / trigger: inbox needs_input, advice needs_input (pin)",
      "working-stale / current pin / trigger: inbox needs_input, advice needs_input (pin)",
      "idle / predating pin / trigger: inbox needs_input, advice needs_input (pin)",
      "once trigger / settle asks: inbox needs_input, advice needs_input (settle)",
      "standing trigger / person spoke last / settle asks: inbox needs_input, advice needs_input (settle)",
      "parked blocker / predating pin / hibernated / settle asks: inbox needs_input, advice needs_input (settle)",
      "fresh loop / person spoke last / settle asks: inbox needs_input, advice needs_input (settle)",
      "queued message on a dead daemon / settle asks: inbox needs_input, advice needs_input (settle)",
    ]) expect(rows).toContain(row);
    // With nothing to word an ask, the inbox's needs_input goes to the model, never to the aside's close.
    const bare: any = await world({ feature: true, managed: { agent_status: "idle", last_heartbeat: NOW - 3_600_000 }, conv: { has_pending_messages: true, thread_state: undefined, thread_state_status: undefined, thread_state_at: undefined } });
    expect(bare).toHaveProperty("facts");
  });

  test("triggers are read newest first, and counted only when they will fire", async () => {
    const old = Array.from({ length: 50 }, () => ({}));
    const fresh = { status: "scheduled", schedule_type: "recurring" };
    // The row says a standing trigger is armed; the newest two are counted only when read first.
    expect(await world({ feature: true, conv: { armed_trigger_kind: "standing" }, triggers: [...old, fresh, fresh] })).toEqual({
      advice: { verdict: "close", reason: "stops it, runs its 2 triggers out of sight, back when it needs you", decided_by: "facts" },
    });
    for (const unarmed of [{ status: "paused" }, { status: "scheduled", last_run_failed: true }, { status: "scheduled", last_run_needs_attention: true }]) {
      expect(await world({ feature: true, triggers: [unarmed] })).toHaveProperty("facts");
    }
  });

  test("only children in the lead's own workspace and team reach the prompt", async () => {
    const out: any = await world({ feature: true, foreignChildren: true, spawnedChild: "finished" });
    expect(out.facts.children.map((c: any) => c.title)).toEqual(["Worker"]);
  });

  test("a task of another workspace is left out, even one the caller can read", async () => {
    // The lead is private (its owner's workspace); the task is the team's.
    const out: any = await world({ feature: true, teamTask: true });
    expect(out.facts.task).toBeNull();
  });

  test("a task is shown iff its workspace is the session's: its team routing does not count", async () => {
    // The lead is private (its owner's workspace) though routed to the team; the task is the owner's, with no team.
    const own: any = await world({ feature: true });
    expect(own.facts.task).toEqual({ title: "Fix login", status: "in_progress" });
    // The same session shared with the team: its workspace is the team's now.
    const shared: any = await world({ feature: true, conv: { is_private: false, team_visibility: "full" } });
    expect(shared.facts.task).toBeNull();
  });

  test("a task or plan the caller cannot read is left out", async () => {
    const out: any = await world({ feature: true, foreignWork: true });
    expect(out.facts.task).toBeNull();
    expect(out.facts.plan).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Secret plan");
  });

  test("nothing armed hands the model the facts and the shaped tail", async () => {
    const out: any = await world({ feature: true });
    expect(out.facts).toMatchObject({
      dormantClaim: true,
      task: { title: "Fix login", status: "in_progress" },
      pin: { text: "Waiting on CI", status: "dormant", predatesTurn: false },
      git: { branch: "main", dirty: false },
      children: [],
    });
    expect(out.tail.at(-1)).toEqual({ role: "assistant", content: "Pushed the fix; I'll watch CI and report back.", isFinal: true });
  });
});

describe("adviseClose: the model call", () => {
  const TOKEN = "close-advice-token";
  const DEVICE = "device-mac-1";
  let fetched = 0;
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    fetched = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async (url: any) => {
      if (!String(url).includes("api.anthropic.com")) throw new Error(`unexpected fetch ${url}`);
      fetched++;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "VERDICT: close\nREASON: Shipped the login fix" }], usage: { input_tokens: 1_000, output_tokens: 20 }, stop_reason: "end_turn" }), { status: 200 });
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  /** A quiet team session nothing will wake and no settle verdict describes. */
  async function setup(opts: { cap?: number; enrolledInRegulated?: boolean; featureOff?: boolean } = {}) {
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx) => {
      const user = await ctx.db.insert("users", { name: "Riley" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: 1, features: { close_advice: !opts.featureOff } } as any);
      const clinic = await ctx.db.insert("teams", { name: "Clinic", created_at: 1, policy: { regulated_data: true } } as any);
      await ctx.db.insert("team_memberships", { team_id: team, user_id: user, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("team_memberships", { team_id: clinic, user_id: user, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "mac", created_at: 1, last_used_at: 1, device_id: DEVICE } as any);
      await ctx.db.insert("devices", { user_id: user, device_id: DEVICE, label: "mac", platform: "darwin", last_seen: 1, ...(opts.enrolledInRegulated ? { enrolled_team_id: clinic } : {}) } as any);
      const conv = await ctx.db.insert("conversations", {
        short_id: "jx7lead", user_id: user, team_id: team, is_private: false, team_visibility: "full", agent_type: "claude_code", status: "active", session_id: "s-1",
        started_at: NOW - 7_200_000, updated_at: NOW - 3_600_000, message_count: 2, last_message_role: "assistant", title: "Fix login",
      } as any);
      await ctx.db.insert("managed_sessions", { session_id: "s-1", conversation_id: conv, user_id: user, agent_status: "idle", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000 } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Shipped the fix.", timestamp: NOW - 3_600_000, message_uuid: "m1" } as any);
      if (opts.cap !== undefined) {
        await ctx.db.insert("team_budgets", { workspace: `team:${team}`, team_id: team, cap_usd: opts.cap, month: new Date().toISOString().slice(0, 7), spent_usd: 0, held_usd: 0, by_purpose: { judge: 0, grouping: 0, call: 0 }, refused: 0, history: [], updated_at: 1 } as any);
      }
      return { team };
    });
    const advise = () => t.action(api.closeAdvice.adviseClose, { session: "jx7lead", api_token: presentToken(TOKEN, DEVICE) });
    const spend = () => t.run(async (ctx) => (await ctx.db.query("model_spend_hours").collect()).map((r: any) => ({ workspace: r.workspace, calls: r.calls, judge: r.by_purpose.judge })));
    const budget = () => t.run(async (ctx) => ctx.db.query("team_budgets").first());
    return { t, ids, advise, spend, budget };
  }

  test("off: the shared feature-off words come back with it", async () => {
    const s = await setup({ featureOff: true });
    expect(await s.advise()).toEqual({ short_id: "jx7lead", off: "team", message: teamFeatureOffMessage("close_advice") });
    expect(fetched).toBe(0);
  });

  test("the caller's device is part of the vendor gate: one enrolled in a regulated team sends nothing, budget or not", async () => {
    for (const cap of [undefined, 100]) {
      const s = await setup({ enrolledInRegulated: true, cap });
      const out: any = await s.advise();
      expect(out.error).toContain("Clinic");
      expect(fetched).toBe(0);
      expect(await s.spend()).toEqual([]);
      if (cap) expect((await s.budget())!.spent_usd).toBe(0);
    }
  });

  test("a workspace without a budget: the call is codecast's own and records nothing", async () => {
    const s = await setup();
    expect(await s.advise()).toEqual({ short_id: "jx7lead", advice: { verdict: "close", reason: "Shipped the login fix", decided_by: "model" } });
    expect(fetched).toBe(1);
    expect(await s.spend()).toEqual([]);
  });

  test("a workspace with a budget pays from it, and one with no room makes no call", async () => {
    const s = await setup({ cap: 100 });
    expect((await s.advise() as any).advice?.decided_by).toBe("model");
    expect((await s.budget())!.spent_usd).toBeGreaterThan(0);
    expect((await s.spend())[0]).toMatchObject({ workspace: `team:${s.ids.team}`, calls: 1 });

    const full = await setup({ cap: 0.000001 });
    expect(await full.advise()).toEqual({ short_id: "jx7lead", error: "the team's model budget for this month has no room" });
    expect(fetched).toBe(1);
  });
});

test("the gather reads the nested group once: the in-flight scan's read feeds the children", async () => {
  const t = convexTest(schema, allModules);
  const reads = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Riley" } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: user, is_private: true, agent_type: "claude_code", status: "active", session_id: "s-g", started_at: NOW - 7_200_000, updated_at: NOW - 3_600_000,
      message_count: 2, last_message_role: "assistant", title: "Lead",
    } as any);
    await ctx.db.insert("managed_sessions", { session_id: "s-g", conversation_id: conv, user_id: user, agent_status: "idle", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000 } as any);
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("conversations", { user_id: user, is_private: true, agent_type: "claude_code", status: "completed", session_id: `s-k${i}`, started_at: 1, updated_at: 1, message_count: 2, is_subagent: true, parent_conversation_id: conv, title: `Sub ${i}` } as any);
    }
    let groupReads = 0;
    const db = new Proxy(ctx.db, {
      get(target: any, prop) {
        if (prop !== "query") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return (table: string) => {
          const q = target.query(table);
          return new Proxy(q, {
            get(qt: any, qp) {
              if (qp === "withIndex") return (name: string, ...rest: any[]) => { if (name === "by_parent_conversation_id") groupReads++; return qt.withIndex(name, ...rest); };
              return typeof qt[qp] === "function" ? qt[qp].bind(qt) : qt[qp];
            },
          });
        };
      },
    });
    const out: any = await gatherCloseAdviceInput({ db }, await ctx.db.get(conv), NOW, async () => true);
    return { groupReads, children: out.facts.children.length };
  });
  // The real path: the Close scan's read feeds the children; the inbox's own classifier reads the group once more for its producing rollup.
  expect(reads).toEqual({ groupReads: 2, children: 3 });
});
