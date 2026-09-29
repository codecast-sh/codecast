import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { parseCursorTranscriptFile } from "../parser.js";
import { CloudAgentRegistry } from "./registry.js";
import { MirrorTranscript } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, type CloudAgentAdapter, type CloudAgentMirror } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-agents-core-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

interface FakeAgent { id: string; updatedAt: string; running?: boolean; repo?: string; children?: string[]; branch?: string; replies: string[] }
interface FakeClient { calls: string[] }

/**
 * A provider that serves agents from a table: every mirror renders a prompt
 * and its replies, and records how often it was asked.
 */
function fakeAdapter(agents: Record<string, FakeAgent>, opts: { key?: () => boolean; format?: number } = {}) {
  const client: FakeClient = { calls: [] };
  const adapter: CloudAgentAdapter<FakeClient, FakeAgent, { seen: number }> & { client(): FakeClient | null } = {
    spec: CLOUD_AGENT_PROVIDERS.cursor,
    dir: "fake-cloud",
    mirrorFormat: opts.format ?? 1,
    credentialsMissing: "Fake Cloud needs a key.",
    credentialHoldReason: "waiting for a fake key",
    client: () => (opts.key?.() ?? true ? client : null),
    isAgentId: (id) => id.startsWith("bc-"),
    loadData: (raw: any) => ({ seen: typeof raw?.seen === "number" ? raw.seen : 0 }),
    async listAgents(c) {
      c.calls.push("list");
      return { items: Object.values(agents).filter((a) => !a.id.includes("child")).map((a) => ({ id: a.id, updatedAt: a.updatedAt, active: !!a.running, agent: a })) };
    },
    async mirror(c, handle, known): Promise<CloudAgentMirror | null> {
      c.calls.push(`mirror ${handle.agentId}${known ? "" : " (unlisted)"}`);
      const a = known ?? agents[handle.agentId];
      if (!a) return null;
      handle.data().seen++;
      handle.save();
      const tx = new MirrorTranscript(Date.parse(T0));
      tx.user("p1", "hello");
      const notice = await handle.notice();
      if (notice) tx.notice(notice);
      a.replies.forEach((r, i) => tx.assistant(`r${i}`, r));
      if (!a.running) tx.turnEnded();
      return {
        transcript: tx.toString(),
        title: `agent ${a.id}`,
        createdAtMs: Date.parse(T0),
        repoUrl: a.repo,
        updatedAt: a.updatedAt,
        running: !!a.running,
        git: a.branch ? { agentId: a.id, branch: a.branch } : null,
        children: (a.children ?? []).map((agentId) => ({ agentId, description: "a worker" })),
      };
    },
    async create(c, session, content) { c.calls.push(`create ${content} ${session.repoUrl ?? ""}`); return { agentId: "bc-new", url: "https://x/bc-new" }; },
    async followUp(c, agentId, content) {
      c.calls.push(`followUp ${agentId} ${content}`);
      if (content === "busy") throw new CloudAgentBusyError("Fake Cloud");
      if (content === "denied") throw Object.assign(new Error("401"), { status: 401 });
    },
    async cancel(c, agentId) { c.calls.push(`cancel ${agentId}`); return agents[agentId]?.running ? "turn t1" : null; },
    setupErrorOf: (err: any) => (err?.status === 401 ? new CloudAgentSetupError(adapter, "key_invalid", "Fake Cloud rejected the key.") : null),
  };
  return { adapter, client };
}

const T0 = "2026-09-29T10:00:00.000Z";
const NOW = () => Date.parse(T0) + 60_000;

