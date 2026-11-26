// A close takes down only what goes down with its lead, and the spawned
// children it leaves running stand as their own cards while they still hold
// something: the server decides each adoption, releases it when the close
// ends, and keeps every transaction's reads bounded.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { internal } from "./_generated/api";
import { applyPatches } from "./dispatch";
import { enqueuePendingMessage } from "./pendingMessages";
import { makeAdoptionReleaseDb } from "./lib/adoptionRelease";
import { isClosedSession } from "@codecast/shared/contracts";
import { countingDb, expectAside, setup } from "./dispatch.close.testkit";

setDefaultTimeout(60_000);

// A close takes down only what goes down with the lead (Task subagents with
// session id "agent-…", and teammates): a `cast spawn` child has its own process, so a close
// of its lead leaves it running and, while it still holds something, adopts
// it, so it stands as its own card.
// A kill still takes the whole group.
describe("a close takes down only what goes down with the lead", () => {
  async function withKids(o: { spawnedBusy?: boolean } = {}) {
    const s = await setup();
    const kids = await s.t.run(async (ctx) => {
      const t = Date.now();
      const kid = (sessionId: string, busy: boolean) => ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: busy ? t : t - 3_600_000, status: "active", session_id: sessionId, message_count: 4,
        is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant",
      } as any);
      const agent = await kid("agent-a009f4fcdcbf7ef81", false);
      const spawned = await kid("ca19ce3d-0000-4000-8000-000000000001", !!o.spawnedBusy);
      await ctx.db.insert("managed_sessions", { session_id: "ca19ce3d-0000-4000-8000-000000000001", conversation_id: spawned, user_id: s.ids.user, pid: 2, started_at: t, last_heartbeat: t, agent_status: o.spawnedBusy ? "working" : "idle", agent_status_updated_at: o.spawnedBusy ? t : t - 3_600_000 } as any);
      return { agent, spawned };
    });
    const row = (id: any) => s.t.run(async (ctx) => (await ctx.db.get(id)) as any);
    const killed = async () => (await s.kills()).map((c: any) => JSON.parse(c.args).conversation_id);
    return { ...s, kids, row, killed };
  }

  test("closing the lead stops its agent- subagent and leaves the spawned child running, adopted as its own card", async () => {
    const s = await withKids();
    await s.send("closeSession", [String(s.ids.conv)]);
    const lead = await s.row(s.ids.conv);
    expect(isClosedSession(lead)).toBe(true);
    const agent = await s.row(s.kids.agent);
    expect(isClosedSession(agent)).toBe(true);
    const spawned = await s.row(s.kids.spawned);
    expect(spawned.inbox_dismissed_at).toBeUndefined();
    expect(spawned.inbox_closed_at).toBeUndefined();
    expect(spawned.inbox_killed_at).toBeUndefined();
    expect(spawned.inbox_adopted_at).toBe(lead.inbox_dismissed_at);
    const killed = await s.killed();
    expect(killed).toContain(String(s.kids.agent));
    expect(killed).not.toContain(String(s.kids.spawned));
  });

  test("a spawned child mid-turn does not set the lead's close aside", async () => {
    const s = await withKids({ spawnedBusy: true });
    await s.send("closeSession", [String(s.ids.conv)]);
    const lead = await s.row(s.ids.conv);
    expect(isClosedSession(lead)).toBe(true);
    expect(lead.inbox_stashed_at).toBeUndefined();
    const spawned = await s.row(s.kids.spawned);
    expect(spawned.inbox_dismissed_at).toBeUndefined();
    expect(await s.killed()).not.toContain(String(s.kids.spawned));
  });

  test("only a spawned child that still holds something is adopted; a finished one stays nested under the closed lead", async () => {
    const s = await setup();
    const ids = await s.t.run(async (ctx) => {
      const t = Date.now();
      const kid = (sessionId: string, extra: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "claude_code", started_at: t - 7_200_000, updated_at: t - 3_600_000, status: "completed", session_id: sessionId, message_count: 4,
        is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant", ...extra,
      } as any);
      const live = await kid("ca19ce3d-live", { status: "active" });
      await ctx.db.insert("managed_sessions", { session_id: "ca19ce3d-live", conversation_id: live, user_id: s.ids.user, pid: 2, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
      const finished = [await kid("ca19ce3d-done1"), await kid("ca19ce3d-done2"), await kid("ca19ce3d-done3")];
      // One finished long ago whose daemon stopped heartbeating its session.
      await ctx.db.insert("managed_sessions", { session_id: "ca19ce3d-done3", conversation_id: finished[2], user_id: s.ids.user, pid: 3, started_at: t - 7_200_000, last_heartbeat: t - 3_600_000, agent_status: "stopped", agent_status_updated_at: t - 3_600_000 } as any);
      return { live, finished };
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    const live = (await s.t.run((ctx) => ctx.db.get(ids.live))) as any;
    expect(live.inbox_adopted_at).toBeGreaterThan(0);
    expect(live.inbox_dismissed_at).toBeUndefined();
    for (const id of ids.finished) {
      const k = (await s.t.run((ctx) => ctx.db.get(id))) as any;
      expect(k.inbox_adopted_at).toBeUndefined();
      expect(k.inbox_dismissed_at).toBeUndefined();
      expect(k.inbox_closed_at).toBeUndefined();
    }
    expect((await s.kills()).length).toBe(1); // the lead's own teardown only
  });

  test("an agent-team teammate goes down with its lead's close, and mid-turn it sets the close aside", async () => {
    const mk = async (busy: boolean) => {
      const s = await setup();
      const mate = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", {
          user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: busy ? t : t - 3_600_000, status: "active", session_id: "5b1e0000-mate", message_count: 4,
          spawned_by_conversation_id: s.ids.conv, agent_team_name: "crew", agent_name: "reviewer", last_message_role: "assistant",
        } as any);
        await ctx.db.insert("managed_sessions", { session_id: "5b1e0000-mate", conversation_id: c, user_id: s.ids.user, pid: 4, started_at: t, last_heartbeat: t, agent_status: busy ? "working" : "idle", agent_status_updated_at: busy ? t : t - 3_600_000 } as any);
        return c;
      });
      await s.send("closeSession", [String(s.ids.conv)]);
      return { s, mate: (await s.t.run((ctx) => ctx.db.get(mate))) as any };
    };
    const idle = await mk(false);
    expect(isClosedSession(idle.mate)).toBe(true);
    expect(idle.mate.inbox_adopted_at).toBeUndefined();
    const busy = await mk(true);
    expectAside(await busy.s.read());
    expect(busy.mate.inbox_dismissed_at).toBeUndefined();
  });

  test("the lead coming back releases the adoption its close stamped; an adoption of another stamp stays", async () => {
    const s = await withKids();
    const other = await s.t.run(async (ctx) => ctx.db.insert("conversations", {
      user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "active", session_id: "ca19ce3d-talked", message_count: 4,
      is_subagent: true, parent_conversation_id: s.ids.conv, inbox_adopted_at: 7,
    } as any));
    await s.send("closeSession", [String(s.ids.conv)]);
    const closedAt = (await s.row(s.ids.conv)).inbox_dismissed_at;
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBe(closedAt);
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null } });
    expect((await s.row(s.ids.conv)).inbox_dismissed_at).toBeUndefined();
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
    expect((await s.row(other)).inbox_adopted_at).toBe(7);
  });

  test("any path that brings the lead back releases them: a person writing to it", async () => {
    const s = await withKids();
    await s.send("closeSession", [String(s.ids.conv)]);
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeGreaterThan(0);
    await s.t.run(async (ctx) => {
      // The db the mutation builders hand every handler (functions.ts) carries this wrapper.
      const db = makeAdoptionReleaseDb(ctx.db, ctx.db);
      await enqueuePendingMessage({ ...ctx, db } as any, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", human: true });
    });
    expect((await s.row(s.ids.conv)).inbox_dismissed_at).toBeUndefined();
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
  });

  test("a trigger waking it keeps them: the lead is still out of sight (closeWakeFields)", async () => {
    const s = await withKids();
    await s.send("closeSession", [String(s.ids.conv)]);
    const adopted = (await s.row(s.kids.spawned)).inbox_adopted_at;
    await s.t.run(async (ctx) => {
      const db = makeAdoptionReleaseDb(ctx.db, ctx.db);
      await enqueuePendingMessage({ ...ctx, db } as any, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", origin: "scheduler" });
    });
    expect((await s.row(s.ids.conv)).inbox_stash_hidden).toBe(true);
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBe(adopted);
    // A person stashing the still-hidden lead anew keeps them too.
    await s.t.run(async (ctx) => {
      const db = makeAdoptionReleaseDb(ctx.db, ctx.db);
      await db.patch(s.ids.conv, { inbox_stashed_at: Date.now() + 5, inbox_stash_hidden: true });
    });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBe(adopted);
  });

  for (const order of ["lead first", "child first"] as const) {
    test(`a close the server sets aside drops the adoptions the client sent with it, ${order}`, async () => {
      const s = await withKids();
      // The lead is mid-turn by the server's read; the client thought it idle.
      await s.t.run(async (ctx) => {
        const t = Date.now();
        await ctx.db.patch(s.ids.conv, { updated_at: t } as any);
        await ctx.db.insert("managed_sessions", { session_id: "s-close", conversation_id: s.ids.conv, user_id: s.ids.user, pid: 1, started_at: t, last_heartbeat: t, agent_status: "working", agent_status_updated_at: t } as any);
      });
      const ts = Date.now();
      const lead = [String(s.ids.conv), { inbox_dismissed_at: ts, inbox_closed_at: ts }] as const;
      const kid = [String(s.kids.spawned), { inbox_adopted_at: ts }] as const;
      const rows = order === "lead first" ? [lead, kid] : [kid, lead];
      await s.send("closeSession", [String(s.ids.conv)], Object.fromEntries(rows));
      expect((await s.row(s.ids.conv)).inbox_stashed_at).toBe(ts);
      expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
    });
  }

  // A codex child the daemon linked from the lead's transcript carries --print
  // (a thread_spawn thread or a `codex exec`); one /cli/spawn started does not.
  const codexKid = async (s: any, busy: boolean, cliFlags?: string) => s.t.run(async (ctx: any) => {
    const t = Date.now();
    const c = await ctx.db.insert("conversations", {
      user_id: s.ids.user, agent_type: "codex", started_at: t, updated_at: busy ? t : t - 3_600_000, status: "active", session_id: "019a0000-codex-thread", message_count: 4,
      is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant", ...(cliFlags ? { cli_flags: cliFlags } : {}),
    } as any);
    await ctx.db.insert("managed_sessions", { session_id: "019a0000-codex-thread", conversation_id: c, user_id: s.ids.user, pid: 1, started_at: t, last_heartbeat: t, agent_status: busy ? "working" : "idle", agent_status_updated_at: busy ? t : t - 3_600_000 } as any);
    return c;
  });

  test("a codex child /cli/spawn started under the lead (no spawner session) has its own process: it stays up, adopted", async () => {
    const s = await setup();
    const kid = await codexKid(s, false);
    await s.send("closeSession", [String(s.ids.conv)]);
    const k = (await s.t.run((ctx) => ctx.db.get(kid))) as any;
    expect(k.inbox_dismissed_at).toBeUndefined();
    expect(k.inbox_adopted_at).toBeGreaterThan(0);
  });

  test("a codex child the daemon linked goes down with its lead's close, and mid-turn it sets the close aside", async () => {
    const mk = async (busy: boolean) => {
      const s = await setup();
      const kid = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", {
          user_id: s.ids.user, agent_type: "codex", started_at: t, updated_at: busy ? t : t - 3_600_000, status: "active", session_id: "019a0000-codex-thread", message_count: 4,
          is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant", cli_flags: "--print",
        } as any);
        await ctx.db.insert("managed_sessions", { session_id: "019a0000-codex-thread", conversation_id: c, user_id: s.ids.user, pid: 1, started_at: t, last_heartbeat: t, agent_status: busy ? "working" : "idle", agent_status_updated_at: busy ? t : t - 3_600_000 } as any);
        return c;
      });
      await s.send("closeSession", [String(s.ids.conv)]);
      return { s, kid: (await s.t.run((ctx) => ctx.db.get(kid))) as any };
    };
    const idle = await mk(false);
    expect(isClosedSession(idle.kid)).toBe(true);
    expect(idle.kid.inbox_adopted_at).toBeUndefined();
    const busy = await mk(true);
    expectAside(await busy.s.read());
    expect(busy.kid.inbox_dismissed_at).toBeUndefined();
  });

  test("the release reads the window the cascade adopted from: a recent worker behind 250 older subagents is released", async () => {
    const s = await setup();
    const stamp = Date.now() - 60_000;
    const worker = await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.conv, { inbox_dismissed_at: stamp, inbox_closed_at: stamp } as any);
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: i, updated_at: i, status: "completed", session_id: `agent-a0a0a06f6c64${i}`, message_count: 2, is_subagent: true, parent_conversation_id: s.ids.conv, inbox_dismissed_at: 5, inbox_killed_at: 5 } as any);
      }
      return ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: stamp, updated_at: stamp, status: "active", session_id: "ca19ce3d-recent", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv, inbox_adopted_at: stamp } as any);
    });
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null } });
    const w = (await s.t.run((ctx) => ctx.db.get(worker))) as any;
    expect(w.inbox_adopted_at).toBeUndefined();
  });

  test("adoption checks share the cascade's batches: past the inline budget the rest continue in a scheduled batch", async () => {
    const s = await setup();
    const kids = await s.t.run(async (ctx) => {
      const t = Date.now();
      const out: any[] = [];
      for (let i = 0; i < 30; i++) {
        const sid = `ca19ce3d-live${i}`;
        const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: sid, message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant" } as any);
        await ctx.db.insert("managed_sessions", { session_id: sid, conversation_id: c, user_id: s.ids.user, pid: 10 + i, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
        out.push(c);
      }
      return out;
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    const adopted = async () => (await s.t.run(async (ctx) => Promise.all(kids.map((k) => ctx.db.get(k))))).filter((r: any) => r.inbox_adopted_at).length;
    const inline = await adopted();
    expect(inline).toBeGreaterThan(0);
    expect(inline).toBeLessThan(30);
    const jobs = (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.name.includes("continueCascadeHide") && j.state.kind === "pending");
    expect(jobs.length).toBe(1);
    await s.t.mutation(internal.cleanup.continueCascadeHide, jobs[0]!.args[0] as any);
    expect(await adopted()).toBe(30);
  });

  test("a scheduled adoption batch adopts nothing once the lead is back", async () => {
    const s = await withKids();
    const stamp = Date.now();
    await s.t.run((ctx) => ctx.db.patch(s.ids.conv, { inbox_dismissed_at: undefined } as any));
    await s.t.mutation(internal.cleanup.continueCascadeHide, { lead_id: s.ids.conv, field: "inbox_dismissed_at", stamp, child_ids: [], standing_ids: [String(s.kids.spawned)], close: true });
    await s.t.run((ctx) => ctx.db.patch(s.ids.conv, { inbox_dismissed_at: stamp + 1 } as any));
    await s.t.mutation(internal.cleanup.continueCascadeHide, { lead_id: s.ids.conv, field: "inbox_dismissed_at", stamp, child_ids: [], standing_ids: [String(s.kids.spawned)], close: true });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
  });

  test("a cast-spawned codex worker stays up like any spawned child", async () => {
    const s = await setup();
    const kid = await s.t.run(async (ctx) => {
      const t = Date.now();
      const c = await ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "codex", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: "019a0000-codex-worker", message_count: 4,
        is_subagent: true, parent_conversation_id: s.ids.conv, spawned_by_conversation_id: s.ids.conv, last_message_role: "assistant",
      } as any);
      await ctx.db.insert("managed_sessions", { session_id: "019a0000-codex-worker", conversation_id: c, user_id: s.ids.user, pid: 1, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
      return c;
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    const k = (await s.t.run((ctx) => ctx.db.get(kid))) as any;
    expect(k.inbox_dismissed_at).toBeUndefined();
    expect(k.inbox_adopted_at).toBeGreaterThan(0);
  });

  test("close, then kill from the closed view, then restore: the kill ends the close and releases its adoption", async () => {
    const s = await withKids();
    await s.send("closeSession", [String(s.ids.conv)]);
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeGreaterThan(0);
    await s.send("killSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: Date.now() + 1 } });
    const killedWorker = await s.row(s.kids.spawned);
    expect(killedWorker.inbox_adopted_at).toBeUndefined();
    // The kill takes the worker down with the group: stamped and torn down, not left hidden and running.
    expect(killedWorker.inbox_dismissed_at).toBeGreaterThan(0);
    expect(await s.killed()).toContain(String(s.kids.spawned));
    await s.send("restoreSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null } });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
  });

  test("an adoption reaching a set-aside lead's child on a rail with no close name is dropped too", async () => {
    const s = await withKids();
    const ts = Date.now();
    // The rail carries an adoption when the lead is not set aside.
    await s.send("applyUndoPatches", [], { [String(s.kids.spawned)]: { inbox_adopted_at: ts - 1 } });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBe(ts - 1);
    await s.t.run((ctx) => ctx.db.patch(s.kids.spawned, { inbox_adopted_at: undefined } as any));
    await s.t.run((ctx) => ctx.db.patch(s.ids.conv, { inbox_stashed_at: ts, inbox_closed_at: ts } as any));
    await s.send("applyUndoPatches", [], { [String(s.kids.spawned)]: { inbox_adopted_at: ts } });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
  });

  test("a kill of a closed lead releases once; a later dismissal of a lead whose close has ended reads nothing", async () => {
    const s = await withKids();
    await s.send("closeSession", [String(s.ids.conv)]);
    const scans = await s.t.run(async (ctx) => {
      // Count the release's group reads: each scan queries the parent index once.
      let n = 0;
      const counted = new Proxy(ctx.db, {
        get(target: any, prop) {
          if (prop === "query") return (table: string) => {
            const q = target.query(table);
            return new Proxy(q, { get(qt: any, qp) {
              if (qp === "withIndex") return (name: string, ...rest: any[]) => { if (name === "by_parent_conversation_id") n++; return qt.withIndex(name, ...rest); };
              const v = qt[qp]; return typeof v === "function" ? v.bind(qt) : v;
            } });
          };
          const v = target[prop]; return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const db = makeAdoptionReleaseDb(counted, ctx.db);
      const t2 = Date.now() + 5;
      // A kill writes twice: the dismissed stamp, then applyHideTransition's kill stamp.
      await db.patch(s.ids.conv, { inbox_dismissed_at: t2 });
      await db.patch(s.ids.conv, { inbox_dismissed_at: t2, inbox_killed_at: t2 });
      const afterKill = n;
      // Restored, then dismissed again: the old close is over, nothing to release.
      await db.patch(s.ids.conv, { inbox_dismissed_at: undefined, inbox_killed_at: undefined });
      await db.patch(s.ids.conv, { inbox_dismissed_at: t2 + 5 });
      return { afterKill, total: n };
    });
    expect(scans).toEqual({ afterKill: 1, total: 1 });
    expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
  });

  describe("the server decides a close's adoptions; the client's is a guess", () => {
    test("a deferred batch adopting a child after its lead came back adopts nothing", async () => {
      const s = await withKids();
      const t = Date.now();
      // The lead was closed at t and has since been woken: closed_at stays, dismissal gone.
      await s.t.run((ctx) => ctx.db.patch(s.ids.conv, { inbox_closed_at: t } as any));
      await s.t.mutation(internal.dispatch.applyDeferredPatches, { user_id: s.ids.user, patches: { conversations: { [String(s.kids.spawned)]: { inbox_adopted_at: t } } }, close: true });
      expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBeUndefined();
    });

    for (const order of ["lead first", "child first"] as const) {
      test(`the client's adoption of a live child lands as the cascade's, ${order}`, async () => {
        const s = await withKids();
        const ts = Date.now();
        const lead = [String(s.ids.conv), { inbox_dismissed_at: ts, inbox_closed_at: ts }] as const;
        const kid = [String(s.kids.spawned), { inbox_adopted_at: ts }] as const;
        const rows = order === "lead first" ? [lead, kid] : [kid, lead];
        await s.send("closeSession", [String(s.ids.conv)], Object.fromEntries(rows));
        expect((await s.row(s.kids.spawned)).inbox_adopted_at).toBe(ts);
      });
    }

    // Run every scheduled batch (deferred patches, cascade continuations, outbox drains), checking after each.
    async function drain(s: { t: any }, check: () => Promise<void>) {
      for (let i = 0; i < 20; i++) {
        await check();
        const pending = (await s.t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.state.kind === "pending" || j.state.kind === "inProgress");
        if (pending.length === 0) return;
        await new Promise((r) => setTimeout(r, 20));
        await s.t.finishInProgressScheduledFunctions();
      }
      throw new Error("scheduled work never settled");
    }
    // What the client would see: a child's adoption never written back to unset
    // (sync cargo unsetting it), and once adopted never unadopted.
    function noFlicker(s: { t: any }, kids: any[]) {
      const seen = new Map<string, boolean>();
      return async () => {
        const rows = await s.t.run(async (ctx: any) => Promise.all(kids.map((k) => ctx.db.get(k))));
        for (const r of rows as any[]) {
          if (seen.get(String(r._id)) && !r.inbox_adopted_at) throw new Error(`child ${r._id} went unadopted`);
          if (r.inbox_adopted_at) seen.set(String(r._id), true);
        }
        const unsets = await s.t.run(async (ctx: any) => [
          ...(await ctx.db.query("sync_outbox").collect()).map((a: any) => [a.entity_id, a.cargo?.unset ?? []]),
          ...(await ctx.db.query("sync_actions").collect()).map((a: any) => [a.entity_id, a.unset ?? []]),
        ]);
        const ids = new Set(kids.map(String));
        for (const [entity, unset] of unsets) if (ids.has(entity) && (unset ?? []).includes("inbox_adopted_at")) throw new Error(`child ${entity} was written unadopted`);
      };
    }
    async function liveKids(s: any, lead: any, n: number, prefix: string) {
      return s.t.run(async (ctx: any) => {
        const t = Date.now();
        const out: any[] = [];
        for (let i = 0; i < n; i++) {
          const sid = `ca19ce3d-${prefix}${i}`;
          const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: sid, message_count: 4, is_subagent: true, parent_conversation_id: lead, last_message_role: "assistant" } as any);
          await ctx.db.insert("managed_sessions", { session_id: sid, conversation_id: c, user_id: s.ids.user, pid: 100 + i, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
          out.push(c);
        }
        return out;
      });
    }

    test("30 live spawned children: the client's adoptions land without any child blinking out", async () => {
      const s = await setup();
      const kids = await liveKids(s, s.ids.conv, 30, "k");
      const ts = Date.now();
      await s.send("closeSession", [String(s.ids.conv)], {
        [s.ids.conv]: { inbox_dismissed_at: ts, inbox_closed_at: ts },
        ...Object.fromEntries(kids.map((k: any) => [String(k), { inbox_adopted_at: ts }])),
      });
      await drain(s, noFlicker(s, kids));
      const rows = await s.t.run(async (ctx) => Promise.all(kids.map((k: any) => ctx.db.get(k))));
      expect((rows as any[]).every((r) => r.inbox_adopted_at === ts)).toBe(true);
    });

    test("a bulk close of three leads whose rows wait in later batches: no child blinks out", async () => {
      const s = await setup();
      const leads = await s.t.run(async (ctx) => {
        const t = Date.now();
        const out: any[] = [s.ids.conv];
        for (let i = 0; i < 2; i++) out.push(await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: `s-lead${i}`, message_count: 6, last_message_role: "assistant" } as any));
        // The first lead's Task subagents spend the transaction's teardown budget, so the other leads' rows wait.
        for (let i = 0; i < 20; i++) await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: `agent-a0a0a0737562${i}`, message_count: 3, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
        return out;
      });
      const kids: any[] = [];
      for (const [i, lead] of leads.entries()) kids.push(...await liveKids(s, lead, 5, `l${i}k`));
      const ts = Date.now();
      await s.send("closeSessions", [leads.map(String)], {
        ...Object.fromEntries(leads.map((l: any) => [String(l), { inbox_dismissed_at: ts, inbox_closed_at: ts }])),
        ...Object.fromEntries(kids.map((k: any) => [String(k), { inbox_adopted_at: ts }])),
      });
      const firstTxn = await s.t.run(async (ctx) => Promise.all(leads.map((l: any) => ctx.db.get(l))));
      expect((firstTxn as any[]).some((l) => !l.inbox_dismissed_at)).toBe(true); // a lead's row did wait
      await drain(s, noFlicker(s, kids));
      const rows = await s.t.run(async (ctx) => Promise.all(kids.map((k: any) => ctx.db.get(k))));
      expect((rows as any[]).every((r) => r.inbox_adopted_at === ts)).toBe(true);
      const after = await s.t.run(async (ctx) => Promise.all(leads.map((l: any) => ctx.db.get(l))));
      expect((after as any[]).every((l) => isClosedSession(l))).toBe(true);
    });

    test("a client adoption of a child that goes down with its lead (a teammate) does not keep it up", async () => {
      const s = await setup();
      const mate = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", {
          user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: "5b1e0000-mate", message_count: 4,
          spawned_by_conversation_id: s.ids.conv, agent_team_name: "crew", agent_name: "reviewer", last_message_role: "assistant",
        } as any);
        await ctx.db.insert("managed_sessions", { session_id: "5b1e0000-mate", conversation_id: c, user_id: s.ids.user, pid: 4, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
        return c;
      });
      const ts = Date.now();
      await s.send("closeSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: ts, inbox_closed_at: ts }, [String(mate)]: { inbox_adopted_at: ts } });
      const m = (await s.t.run((ctx) => ctx.db.get(mate))) as any;
      expect(isClosedSession(m)).toBe(true);
      expect(m.inbox_adopted_at).toBeUndefined();
      expect((await s.kills()).map((c: any) => JSON.parse(c.args).conversation_id)).toContain(String(mate));
    });

    test("a bulk close of many big groups keeps each transaction's reads bounded, deferring the rest", async () => {
      const s = await setup();
      const { leads, kids } = await s.t.run(async (ctx) => {
        const t = Date.now();
        const leads: any[] = [];
        const kids: any[] = [];
        for (let l = 0; l < 6; l++) {
          const lead = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: `s-big${l}`, message_count: 6, last_message_role: "assistant" } as any);
          leads.push(lead);
          for (let i = 0; i < 150; i++) {
            kids.push(await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: i, updated_at: i, status: "completed", session_id: `ca19ce3d-b${l}-${i}`, message_count: 2, is_subagent: true, parent_conversation_id: lead } as any));
          }
        }
        return { leads, kids };
      });
      const ts = Date.now();
      const patches = { conversations: {
        ...Object.fromEntries(leads.map((l: any) => [String(l), { inbox_dismissed_at: ts, inbox_closed_at: ts }])),
        ...Object.fromEntries(kids.map((k: any) => [String(k), { inbox_adopted_at: ts }])),
      } };
      const reads = await s.t.run(async (ctx) => {
        const { db, counter } = countingDb(ctx.db);
        await applyPatches({ ...ctx, db } as any, s.ids.user, patches as any, { close: true });
        return counter.reads;
      });
      expect(reads).toBeLessThan(1500);
      const deferred = (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j: any) => j.name.includes("applyDeferredPatches"));
      expect(deferred.length).toBe(1);
    });

    test("a child the client thinks live but the server finds finished is not adopted", async () => {
      const s = await setup();
      const kid = await s.t.run((ctx) => ctx.db.insert("conversations", {
        user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: 1, status: "completed", session_id: "ca19ce3d-done", message_count: 4,
        is_subagent: true, parent_conversation_id: s.ids.conv,
      } as any));
      const ts = Date.now();
      await s.send("closeSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: ts, inbox_closed_at: ts }, [String(kid)]: { inbox_adopted_at: ts } });
      expect(isClosedSession(await s.t.run((ctx) => ctx.db.get(s.ids.conv)) as any)).toBe(true);
      expect(((await s.t.run((ctx) => ctx.db.get(kid))) as any).inbox_adopted_at).toBeUndefined();
      // The server wrote the row with its own value in the same transaction, so
      // the client's lock on its guess settles to it (web syncLogClient.test).
      const outbox = await s.t.run(async (ctx) => (await ctx.db.query("sync_outbox").collect()).filter((a: any) => a.entity_id === String(kid)));
      expect(outbox.some((a: any) => (a.cargo?.unset ?? []).includes("inbox_adopted_at"))).toBe(true);
    });

    test("a child outside the window the server reads (behind 200 newer children) is not adopted", async () => {
      const s = await setup();
      const old = await s.t.run(async (ctx) => {
        const t = Date.now();
        const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 1, updated_at: t, status: "active", session_id: "ca19ce3d-old", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv } as any);
        await ctx.db.insert("managed_sessions", { session_id: "ca19ce3d-old", conversation_id: c, user_id: s.ids.user, pid: 2, started_at: t, last_heartbeat: t, agent_status: "working", agent_status_updated_at: t } as any);
        for (let i = 0; i < 200; i++) {
          await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: 2 + i, updated_at: 2 + i, status: "completed", session_id: `agent-a0a0a06e6577${i}`, message_count: 2, is_subagent: true, parent_conversation_id: s.ids.conv, inbox_dismissed_at: 5, inbox_killed_at: 5 } as any);
        }
        return c;
      });
      const ts = Date.now();
      await s.send("closeSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_dismissed_at: ts, inbox_closed_at: ts }, [String(old)]: { inbox_adopted_at: ts } });
      expect(isClosedSession(await s.t.run((ctx) => ctx.db.get(s.ids.conv)) as any)).toBe(true);
      expect(((await s.t.run((ctx) => ctx.db.get(old))) as any).inbox_adopted_at).toBeUndefined();
    });
  });

  test("killing the lead still takes both children down", async () => {
    const s = await withKids();
    await s.send("killSession", [String(s.ids.conv)]);
    for (const id of [s.kids.agent, s.kids.spawned]) {
      const k = await s.row(id);
      expect(k.inbox_dismissed_at).toBeGreaterThan(0);
      expect(k.inbox_closed_at).toBeUndefined();
      expect(k.inbox_adopted_at).toBeUndefined();
    }
    const killed = await s.killed();
    expect(killed).toContain(String(s.kids.agent));
    expect(killed).toContain(String(s.kids.spawned));
  });
});
