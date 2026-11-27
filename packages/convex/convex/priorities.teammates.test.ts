// Priorities API reads for a teammate (priorities.ts, priorityRead.ts,
// lib/priorityLinks): the owner's order numbered over what the teammate can
// read, the per-workspace cap, Start on a teammate's milestone and its undo,
// and the refs a teammate may see. The shared world is prioritiesWorld.testkit.ts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { hashToken } from "./apiTokens";
import { TEAMMATE_PRIORITIES_CAP } from "./priorityRead";
import { linkFromStart } from "./lib/priorityLinks";
import { readerFor } from "./lib/priorityAccess";
import { sessionPriorityReader } from "./lib/sessionPriority";
import type { Id } from "./_generated/dataModel";
import { DAY, NOW, pri, rowsOf, step, world } from "./prioritiesWorld.testkit";

setDefaultTimeout(60_000);

describe("a teammate's reads", () => {
  test("a teammate reads the owner's order numbered over what they can read, in the list, on the page, on the pin line and on a session's priority alike, so the owner's hidden #1 leaves no gap", async () => {
    const { t, as, ada, bea, acme, ws, p1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(p1, { needs_rewrite: true }));
    const pin = await t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jx7two5")).first())!._id);
    const theirs = await rowsOf(as(bea), { workspace: ws });
    expect(theirs.filter((r: any) => r.status === "active").map((r: any) => [r.short_id, r.rank])).toEqual([["pri-2", 1], ["pri-3", 2]]);
    const listed = theirs.find((r: any) => r.short_id === "pri-2");
    const shown = await as(bea).query(pri.show, { short_id: "pri-2" });
    // The position alone: not the scale behind it, not who set it.
    for (const row of [listed, shown]) expect([row.rank, row.person_pos, row.ai_rank, row.rank_source]).toEqual([1, null, null, null]);
    expect((await as(bea).query(pri.pinLine, { conversation_id: pin }))?.rank).toBe(1);
    // A read of every workspace numbers them the same.
    expect((await rowsOf(as(bea), {})).find((r: any) => r.short_id === "pri-2").rank).toBe(1);
    // The owner reads the same rank from all three.
    const ref = await t.run(async (ctx) => (await sessionPriorityReader(ctx, bea, acme))(await ctx.db.get(pin)));
    expect(ref).toEqual({ id: "pri-2", title: "Priority pri-2", rank: 1, user_id: String(ada) });
    const own = (await rowsOf(as(ada), { workspace: ws })).find((r: any) => r.short_id === "pri-2");
    expect([own.rank, (await as(ada).query(pri.show, { short_id: "pri-2" })).rank, (await as(ada).query(pri.pinLine, { conversation_id: pin })).rank]).toEqual([2, 2, 2]);
    expect([own.ai_rank, own.rank_source]).toEqual([2, "ai"]);
    // The owner's pill reads her real place.
    expect(await t.run(async (ctx) => (await sessionPriorityReader(ctx, ada, acme))(await ctx.db.get(pin)))).toEqual({ ...ref, rank: 2 });
    // A write's echo carries the place, and a teammate's next read follows it, never who placed it.
    expect(await as(ada).mutation(pri.moveTo, { short_id: "pri-2", to: 1 })).toMatchObject({ rank: 1, rank_source: "person" });
    expect((await rowsOf(as(bea), { workspace: ws })).find((r: any) => r.short_id === "pri-2")).toMatchObject({ rank: 1, rank_source: null });
  });

  test("a row carries its owner's face: their own photo, else GitHub's, else none", async () => {
    const { t, as, ada, bea, ws } = await world();
    const face = async () => [(await rowsOf(as(bea), { workspace: ws }))[0].owner_image, (await as(bea).query(pri.show, { short_id: "pri-2" })).owner_image];
    expect(await face()).toEqual([null, null]);
    await t.run(async (ctx) => ctx.db.patch(ada, { github_avatar_url: "https://gh/ada.png" }));
    expect(await face()).toEqual(["https://gh/ada.png", "https://gh/ada.png"]);
    await t.run(async (ctx) => ctx.db.patch(ada, { image: "https://photo/ada.png" }));
    expect(await face()).toEqual(["https://photo/ada.png", "https://photo/ada.png"]);
    expect(await as(ada).mutation(pri.moveTo, { short_id: "pri-2", to: 1 })).toMatchObject({ owner: "Ada", owner_image: "https://photo/ada.png" });
  });

  test("a teammate's access reads only the newest four sessions (failing closed), while the pin line judges the open session alone", async () => {
    const { t, as, ada, bea, acme, p1, c1 } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("conversations", {
          user_id: ada, team_id: acme, agent_type: "claude_code", session_id: `p${i}`, short_id: `jx7pvx${i}`, title: "private",
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, team_visibility: "private", status: "active", priority_id: p1,
        } as any);
      }
    });
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).not.toContain("pri-1");
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1" });
  });

  test("a list judges at most TEAMMATE_PRIORITIES_CAP teammates' priorities, the most recently active, and says so", async () => {
    const { t, ada, bea, acme, ws } = await world();
    const BEA_TOKEN = "cc_test_priorities_bea";
    await t.run(async (ctx) => {
      await ctx.db.insert("api_tokens", { user_id: bea, token_hash: await hashToken(BEA_TOKEN), name: "cli", created_at: NOW, last_used_at: NOW } as any);
      for (let i = 0; i < TEAMMATE_PRIORITIES_CAP; i++) {
        const p = await ctx.db.insert("priorities", {
          user_id: ada, workspace: ws, short_id: `pri-${100 + i}`, title: `More ${i}`, summary: "", status: "active",
          steps: [], first_seen_at: NOW, last_active_at: NOW + i, pass_at: NOW, created_at: NOW, updated_at: NOW,
        } as any);
        await ctx.db.insert("conversations", {
          user_id: ada, team_id: acme, agent_type: "claude_code", session_id: `m${i}`, short_id: `jx7m${i}`, title: "m",
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p,
        } as any);
      }
    });
    const res = await t.query(pri.cliList, { api_token: BEA_TOKEN, team_id: acme });
    expect(res.teammates_truncated).toBe(true);
    expect(res.priorities).toHaveLength(TEAMMATE_PRIORITIES_CAP);
    expect(res.priorities.map((r: any) => r.short_id)).not.toContain("pri-1");
  });

  test("the teammate cap holds per workspace: a read of every workspace returns for each what a read of that one returns", async () => {
    const { t, as, ada, bea, acme, ws } = await world();
    const beta = await t.run(async (ctx) => {
      const beta = await ctx.db.insert("teams", { name: "Beta", created_at: NOW, features: { priorities: true } } as any);
      for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: beta, role: "member", joined_at: 1 } as any);
      const priority = (workspace: string, short_id: string, last_active_at: number) => ctx.db.insert("priorities", {
        user_id: ada, workspace, short_id, title: short_id, summary: "", status: "active", steps: [], first_seen_at: NOW - 40 * DAY, last_active_at, pass_at: NOW, created_at: NOW, updated_at: NOW,
      } as any);
      const listed = (team: Id<"teams">, short_id: string, priority_id: Id<"priorities">) => ctx.db.insert("conversations", {
        user_id: ada, team_id: team, agent_type: "claude_code", session_id: short_id, short_id, title: short_id,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id,
      } as any);
      // Older than every Acme priority, so one cap across both workspaces would crowd it out.
      await listed(beta, "jx7lite", await priority(`team:${beta}`, "pri-90", NOW - 30 * DAY));
      for (let i = 0; i < TEAMMATE_PRIORITIES_CAP; i++) await listed(acme, `jx7h${i}`, await priority(ws, `pri-${100 + i}`, NOW + i));
      return beta;
    });
    const acmeOnly = await as(bea).query(pri.list, { workspace: ws });
    const everywhere = await as(bea).query(pri.list, {});
    const inAcme = (res: any) => res.priorities.filter((r: any) => r.workspace === ws).map((r: any) => [r.short_id, r.rank]);
    expect([acmeOnly.teammates_truncated, everywhere.teammates_truncated]).toEqual([true, true]);
    expect(inAcme(acmeOnly)).toHaveLength(TEAMMATE_PRIORITIES_CAP);
    expect(inAcme(everywhere)).toEqual(inAcme(acmeOnly));
    expect(everywhere.priorities.filter((r: any) => r.workspace === `team:${beta}`).map((r: any) => [r.short_id, r.rank])).toEqual([["pri-90", 1]]);
  });

  test("Start on a teammate's milestone links the new session when the starter can read the priority and milestone, and is refused otherwise", async () => {
    const { t, as, ada, bea, acme, off, ws, p1, dark } = await world();
    let n = 0;
    const start = (short_id: string, step?: string, fields: Record<string, unknown> = {}, starter: Id<"users"> = bea) => t.run(async (ctx) => {
      const conv = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: `start-${n}`, short_id: `jx7st${n++}`, title: "started",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      } as any);
      return { linked: await linkFromStart(ctx, starter, conv, short_id, step), conv: (await ctx.db.get(conv))! };
    });
    const ok = await start("pri-1", "s2");
    expect(ok.linked).toBe(true);
    expect(ok.conv).toMatchObject({ priority_id: p1, priority_step_key: "s2", priority_set_by: "link" });
    // The owner sees it on that milestone, not hers.
    const [row] = await rowsOf(as(ada), { workspace: ws });
    expect(row.links.find((l: any) => l.key === "s2").sessions.find((s: any) => s.short_id === ok.conv.short_id)).toMatchObject({ mine: false, why: ["mapped"] });
    const refused = async (...args: Parameters<typeof start>) => {
      const res = await start(...args);
      expect(res.linked).toBe(false);
      expect(res.conv.priority_id).toBeUndefined();
    };
    // Ada's personal priority, and one in a team Bea is not in: not hers to read.
    await refused("pri-5");
    await refused("pri-6");
    // A session that is not the starter's, and one of hers in another workspace.
    await refused("pri-1", "s2", {}, ada);
    await refused("pri-1", "s2", { team_id: undefined, is_private: true, team_visibility: "private" });
    // A milestone written from a session Bea cannot see is hidden from her: no Start on it.
    await t.run(async (ctx) => {
      const p = (await ctx.db.get(p1))!;
      await ctx.db.patch(p1, { steps: [...p.steps, { ...step("s4", "polish"), refs: [{ kind: "session", id: "jx7pvt3" }] }] });
    });
    await refused("pri-1", "s4");
    // Priorities off in a team Bea is in, though she can read the priority: refused until it is on.
    await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: bea, team_id: off, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("conversations", {
        user_id: ada, team_id: off, agent_type: "claude_code", session_id: "off-1", short_id: "jx7off1", title: "off",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: dark,
      } as any);
    });
    expect(await t.run(async (ctx) => (await readerFor(ctx, bea)).canRead((await ctx.db.get(dark))!))).toBe(true);
    await refused("pri-6", undefined, { team_id: off });
    await t.run(async (ctx) => ctx.db.patch(off, { features: { priorities: true } } as any));
    expect((await start("pri-6", undefined, { team_id: off })).linked).toBe(true);
    // One that needs a rewrite is its owner's alone.
    await t.run(async (ctx) => ctx.db.patch(p1, { needs_rewrite: true }));
    await refused("pri-1", "s2");
  });

  test("a teammate's Start never keeps a priority readable once its owner stops sharing", async () => {
    const { t, as, ada, bea, cy, acme, ws, p1 } = await world();
    const { started, adaMember } = await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: cy, team_id: acme, role: "member", joined_at: 1 } as any);
      const started = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: "start-1", short_id: "jx7beas", title: "started",
        started_at: NOW, updated_at: NOW + 1, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, started, "pri-1", "s2")).toBe(true);
      const adaMember = (await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", ada).eq("team_id", acme)).first())!._id;
      return { started, adaMember };
    });
    const cyReads = async () => (await rowsOf(as(cy), { workspace: ws })).map((r: any) => r.short_id);
    expect(await cyReads()).toContain("pri-1");
    // Ada leaves the team: her sessions are no longer listed to it, and Bea's on pri-1 opens nothing.
    await t.run(async (ctx) => ctx.db.delete(adaMember));
    expect(await cyReads()).toEqual([]);
    expect(await as(cy).query(pri.show, { short_id: "pri-1" })).toBeNull();
    expect(await as(cy).query(pri.pinLine, { conversation_id: started })).toBeNull();
    expect(await t.run(async (ctx) => (await readerFor(ctx, cy)).canRead((await ctx.db.get(p1))!))).toBe(false);
  });

  test("a Start made private no longer names its priority on the pin line to a teammate who can still read the priority", async () => {
    const { t, as, bea, cy, acme, ws, p1 } = await world();
    const started = await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: cy, team_id: acme, role: "member", joined_at: 1 } as any);
      const started = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: "start-pvt", short_id: "jx7beap", title: "started",
        started_at: NOW, updated_at: NOW + 1, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, started, "pri-1", "s2")).toBe(true);
      return started;
    });
    expect(await as(cy).query(pri.pinLine, { conversation_id: started })).toMatchObject({ short_id: "pri-1" });
    await t.run(async (ctx) => ctx.db.patch(started, { is_private: true, team_visibility: "private" } as any));
    // Cy still reads pri-1 through Ada's own sessions, but not through a session hidden from Cy.
    expect((await rowsOf(as(cy), { workspace: ws })).map((r: any) => r.short_id)).toContain("pri-1");
    expect(await as(cy).query(pri.pinLine, { conversation_id: started })).toBeNull();
    // Its starter still sees where it sits.
    expect(await as(bea).query(pri.pinLine, { conversation_id: started })).toMatchObject({ short_id: "pri-1" });
  });

  test("a dozen teammates' Starts crowding the newest sessions never hide the owner's priority: access looks further back", async () => {
    const { t, as, bea, cy, acme, ws, p1 } = await world();
    await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: cy, team_id: acme, role: "member", joined_at: 1 } as any);
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert("conversations", {
          user_id: bea, team_id: acme, agent_type: "claude_code", session_id: `crowd-${i}`, short_id: `jx7cr${String(i).padStart(2, "0")}`, title: `crowd ${i}`,
          started_at: NOW, updated_at: NOW + 1, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p1, priority_set_by: "link",
        } as any);
      }
    });
    expect(await t.run(async (ctx) => (await readerFor(ctx, cy)).canRead((await ctx.db.get(p1))!))).toBe(true);
    expect((await rowsOf(as(cy), { workspace: ws })).map((r: any) => r.short_id)).toContain("pri-1");
  });

  test("a starter takes their own session off a priority they can no longer read, and learns nothing of it but its id", async () => {
    const { t, as, ada, bea, acme, p1 } = await world();
    const started = await t.run(async (ctx) => {
      const conv = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: "start-gone", short_id: "jx7gone", title: "started",
        started_at: NOW, updated_at: NOW + 1, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, conv, "pri-1", "s2")).toBe(true);
      // Ada leaves the team: her sessions no longer list to it, and Bea cannot read pri-1.
      await ctx.db.delete((await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", ada).eq("team_id", acme)).first())!._id);
      return conv;
    });
    expect(await t.run(async (ctx) => (await readerFor(ctx, bea)).canRead((await ctx.db.get(p1))!))).toBe(false);
    expect(await as(bea).mutation(pri.sessionNotThis, { session: "jx7gone" })).toEqual({ short_id: "pri-1" });
    expect((await t.run((ctx) => ctx.db.get(started)))?.priority_id).toBeUndefined();
  });

  test("a teammate's Start can be undone by either side, and the priority it left is counted again", async () => {
    const { t, as, ada, bea, acme, p1 } = await world();
    const startOn = (short_id: string) => t.run(async (ctx) => {
      const conv = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: "started",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, conv, "pri-1", "s2")).toBe(true);
      return conv;
    });
    const conv = (id: Id<"conversations">) => t.run(async (ctx) => (await ctx.db.get(id))!);
    const count = () => t.run(async (ctx) => (await ctx.db.get(p1))!.session_count);
    await t.run(async (ctx) => ctx.db.patch(p1, { session_count: 2 }));
    // Bea says her session is not part of Ada's priority: it leaves and never maps there again.
    const mine = await startOn("jx7bst1");
    expect(await count()).toBe(3);
    await as(bea).mutation(pri.sessionNotThis, { session: "jx7bst1" });
    const left = await conv(mine);
    expect([left.priority_id, left.priority_not]).toEqual([undefined, [p1]]);
    expect(await count()).toBe(2);
    // Ada says Bea's session is not part of hers: unlinked only, Bea's own word on it is left alone.
    const theirs = await startOn("jx7bst2");
    await as(ada).mutation(pri.sessionNotThis, { session: "jx7bst2" });
    const after = await conv(theirs);
    expect([after.priority_id, after.priority_not]).toEqual([undefined, undefined]);
    expect(await count()).toBe(2);
    // Bea moves a started session onto a priority of her own: Ada's count drops.
    const moved = await startOn("jx7bst3");
    const beas = await t.run(async (ctx) => ctx.db.insert("priorities", {
      user_id: bea, workspace: (await ctx.db.get(p1))!.workspace, short_id: "pri-80", title: "Bea's", summary: "", status: "active", steps: [],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, session_count: 0,
    } as any));
    await as(bea).mutation(pri.moveSession, { session: "jx7bst3", short_id: "pri-80" });
    expect((await conv(moved)).priority_id).toBe(beas);
    expect(await count()).toBe(2);
    // Neither may touch a session that is neither theirs nor on a priority of theirs.
    await expect(as(bea).mutation(pri.sessionNotThis, { session: "jx7one1" })).rejects.toThrow();
  });

  test("a teammate sees a step's refs they may read, and not a step written from a session since locked private", async () => {
    const { t, as, ada, bea, acme, ws, p1, c1 } = await world();
    await t.run(async (ctx) => {
      // Another shared session keeps pri-1 readable once jx7one1 is locked.
      await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "keep", short_id: "jx7keep", title: "kept",
        started_at: NOW, updated_at: NOW - 3 * DAY, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p1,
      } as any);
      for (const [short_id, workspace] of [["ct-1", ws], ["ct-2", `user:${ada}`]] as const) {
        await ctx.db.insert("tasks", { short_id, title: short_id, status: "open", task_type: "task", priority: "medium", source: "human", user_id: ada, workspace, created_at: 1, updated_at: 1 } as any);
      }
      await ctx.db.insert("pull_requests", {
        team_id: acme, github_pr_id: 4, repository: "acme/web", number: 4, title: "PR 4", body: "", state: "open",
        author_github_username: "ada", linked_session_ids: [], created_at: NOW, updated_at: NOW, head_ref: "ada/pr-4",
      } as any);
      await ctx.db.patch(p1, { steps: [
        { key: "s1", title: "From the shared session", tier: "critical", tier_set_by: "pass", refs: [{ kind: "session", id: "jx7one1" }], done: false },
        { key: "s2", title: "Mixed", tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: "ct-1" }, { kind: "task", id: "ct-2" }, { kind: "pr", id: "acme/web#4" }, { kind: "pr", id: "elsewhere/x#1" }], done: false },
      ] });
    });
    const stepsOf = async (who: Id<"users">) => (await as(who).query(pri.show, { short_id: "pri-1" })).steps.map((s: any) => [s.key, s.refs.map((r: any) => r.id)]);
    expect(await stepsOf(bea)).toEqual([["s1", ["jx7one1"]], ["s2", ["ct-1", "acme/web#4"]]]);
    await t.run(async (ctx) => ctx.db.patch(c1, { is_private: true, team_visibility: "private" }));
    expect(await stepsOf(bea)).toEqual([["s2", ["ct-1", "acme/web#4"]]]);
    expect((await rowsOf(as(bea), {})).find((r: any) => r.short_id === "pri-1").steps.map((s: any) => s.key)).toEqual(["s2"]);
    // The pin line of the shared session on s1 names no step to her, and names it to the owner.
    const keep = await t.run(async (ctx) => {
      const id = (await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jx7keep")).first())!._id;
      await ctx.db.patch(id, { priority_step_key: "s1" } as any);
      return id;
    });
    const beaPin = await as(bea).query(pri.pinLine, { conversation_id: keep });
    expect(beaPin?.short_id).toBe("pri-1");
    expect(beaPin?.step_title).toBeUndefined();
    expect((await as(ada).query(pri.pinLine, { conversation_id: keep }))?.step_title).toBe("From the shared session");
    // The owner sees every step whole.
    expect((await stepsOf(ada)).map(([key]: any) => key)).toEqual(["s1", "s2"]);
  });

});