describe("MirrorTranscript", () => {
  test("streamed text joins one row, id'd and dated by its first piece; a call keeps one row", () => {
    const tx = new MirrorTranscript(1_000);
    tx.user("u1", "go");
    tx.clock = 2_000;
    tx.appendText("e1", "Look");
    tx.clock = 3_000;
    tx.appendText("e2", "ing.");
    tx.clock = 4_000;
    tx.toolUse({ id: "c1", name: "Shell", input: { command: "ls" } });
    tx.toolResult("c1", "a.txt", false);
    tx.clock = 5_000;
    tx.toolUse({ id: "c1", name: "Shell", input: { command: "ls" } });
    tx.appendText("e3", "Done.");
    tx.breakSegment();
    tx.error("err-1", "run failed", NaN);
    tx.turnEnded();
    const msgs = parseCursorTranscriptFile(tx.toString(), "s");
    expect(msgs.map((m) => [m.uuid, m.timestamp])).toEqual([["s:u1", 1_000], ["s:use-c1", 2_000], ["s:result-c1", 4_000], ["s:seg-e3", 5_000], ["s:err-1", 5_000]]);
    expect(msgs[1].content).toBe("Looking.");
    expect(msgs[1].toolCalls?.[0]).toMatchObject({ id: "c1", name: "Shell" });
    expect(msgs[4].content).toBe(`${CLIENT_ERROR_BANNER_PREFIX} run failed`);
    expect(new MirrorTranscript(0).toString()).toBe("");
  });
});

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
    const msgs = parseCursorTranscriptFile(fs.readFileSync(w.transcriptPath("bc-a"), "utf8"), "bc-a");
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
  });

  test("import off mirrors only own agents; children are found through their parent; git is emitted once", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = {
      "bc-mine": { id: "bc-mine", updatedAt: T0, children: ["bc-child"], branch: "feat/x", replies: ["ok"] },
      "bc-theirs": { id: "bc-theirs", updatedAt: T0, replies: ["ok"] },
      "bc-child": { id: "bc-child", updatedAt: T0, replies: ["worker done"] },
    };
    const { adapter, client } = fakeAdapter(agents);
    const w = new CloudAgentWatcher(adapter, { rootDir: root, now: NOW, importAll: () => false, isOwnAgent: (id) => id === "bc-mine" });
    const git: unknown[] = [];
    w.on("git", (g) => git.push(g));
    await w.poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(client.calls).toContain("mirror bc-child (unlisted)");
    expect(client.calls.some((c) => c.includes("bc-theirs"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "bc-child", "meta.json"), "utf8"))).toMatchObject({ parentAgentId: "bc-mine", description: "a worker" });
    agents["bc-mine"].updatedAt = "2026-09-29T10:00:30.000Z";
    await w.poll();
    expect(git).toEqual([{ agentId: "bc-mine", branch: "feat/x" }]);
  });

  test("no credentials: nothing is listed", async () => {
    const { adapter, client } = fakeAdapter({}, { key: () => false });
    await new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW }).poll();
    expect(client.calls).toEqual([]);
  });
});

describe("CloudAgentRegistry", () => {
  function registry(agents: Record<string, FakeAgent>, bound: Record<string, string> = {}) {
    const { adapter, client } = fakeAdapter(agents);
    const statuses: string[] = [];
    const binds: string[] = [];
    const dir = tmp();
    const reg = new CloudAgentRegistry([adapter], {
      bindSession: (c, a) => { binds.push(`${c}=${a}`); },
      agentForConversation: (c) => bound[c],
      setStatus: (c, st) => statuses.push(`${c} ${st}`),
      log: () => {},
    }, () => path.join(dir, "sessions.json"));
    reg.runtimes[0].watcher = new CloudAgentWatcher(adapter, { rootDir: dir, now: NOW });
    return { reg, client, statuses, binds };
  }

  test("a cloud model key starts a session whose first message creates the agent; a local key does not", async () => {
    const { reg, client, statuses, binds } = registry({});
    expect(await reg.start("cursor", "conv-local", undefined, "composer-2.5", "hi")).toBe(false);
    expect(await reg.start("codex", "conv-codex", undefined, "cloud", "hi")).toBe(false);
    expect(await reg.start("cursor", "conv-1", undefined, "cloud", "build it")).toBe(true);
    expect(client.calls).toContain("create build it ");
    expect(binds).toEqual(["conv-1=bc-new"]);
    expect(statuses).toEqual(["conv-1 connected", "conv-1 working"]);
    expect(reg.forConversation("conv-1")?.adapter.dir).toBe("fake-cloud");
    expect((await reg.deliver("conv-1", "more"))?.adapter.dir).toBe("fake-cloud");
    expect(client.calls).toContain("followUp bc-new more");
    expect(await reg.deliver("conv-elsewhere", "x")).toBeNull();
  });

  test("a mirrored agent bound to a conversation is adopted; Escape cancels its running turn", async () => {
    const { reg, client } = registry({ "bc-seen": { id: "bc-seen", updatedAt: T0, running: true, replies: [] } }, { "conv-2": "bc-seen", "conv-3": "local-uuid" });
    expect(reg.forConversation("conv-3")).toBeUndefined();
    const rt = reg.forConversation("conv-2")!;
    expect(await rt.sessions.interrupt("conv-2")).toBe(true);
    expect(client.calls).toContain("cancel bc-seen");
    expect(rt.sessions.ownsAgent("bc-seen")).toBe(true);
  });

  test("setup errors: credentials held with the provider's reason, busy passes through, the card posts once a minute", async () => {
    const { reg } = registry({});
    await reg.start("cursor", "conv-4", undefined, "cloud", "");
    (reg.runtimes[0].sessions as any).sessions["conv-4"].agentId = "bc-4";
    await expect(reg.deliver("conv-4", "busy")).rejects.toBeInstanceOf(CloudAgentBusyError);
    const err = await reg.deliver("conv-4", "denied").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.holdReason).toBe("waiting for a fake key");
    expect(reg.setupCard(err, "conv-4", 1_000_000)).toEqual({ key: "fake-cloud-setup:conv-4:key_invalid", message: "Fake Cloud rejected the key." });
    expect(reg.setupCard(err, "conv-4", 1_030_000)).toBeNull();
    expect(reg.setupCard(err, "conv-4", 1_070_000)).not.toBeNull();
  });
});
