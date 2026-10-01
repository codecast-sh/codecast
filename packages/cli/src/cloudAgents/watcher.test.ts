import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { CloudApiError } from "./http.js";
import { parseMirrorTranscript } from "./transcript.js";
import { CloudAgentSetupError } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";
import { tmp, until, fakeAdapter, FAKE_SPEC, T0, NOW, type FakeAgent } from "../test-helpers/cloudAgentFakes.js";

describe("CloudAgentWatcher", () => {
  test("mirrors, places, primes after a restart, and skips what is settled", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-a": { id: "bc-a", updatedAt: T0, repo: "https://github.com/acme/app", replies: ["hi"] } };
    const { adapter, client } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, resolveRepoDir: async () => null });
    const seen: Array<{ sessionId: string; eventType: string }> = [];
    w.on("session", (e) => seen.push({ sessionId: e.sessionId, eventType: e.eventType }));
    w.setNotice("bc-a", "Started from `main`.");
    await w.poll();
    expect(seen).toEqual([{ sessionId: "bc-a", eventType: "add" }]);
    const msgs = parseMirrorTranscript(fs.readFileSync(w.transcriptPath("bc-a"), "utf8"), { sessionId: "bc-a" });
    expect(msgs.map((m) => m.uuid)).toEqual(["bc-a:p1", "bc-a:notice-start", "bc-a:r0"]);
    // Not a local checkout: a stable placeholder under the provider's dir.
    expect(JSON.parse(fs.readFileSync(path.join(root, "bc-a", "meta.json"), "utf8"))).toEqual({ cwd: "/fake-cloud/acme/app", title: "agent bc-a", createdAtMs: Date.parse(T0), cloud: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, "bc-a", "events.json"), "utf8"))).toEqual({ seen: 1 });

    // Settled at the same version: listed, not re-read.
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toHaveLength(1);
    expect(seen).toHaveLength(1);

    // A new version re-reads; an unchanged render is not re-emitted.
    agents["bc-a"].updatedAt = "2026-09-29T10:00:30.000Z";
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toHaveLength(2);
    expect(seen).toHaveLength(1);

    // A restart announces what is on disk, before any poll, and keeps the adapter's record.
    const restarted = new CloudAgentWatcher(fakeAdapter(agents, { key: () => false }).adapter, { rootDir: root, pollMs: 3_600_000 });
    const primed: string[] = [];
    restarted.on("session", (e) => primed.push(`${e.sessionId} ${e.eventType}`));
    restarted.start();
    restarted.stop();
    expect(primed).toEqual(["bc-a add"]);
  });

  test("a running agent is mirrored every poll; a format bump re-renders everything once and primes nothing", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-r": { id: "bc-r", updatedAt: T0, running: true, replies: ["working"] } };
    const { adapter, client } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    await w.poll();
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toHaveLength(2);
    agents["bc-r"].running = false;
    await w.poll();
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toHaveLength(3);

    const bumped = fakeAdapter(agents, { format: 2 });
    const w2 = new CloudAgentWatcher(bumped.adapter, { rootDir: root, now: NOW, pollMs: 3_600_000 });
    const primed: string[] = [];
    w2.on("session", (e) => primed.push(e.sessionId));
    w2.start();
    w2.stop();
    expect(primed).toEqual([]);
    await w2.poll();
    expect(bumped.client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-r"]);
    // Re-rendered, it is announced even when the render came out the same (its session is hosted).
    expect(primed).toEqual(["bc-r"]);
  });

  test("a format bump reaches mirrors past the window by id; one it cannot re-render is announced as it stands", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = {
      "bc-old": { id: "bc-old", updatedAt: T0, replies: ["old"] },
      "bc-gone": { id: "bc-gone", updatedAt: T0, replies: ["gone"] },
    };
    await new CloudAgentWatcher(fakeAdapter(agents).adapter, { rootDir: root, now: NOW }).poll();
    delete agents["bc-gone"];
    const bumped = fakeAdapter(agents, { format: 2 });
    const later = () => NOW() + 40 * 24 * 3600_000;
    const w = new CloudAgentWatcher(bumped.adapter, { rootDir: root, now: later, pollMs: 3_600_000 });
    const seen: string[] = [];
    w.on("session", (e) => seen.push(e.sessionId));
    w.start();
    w.stop();
    await w.poll();
    expect(bumped.client.calls.filter((c) => c.startsWith("mirror")).sort()).toEqual(["mirror bc-gone (unlisted)", "mirror bc-old (unlisted)"]);
    expect(seen.sort()).toEqual(["bc-gone", "bc-old"]);
    await w.poll();
    expect(bumped.client.calls.filter((c) => c.startsWith("mirror"))).toHaveLength(2);
  });

  test("a running agent the list stops showing is mirrored by id until it settles", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-r": { id: "bc-r", updatedAt: T0, running: true, replies: ["working"] } };
    const { adapter, client } = fakeAdapter(agents);
    const list = adapter.listAgents.bind(adapter);
    let archived = false;
    adapter.listAgents = async (c) => ({ items: (await list(c)).items.filter((i) => !archived || i.id !== "bc-r") });
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    await w.poll();
    archived = true;
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-r", "mirror bc-r (unlisted)"]);
    agents["bc-r"].running = false;
    await w.poll();
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-r", "mirror bc-r (unlisted)", "mirror bc-r (unlisted)"]);
    const tail = fs.readFileSync(w.transcriptPath("bc-r"), "utf8").trim().split("\n").at(-1)!;
    expect(JSON.parse(tail).type).toBe("turn_ended");
  });

  test("a running agent no mirror reaches is let go, and announced again once one does", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-r": { id: "bc-r", updatedAt: T0, running: true, replies: ["working"] } };
    let key = true;
    let now = NOW();
    const { adapter } = fakeAdapter(agents, { key: () => key });
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: () => now });
    const events: string[] = [];
    w.on("session", (e) => events.push(`session ${e.sessionId}`));
    w.on("unfollowed", (id) => events.push(`unfollowed ${id}`));
    await w.poll();
    key = false;
    now += 60_000;
    await w.poll();
    expect(events).toEqual(["session bc-r"]);
    now += 3 * 60_000;
    await w.poll();
    expect(events).toEqual(["session bc-r", "unfollowed bc-r"]);
    key = true;
    await w.poll();
    // The render did not change; the session is announced so it is hosted again.
    expect(events).toEqual(["session bc-r", "unfollowed bc-r", "session bc-r"]);
  });

  test("what keeps the machine from reading the provider is kept, and cleared once it reads again", async () => {
    const { adapter } = fakeAdapter({});
    const list = adapter.listAgents.bind(adapter);
    let refuse = true;
    adapter.listAgents = async (c) => { if (refuse) throw new CloudApiError(401, undefined, "token revoked"); return list(c); };
    const w = new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW });
    w.on("error", () => {});
    await w.poll();
    await w.poll();
    expect(w.setupProblem?.kind).toBe("key_invalid");
    expect(w.setupProblem?.reason).toBe("token revoked");
    refuse = false;
    await w.poll();
    expect(w.setupProblem).toBeNull();

    // With nothing to import, a refusal is still asked again (one list call an idle poll), so a replaced key lifts it.
    refuse = true;
    const off = new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW, importAll: () => false, ownAgents: () => new Set() });
    off.on("error", () => {});
    off.setRemoteSetup(CloudAgentSetupError.credentialsRejected(adapter, "token revoked"));
    await off.poll();
    expect(off.setupProblem?.kind).toBe("key_invalid");
    refuse = false;
    await off.poll();
    expect(off.setupProblem).toBeNull();

    // With nothing to read, the sign-in on disk is still read: signing in clears "no sign-in" without a list call.
    let key = false;
    const idle = fakeAdapter({}, { key: () => key });
    const quiet = new CloudAgentWatcher(idle.adapter, { rootDir: tmp(), now: NOW, importAll: () => false, ownAgents: () => new Set() });
    await quiet.poll();
    expect(quiet.setupProblem?.kind).toBe("key_missing");
    key = true;
    await quiet.poll();
    expect(quiet.setupProblem).toBeNull();
    expect(idle.client.calls).toEqual([]);
  });

  test("import off mirrors only own agents; children are found through their parent; git is emitted once", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = {
      "bc-mine": { id: "bc-mine", updatedAt: T0, children: ["bc-child"], branch: "feat/x", replies: ["ok"] },
      "bc-theirs": { id: "bc-theirs", updatedAt: T0, replies: ["ok"] },
      "bc-child": { id: "bc-child", updatedAt: T0, replies: ["worker done"] },
    };
    const { adapter, client } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, importAll: () => false, ownAgents: () => new Set(["bc-mine"]) });
    const git: unknown[] = [];
    w.on("git", (g) => git.push(g));
    await w.poll();
    // The child is mirrored in the background once its parent names it.
    await until(() => git.some((g: any) => g.agentId === "bc-child"));
    expect(client.calls).toContain("mirror bc-child (unlisted)");
    expect(client.calls.some((c) => c.includes("bc-theirs"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "bc-child", "meta.json"), "utf8"))).toMatchObject({ parentAgentId: "bc-mine", description: "a worker" });
    agents["bc-mine"].updatedAt = "2026-09-29T10:00:30.000Z";
    await w.poll();
    // Once each, however many passes: the parent's branch, and the child's none.
    expect(git).toHaveLength(2);
    expect(git).toContainEqual({ agentId: "bc-mine", branch: "feat/x" });
    expect(git).toContainEqual({ agentId: "bc-child" });
  });

  test("without import, the list is read only until each of codecast's own agents has been seen", async () => {
    const agents: Record<string, FakeAgent> = { "bc-mine": { id: "bc-mine", updatedAt: T0, replies: ["ok"] }, "bc-theirs": { id: "bc-theirs", updatedAt: T0, replies: ["ok"] } };
    const { adapter, client } = fakeAdapter(agents);
    // Two pages: codecast's agent on the first.
    const paged: typeof adapter = {
      ...adapter,
      async listAgents(c, cursor) {
        c.calls.push(`list ${cursor ?? "first"}`);
        const a = agents[cursor ? "bc-theirs" : "bc-mine"];
        return { items: [{ id: a.id, updatedAtMs: Date.parse(a.updatedAt), version: a.updatedAt, active: false, agent: a }], nextCursor: cursor ? undefined : "p2" };
      },
    };
    const lists = () => client.calls.filter((c) => c.startsWith("list"));
    await new CloudAgentWatcher(paged, { rootDir: tmp(), now: NOW, importAll: () => false, ownAgents: () => new Set(["bc-mine"]) }).poll();
    expect(lists()).toEqual(["list first"]);
    client.calls.length = 0;
    await new CloudAgentWatcher(paged, { rootDir: tmp(), now: NOW, importAll: () => true }).poll();
    expect(lists()).toEqual(["list first", "list p2"]);
  });

  test("a child that moved while the lane was paused is mirrored once it resumes, not left at its old version", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = {
      "bc-mine": { id: "bc-mine", updatedAt: T0, children: ["bc-child"], replies: ["ok"] },
      "bc-child": { id: "bc-child", updatedAt: T0, replies: ["first"] },
    };
    const { adapter } = fakeAdapter(agents);
    // Children that say when they move.
    const versioned: typeof adapter = { ...adapter, async mirror(c, h, known) {
      const m = await adapter.mirror(c, h, known);
      return m && { ...m, children: m.children?.map((ch) => ({ ...ch, version: agents[ch.agentId].updatedAt })) };
    } };
    let clock = NOW();
    const w = new CloudAgentWatcher(versioned, { rootDir: root, now: () => clock, importAll: () => true });
    await w.poll();
    await until(() => fs.existsSync(w.transcriptPath("bc-child")));
    // Paused on the parent; both move meanwhile.
    w.setRemoteSetup(CloudAgentSetupError.changed(versioned, "x"), "bc-mine");
    const later = "2026-09-29T10:00:30.000Z";
    agents["bc-mine"].updatedAt = later;
    Object.assign(agents["bc-child"], { updatedAt: later, replies: ["second"] });
    clock += 5 * 60_000 + 1;
    await w.poll();
    expect(w.setupProblem).toBeNull();
    await until(() => fs.readFileSync(w.transcriptPath("bc-child"), "utf8").includes("second"));
  });

  test("a child its parent no longer has is forgotten, not read again every pass", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-mine": { id: "bc-mine", updatedAt: T0, children: ["bc-child"], replies: ["ok"] } };
    const { adapter, client } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, importAll: () => true });
    await w.poll();
    await new Promise((r) => setTimeout(r, 20));
    // The child was never there to mirror (null): its state entry goes, and later passes do not ask again.
    expect(JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")).agents["bc-child"]).toBeUndefined();
    client.calls.length = 0;
    await w.poll();
    expect(client.calls.some((c) => c.includes("bc-child"))).toBe(false);
  });

  test("a branch the agent no longer names is reported gone, and a restart says so again", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-a": { id: "bc-a", updatedAt: T0, branch: "feat/a", replies: ["ok"] } };
    const { adapter } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    const git: unknown[] = [];
    w.on("git", (g) => git.push(g));
    await w.poll();
    agents["bc-a"] = { ...agents["bc-a"], branch: undefined, updatedAt: "2026-09-29T10:00:30.000Z" };
    await w.poll();
    expect(git).toEqual([{ agentId: "bc-a", branch: "feat/a" }, { agentId: "bc-a" }]);
    const again = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    const replayed: unknown[] = [];
    again.on("git", (g) => replayed.push(g));
    again.start();
    again.stop();
    expect(replayed).toEqual([{ agentId: "bc-a" }]);
  });

  test("a branch the adapter cannot tell about is kept, not reported gone", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-a": { id: "bc-a", updatedAt: T0, branch: "feat/a", replies: ["ok"] } };
    const { adapter } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    const git: unknown[] = [];
    w.on("git", (g) => git.push(g));
    await w.poll();
    agents["bc-a"] = { ...agents["bc-a"], gitUnknown: true, updatedAt: "2026-09-29T10:00:30.000Z" };
    await w.poll();
    expect(git).toEqual([{ agentId: "bc-a", branch: "feat/a" }]);
    const again = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    const replayed: unknown[] = [];
    again.on("git", (g) => replayed.push(g));
    again.start();
    again.stop();
    expect(replayed).toEqual([{ agentId: "bc-a", branch: "feat/a" }]);
  });

  test("a repo given as owner/name places the session like a URL", async () => {
    const root = tmp();
    const { adapter } = fakeAdapter({ "bc-x": { id: "bc-x", updatedAt: T0, replies: ["ok"] } });
    const mirror = adapter.mirror.bind(adapter);
    adapter.mirror = async (c, h, k) => ({ ...(await mirror(c, h, k))!, repoUrl: undefined, repo: "acme/app" });
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, resolveRepoDir: async (r) => `/src/${r.name}` });
    await w.follow("bc-x");
    expect(JSON.parse(fs.readFileSync(path.join(root, "bc-x", "meta.json"), "utf8")).cwd).toBe("/src/app");
  });

  test("no credentials: nothing is listed, and the skip is logged once until they appear", async () => {
    let key = false;
    const { adapter, client } = fakeAdapter({}, { key: () => key });
    const logs: string[] = [];
    const w = new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW, log: (m) => logs.push(m) });
    await w.poll();
    await w.poll();
    expect(client.calls).toEqual([]);
    expect(logs).toEqual(["[fake-cloud] not polling: Fake Cloud needs a key."]);
    key = true;
    await w.poll();
    expect(client.calls).toEqual(["list"]);
    expect(logs).toEqual(["[fake-cloud] not polling: Fake Cloud needs a key.", "[fake-cloud] credentials found, polling"]);
  });

  test("an agent older than the backfill horizon is not read; versions are opaque", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = {
      "bc-old": { id: "bc-old", updatedAt: "2026-07-01T00:00:00.000Z", replies: ["old"] },
      "bc-v": { id: "bc-v", updatedAt: T0, replies: ["v"] },
    };
    const { adapter, client } = fakeAdapter(agents);
    const list = adapter.listAgents.bind(adapter);
    // The list gives each agent a time and a version that is not a date.
    const mirror = adapter.mirror.bind(adapter);
    adapter.listAgents = async (c) => ({ items: (await list(c)).items.map((i) => ({ ...i, version: `v:${i.version}` })) });
    adapter.mirror = async (c, h, k) => { const m = (await mirror(c, h, k))!; return { ...m, version: `v:${m.version}` }; };
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW });
    await w.poll();
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-v"]);
  });

  test("a list ordered by creation reads past the horizon: an old agent that runs now, or moved since its mirror, is read", async () => {
    const OLD = "2026-07-01T00:00:00.000Z";
    const agents: Record<string, FakeAgent> = {
      "bc-old": { id: "bc-old", updatedAt: OLD, replies: ["old"] },
      "bc-woke": { id: "bc-woke", updatedAt: OLD, running: true, replies: ["again"] },
    };
    const { adapter, client } = fakeAdapter(agents);
    const list = adapter.listAgents.bind(adapter);
    // Newest created first, a page each; an agent's time is its creation.
    adapter.listAgents = async (c, cursor) => { const { items } = await list(c); return cursor ? { items: items.slice(1) } : { items: items.slice(0, 1), nextCursor: "p2" }; };
    const w = new CloudAgentWatcher(Object.assign(adapter, { listedByCreation: true }), { rootDir: tmp(), now: NOW });
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-woke"]);
    // It settled (a new version, the same old time): read once more, then left alone.
    agents["bc-woke"] = { ...agents["bc-woke"], running: false, updatedAt: "2026-07-01T00:00:01.000Z" };
    await w.poll();
    await w.poll();
    expect(client.calls.filter((c) => c.startsWith("mirror"))).toEqual(["mirror bc-woke", "mirror bc-woke"]);
  });

  test("a 403 on one agent is that agent's alone: the lane keeps running, and the key is never reported refused", async () => {
    const agents: Record<string, FakeAgent> = {
      "bc-a": { id: "bc-a", updatedAt: T0, running: true, replies: [] },
      "bc-b": { id: "bc-b", updatedAt: T0, replies: ["done"] },
    };
    const { adapter } = fakeAdapter(agents);
    const mirror = adapter.mirror.bind(adapter);
    adapter.mirror = async (c, h, known) => { if (h.agentId === "bc-a") throw new CloudApiError(403, "forbidden", "You do not have access to this agent"); return mirror(c, h, known); };
    const w = new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW });
    w.on("error", () => {});
    for (let i = 0; i < 3; i++) {
      await w.poll();
      expect(w.setupProblem).toBeNull();
    }
    expect(fs.existsSync(w.transcriptPath("bc-b"))).toBe(true);
    // The same answer to the list is the credentials' (every agent alike).
    adapter.listAgents = async () => { throw new CloudApiError(403, "forbidden", "You do not have access"); };
    await w.poll();
    expect(w.setupProblem?.kind).toBe("key_invalid");
  });

  test("an agent deleted on the provider keeps its mirror and is never read again", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-r": { id: "bc-r", updatedAt: T0, running: true, replies: ["working"] } };
    const { adapter, client } = fakeAdapter(agents);
    const logs: string[] = [];
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, log: (m) => logs.push(m) });
    const events: string[] = [];
    w.on("unfollowed", (id) => events.push(`unfollowed ${id}`));
    w.on("error", (e) => events.push(`error ${e.message}`));
    await w.poll();
    // Deleted: the list no longer shows it, and a read of it answers 404.
    adapter.listAgents = async () => ({ items: [] });
    adapter.mirror = async (c, h) => { c.calls.push(`mirror ${h.agentId} (gone)`); throw new CloudApiError(404, "not_found", "No managed agent resource found"); };
    await w.poll();
    await w.poll();
    await w.follow("bc-r");
    expect(client.calls.filter((c) => c.endsWith("(gone)"))).toEqual(["mirror bc-r (gone)", "mirror bc-r (gone)"]);
    expect(events).toEqual(["unfollowed bc-r"]);
    expect(logs.filter((l) => l.includes("is gone"))).toEqual(["[fake-cloud] bc-r is gone on Fake Cloud: keeping its mirror as it is", "[fake-cloud] bc-r is gone on Fake Cloud: keeping its mirror as it is"]);
    expect(fs.existsSync(w.transcriptPath("bc-r"))).toBe(true);
    await until(() => JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")).agents["bc-r"]?.gone === true);
  });
});
