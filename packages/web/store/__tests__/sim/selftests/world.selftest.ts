// World and actors self-test (docs/architecture/multiplayer-sim-harness.md,
// unit U10): genesis lands a clean multi-team world through real handlers,
// and every actor verb reaches the function production calls.

import { afterEach, describe, expect, test } from "bun:test";
import { installRealm, uninstallRealm } from "../realm";
import { SimWorld } from "../world";

afterEach(() => uninstallRealm());

// acme {ada (admin), bo}, beta {cy (admin), ada}: three users, two teams, one
// user in both. Work items hang off a private and a shared session.
function threeUsersTwoTeams(seed = 1): SimWorld {
  installRealm(seed);
  const w = new SimWorld({ seed, rowsPerUser: 4 });
  w.team("acme", { features: { chat: true, org: true } }).team("beta");
  w.user("ada", ["acme", "beta"]).user("bo", ["acme"]).user("cy", ["beta"]);
  w.session("ada", "s", { agentStatus: "working" });
  w.session("ada", "p", { private: true });
  w.session("bo", "s", { agentStatus: "idle" });
  w.task("acme/t1", { owner: "ada", session: "ada/p" });
  w.task("acme/t2", { owner: "ada", session: "ada/s" });
  w.doc("acme/d1", { owner: "bo", session: "bo/s" });
  w.plan("beta/p1", { owner: "cy" });
  w.trigger("ada/tr1", { owner: "ada", session: "ada/s" });
  w.role("acme", "reviewer");
  return w;
}

// Genesis and device boots run hundreds of real handler calls; the machine
// these run on is often loaded.
const SLOW = 60_000;

const callNames = (w: SimWorld) => w.backend.calls.map((c) => c.name);

describe("world", () => {
  test("genesis for 3 users and 2 teams passes the teamScopeSweep gate", async () => {
    const w = threeUsersTwoTeams();
    await w.start();

    const sweep = await w.sweepFindings();
    expect(sweep).toEqual({ findings: [], missing: 0, writes: 0 });

    const db = w.backend.db._tables;
    // Memberships went through the change log: one scope_added per membership
    // (the role's bot joins acme too, through the hire).
    const people = new Set(["ada", "bo", "cy"].map((u) => w.idOf(u)));
    const memberships = db.team_memberships.filter((m: any) => people.has(m.user_id));
    expect(memberships).toHaveLength(4);
    const scopeAdded = (db.sync_actions ?? []).filter((a: any) => a.op === "scope_added");
    expect(scopeAdded.length).toBe(db.team_memberships.length);
    // Every conversation was stamped through patchConversationVisibility.
    for (const conv of db.conversations) expect(typeof conv.is_private).toBe("boolean");
    expect((await w.row("ada/p")).is_private).toBe(true);
    expect((await w.row("ada/s")).team_id).toBe(w.idOf("acme"));
    // Work items carry the key their session's visibility gives them.
    expect((await w.row("task:acme/t1")).workspace).toBe(`user:${w.idOf("ada")}`);
    expect((await w.row("task:acme/t2")).workspace).toBe(`team:${w.idOf("acme")}`);
    expect((await w.row("doc:acme/d1")).workspace).toBe(`team:${w.idOf("acme")}`);
    expect((await w.row("plan:beta/p1")).workspace).toBeString();
    expect((await w.row("trigger:ada/tr1")).status).toBe("scheduled");
    expect(w.labels.has("chan:acme/general")).toBe(true);
    expect(w.labels.has("role:acme/reviewer")).toBe(true);
    expect(w.backend.calls.every((c) => c.ok)).toBe(true);
  }, SLOW);

  test("one run twice in a row ends in the same world (no cache leaks between runs)", async () => {
    const run = async (seed: number) => {
      const w = threeUsersTwoTeams(seed);
      const ada = await w.device("ada");
      w.actors.human(ada.host).pin("ada/s");
      w.actors.daemon("ada").settles("ada/s", "idle");
      await w.settle();
      const out = JSON.stringify({ tables: w.backend.db._tables, order: w.net.orderSoFar(), calls: w.backend.calls });
      uninstallRealm();
      return out;
    };
    const a = await run(7);
    expect(await run(7)).toBe(a);
    expect(await run(8)).not.toBe(a);
  }, SLOW);

  test("a daemon token principal can claimTask", async () => {
    const w = threeUsersTwoTeams();
    const daemon = w.actors.daemon("ada");
    daemon.claimTask("trigger:ada/tr1");
    await w.settle();

    const id = w.idOf("trigger:ada/tr1");
    expect(daemon.leases).toEqual([id]);
    expect((await w.row("trigger:ada/tr1")).status).toBe("running");
    const claim = w.backend.calls.find((c) => c.name === "agentTasks:claimTask")!;
    expect(claim).toMatchObject({ ok: true, principal: { kind: "token", userId: w.idOf("ada") } });
    expect(callNames(w)).toContain("agentTasks:getDueTasks");
  }, SLOW);

  test("every daemon, agent, admin and clock verb reaches its named function", async () => {
    const w = threeUsersTwoTeams();
    await w.start();
    const { actors } = w;
    const daemon = actors.daemon("ada");
    const t0 = w.realm.now();
    const expected: [() => number, string[]][] = [
      [() => daemon.settles("ada/s", "idle"), ["managedSessions:updateAgentStatus"]],
      [() => daemon.heartbeat("ada/s"), ["managedSessions:heartbeat"]],
      [() => daemon.restart(["ada/s"]), ["managedSessions:registerManagedSession"]],
      [() => daemon.claimPending("ada/s"), ["pendingMessages:getPendingMessagesForDaemon"]],
      [() => daemon.ack("ada/s"), ["pendingMessages:ackInjectedMessages"]],
      [() => daemon.resume("ada/s"), ["users:resumeSession"]],
      [() => daemon.claimTask(), ["agentTasks:getDueTasks"]],
      [() => actors.agent("ada/s").says("acme/general", "hello", ["bo"]), ["chat:sendMessage"]],
      [() => actors.admin("ada").remove("acme", "bo"), ["teams:removeMember"]],
    ];
    for (const [run, names] of expected) {
      const before = w.backend.calls.length;
      run();
      await w.settle();
      const reached = w.backend.calls.slice(before).map((c) => c.name);
      for (const name of names) expect(reached).toContain(name);
    }
    actors.clock.advance(60_000);
    await w.settle();
    expect(w.realm.now()).toBeGreaterThanOrEqual(t0 + 60_000);

    // The server accepted every verb; a refusal would be logged with its reason.
    expect(actors.log.filter((e) => !e.ok)).toEqual([]);
    expect((await w.row("ada/s")).inbox_dismissed_at).toBeUndefined();
    const agentLine = w.backend.db._tables.chat_messages?.find((m: any) => m.origin === "agent");
    expect(agentLine).toBeDefined();
    const bo = w.idOf("bo");
    expect(w.backend.db._tables.team_memberships.some((m: any) => m.user_id === bo && m.team_id === w.idOf("acme"))).toBe(false);
  }, SLOW);

  test("every human verb reaches dispatch:dispatch, and the daemon delivers what a human sent", async () => {
    const w = threeUsersTwoTeams();
    const ada = await w.device("ada", { followers: 1 });
    const bo = await w.device("bo", { scope: { team: "acme" } });
    const { actors } = w;
    const host = actors.human(ada.host);
    const follower = actors.human(ada.followers[0]);
    const mate = actors.human(bo.host);

    // Each verb, then what it left on the server.
    const steps: [string, () => number, () => Promise<unknown>][] = [
      ["pin", () => host.pin("ada/s"), async () => expect((await w.row("ada/s")).inbox_pinned_at).toBeNumber()],
      ["stash", () => follower.stash("ada/p"), async () => expect((await w.row("ada/p")).inbox_stashed_at).toBeNumber()],
      ["restore", () => host.restore("ada/p"), async () => expect((await w.row("ada/p")).inbox_stashed_at).toBeUndefined()],
      ["send", () => host.send("ada/s", "hello from the sim"), async () =>
        expect(w.backend.db._tables.pending_messages.some((m: any) => m.content === "hello from the sim")).toBe(true)],
      ["revive", () => host.revive("ada/p"), async () =>
        expect(w.backend.db._tables.pending_messages.some((m: any) => m.conversation_id === w.idOf("ada/p") && m.content === "continue")).toBe(true)],
      ["setPrivacy", () => host.setPrivacy("ada/s", "private"), async () => expect((await w.row("ada/s")).is_private).toBe(true)],
      ["setPrivacy back", () => host.setPrivacy("ada/s", "team"), async () => expect((await w.row("ada/s")).is_private).toBe(false)],
      ["kill (a teammate's session)", () => mate.kill("ada/s"), async () =>
        expect(w.backend.db._tables.inbox_hides.some((h: any) => h.user_id === w.idOf("bo") && h.conversation_id === w.idOf("ada/s"))).toBe(true)],
      ["chat", () => mate.chat("acme/general", "standup in 5"), async () =>
        expect(w.backend.db._tables.chat_messages.some((m: any) => m.content === "standup in 5")).toBe(true)],
      ["tellRole", () => host.tellRole("role:acme/reviewer", "take a look"), async () =>
        expect(w.backend.db._tables.chat_messages.some((m: any) => m.content === "@reviewer take a look")).toBe(true)],
    ];
    for (const [name, run, effect] of steps) {
      const before = w.backend.calls.length;
      run();
      await w.settle();
      const reached = w.backend.calls.slice(before).filter((c) => c.name === "dispatch:dispatch");
      expect({ name, reached: reached.length > 0, failed: reached.filter((c) => !c.ok).map((c) => c.error) }).toEqual({ name, reached: true, failed: [] });
      await effect().catch((e) => {
        throw new Error(`after ${name}: ${e?.message ?? e}`);
      });
    }

    // The daemon takes the sent message through claim, paste and ack.
    const daemon = actors.daemon("ada");
    const before = w.backend.calls.length;
    daemon.claimPending("ada/s");
    await w.settle();
    expect(daemon.claimed.get(w.idOf("ada/s"))).toHaveLength(1);
    daemon.ack("ada/s");
    await w.settle();
    const reached = w.backend.calls.slice(before).map((c) => c.name);
    for (const name of [
      "pendingMessages:getPendingMessagesForDaemon",
      "pendingMessages:claimPendingMessageForDelivery",
      "pendingMessages:updateMessageStatus",
      "pendingMessages:ackInjectedMessages",
    ]) expect(reached).toContain(name);
    expect(actors.log.filter((e) => !e.ok)).toEqual([]);
    for (const win of w.windows.values()) expect({ win: win.name, errors: win.errors }).toEqual({ win: win.name, errors: [] });
  }, SLOW);
});
