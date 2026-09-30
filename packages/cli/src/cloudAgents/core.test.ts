import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, CLOUD_AGENT_PROVIDERS, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { threadItemToMessage, type ThreadItem } from "../codexAppServer.js";
import { parseCursorTranscriptFile, parseMirrorTranscriptFile } from "../parser.js";
import { CloudApiError, cloudApiErrorOf } from "./http.js";
import { cloudMirrorRepoFacts, PollCadence } from "./poll.js";
import { CloudAgentRegistry } from "./registry.js";
import { classifyMirrorTranscriptTail, MirrorTranscript, mirrorHistoryId, mirrorMetaJson, parseMirrorTranscript, readMetaJson } from "./transcript.js";
import { CLOUD_AGENT_ACTION_METHODS, CloudAgentBusyError, CloudAgentSetupError, type CloudAgentAdapter, type CloudAgentMirror } from "./types.js";
import { cloudAgentAdapters } from "./index.js";
import { CloudAgentWatcher } from "./watcher.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-agents-core-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

interface FakeAgent { id: string; updatedAt: string; running?: boolean; repo?: string; children?: string[]; branch?: string; gitUnknown?: boolean; replies: string[] }
interface FakeClient { calls: string[] }

/**
 * A provider that serves agents from a table: every mirror renders a prompt
 * and its replies, and records how often it was asked.
 */
function fakeAdapter(agents: Record<string, FakeAgent>, opts: { key?: () => boolean; format?: number } = {}) {
  const client: FakeClient = { calls: [] };
  const adapter: CloudAgentAdapter<FakeClient, FakeAgent, { seen: number }> = {
    spec: FAKE_SPEC,
    mirrorFormat: opts.format ?? 1,
    client: () => (opts.key?.() ?? true ? client : CloudAgentSetupError.credentialsMissing(adapter)),
    loadData: (raw: any) => ({ seen: typeof raw?.seen === "number" ? raw.seen : 0 }),
    async listAgents(c) {
      c.calls.push("list");
      return { items: Object.values(agents).filter((a) => !a.id.includes("child")).map((a) => ({ id: a.id, updatedAtMs: Date.parse(a.updatedAt), version: a.updatedAt, active: !!a.running, agent: a })) };
    },
    async mirror(c, handle, known): Promise<CloudAgentMirror | null> {
      c.calls.push(`mirror ${handle.agentId}${known ? "" : " (unlisted)"}`);
      const a = known ?? agents[handle.agentId];
      if (!a) return null;
      handle.data().seen++;
      handle.save();
      const tx = new MirrorTranscript(Date.parse(T0), { notice: await handle.notice() });
      tx.user("p1", "hello");
      a.replies.forEach((r, i) => tx.assistant(`r${i}`, r));
      if (!a.running) tx.turnEnded();
      return {
        transcript: tx.toString(),
        title: `agent ${a.id}`,
        createdAtMs: Date.parse(T0),
        repoUrl: a.repo,
        version: a.updatedAt,
        running: !!a.running,
        git: a.gitUnknown ? undefined : a.branch ? { agentId: a.id, branch: a.branch } : null,
        children: (a.children ?? []).map((agentId) => ({ agentId, description: "a worker" })),
      };
    },
    async create(c, session, content) { c.calls.push(`create ${content} ${session.repoUrl ?? ""}`); return { agentId: "bc-new", url: "https://x/bc-new" }; },
    async followUp(c, agentId, content) {
      c.calls.push(`followUp ${agentId} ${content}`);
      if (content === "busy") throw new CloudAgentBusyError("Fake Cloud");
      if (content === "denied") throw new CloudApiError(401, undefined, "401");
      if (content === "no-repo") throw CloudAgentSetupError.repoUnreachable(adapter, undefined, "no access", "Give it access");
    },
    async cancel(c, agentId) {
      c.calls.push(`cancel ${agentId}`);
      if (agentId === "bc-broken") throw new Error("503");
      return agents[agentId]?.running ? "turn t1" : null;
    },
  };
  return { adapter, client };
}

/** Cursor's spec under its own directory and card copy; its ids still carry `bc-`. */
const FAKE_SPEC: CloudAgentProviderSpec = {
  ...CLOUD_AGENT_PROVIDERS.cursor,
  label: "Fake Cloud",
  mirrorDir: "fake-cloud",
  credentialCards: { missing: "Fake Cloud needs a key.", rejected: "Fake Cloud rejected the key", holdReason: "waiting for a fake key" },
};

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
    const msgs = parseMirrorTranscript(tx.toString(), { sessionId: "s" });
    expect(msgs.map((m) => [m.uuid, m.timestamp])).toEqual([["s:u1", 1_000], ["s:use-c1", 2_000], ["s:result-c1", 4_000], ["s:seg-e3", 5_000], ["s:err-1", 5_000]]);
    expect(msgs[1].content).toBe("Looking.");
    expect(msgs[1].toolCalls?.[0]).toMatchObject({ id: "c1", name: "Shell" });
    expect(msgs[4].content).toBe(`${CLIENT_ERROR_BANNER_PREFIX} run failed`);
    expect(new MirrorTranscript(0).toString()).toBe("");
  });

  test("the neutral reader reads records as written, with no client's rewrites", () => {
    const tx = new MirrorTranscript(1_000);
    tx.user("u1", "<user_query>literal</user_query>");
    tx.toolUse({ id: "c1", name: "Shell", input: { command: "ls" } });
    tx.toolResult("c1", "a.txt", true);
    tx.turnEnded();
    const msgs = parseMirrorTranscript(tx.toString(), { sessionId: "s", fallbackClock: 5 });
    expect(msgs.map((m) => [m.uuid, m.role, m.content, m.timestamp])).toEqual([["s:u1", "user", "<user_query>literal</user_query>", 1_000], ["s:use-c1", "assistant", "", 1_000], ["s:result-c1", "user", "", 1_000]]);
    expect(msgs[2]).toMatchObject({ toolResults: [{ toolUseId: "c1", content: "a.txt", isError: true }], stopReason: "end_turn" });
  });

  test("a message another parser produced is written whole and read back as it was", () => {
    // Codex app-server items: images, reasoning with no text, a command with
    // its call and result on one message, and a phased reply.
    const items = [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "fix it" }, { type: "localImage", path: "/tmp/shot.png" }] },
      { type: "reasoning", id: "r1", content: [], summary: ["Look at the test first."] },
      { type: "commandExecution", id: "c1", command: "bun test", cwd: "/repo", aggregatedOutput: "1 fail", status: "failed" },
      { type: "agentMessage", id: "a1", text: "Fixed.", phase: "final_answer" },
    ] as unknown as ThreadItem[];
    const messages = items.map((item, i) => threadItemToMessage(item, 1_000 + i)!);
    const tx = new MirrorTranscript(500);
    for (const m of messages) tx.message({ ...m, model: m.role === "assistant" ? "gpt-5.5" : undefined });
    tx.turnEnded();
    const read = parseMirrorTranscriptFile("codex", tx.toString(), "s");
    expect(read.map((m) => m.uuid)).toEqual(["s:u1", "s:r1", "s:c1", "s:a1"]);
    expect(read.map(({ uuid, stopReason, ...m }) => m)).toEqual(messages.map(({ uuid, ...m }) => JSON.parse(JSON.stringify({ ...m, model: m.role === "assistant" ? "gpt-5.5" : undefined }))));
    expect(read[3].stopReason).toBe("end_turn");
    // Cursor's records never carry these fields, so its reader is unchanged by them.
    expect(tx.toString()).toContain('"thinking":"Look at the test first."');
  });

  test("the notice goes under the first prompt, however the transcript is built", () => {
    const viaTurns = new MirrorTranscript(1_000, { notice: "Started from `main`." });
    viaTurns.turn("p1", "go");
    viaTurns.assistant("a1", "ok");
    viaTurns.turn("p2", "again");
    const viaMessages = new MirrorTranscript(1_000, { notice: "Started from `main`." });
    viaMessages.message({ uuid: "p1", role: "user", content: "go", timestamp: 1_000 });
    viaMessages.message({ uuid: "a1", role: "assistant", content: "ok", timestamp: 1_000 });
    viaMessages.message({ uuid: "p2", role: "user", content: "again", timestamp: 1_000 });
    for (const tx of [viaTurns, viaMessages]) {
      expect(parseMirrorTranscript(tx.toString(), { sessionId: "s" }).map((m) => [m.uuid, m.content])).toEqual([["s:p1", "go"], ["s:notice-start", "ℹ Started from `main`."], ["s:a1", "ok"], ["s:p2", "again"]]);
    }
    // A first turn with no prompt still opens with it.
    const noPrompt = new MirrorTranscript(1_000, { notice: "n" });
    noPrompt.turn(undefined, undefined);
    noPrompt.assistant("a1", "ok");
    expect(parseMirrorTranscript(noPrompt.toString(), { sessionId: "s" }).map((m) => m.uuid)).toEqual(["s:notice-start", "s:a1"]);
  });

  test("a message without a timestamp takes the time of the one before it", () => {
    const tx = new MirrorTranscript(500);
    tx.message({ uuid: "a", role: "user", content: "go", timestamp: 2_000 });
    tx.message({ uuid: "b", role: "assistant", content: "ok", timestamp: 0 });
    expect(parseMirrorTranscript(tx.toString(), { sessionId: "s" }).map((m) => m.timestamp)).toEqual([2_000, 2_000]);
  });

  test("a plain read (cursor-agent's own JSONL) counts and emits only what cursor-agent writes", () => {
    const lines = [
      { role: "user", message: { content: [{ type: "text", text: "go" }] } },
      { role: "system", message: { content: [{ type: "text", text: "compacted" }] } },
      { role: "assistant", thinking: "hidden", message: { content: [] } },
      { role: "assistant", model: "m", message: { content: [{ type: "text", text: "ok" }] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    const plain = parseCursorTranscriptFile(lines, "s");
    expect(plain.map((m) => [m.uuid, m.role, m.model])).toEqual([["s:0", "user", undefined], ["s:2", "assistant", undefined]]);
    // The mirror route reads codecast's own records in full.
    const full = parseMirrorTranscriptFile("cursor", lines, "s");
    expect(full.map((m) => [m.uuid, m.role])).toEqual([["s:0", "user"], ["s:1", "system"], ["s:2", "assistant"], ["s:3", "assistant"]]);
  });

  test("the mirror's tail settles on turn_ended", () => {
    const tx = new MirrorTranscript(0);
    tx.user("p", "go");
    expect(classifyMirrorTranscriptTail(tx.toString())).toBe("active");
    tx.turnEnded();
    expect(classifyMirrorTranscriptTail(tx.toString())).toBe("idle");
    expect(classifyMirrorTranscriptTail("")).toBe("unknown");
  });

  test("meta.json is read back as written", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "meta.json"), mirrorMetaJson({ cwd: "/r", title: "t", url: "u", createdAtMs: NaN, parentAgentId: "bc-p", description: "w" }));
    expect(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).toBe('{"cwd":"/r","title":"t","url":"u","cloud":true,"parentAgentId":"bc-p","description":"w"}');
    expect(await readMetaJson(dir)).toEqual({ dir, cwd: "/r", title: "t", parentAgentId: "bc-p", description: "w" });
    expect(await readMetaJson(path.join(dir, "none"))).toBeNull();
  });

  test("every line of an agent reads under its root line's id: a branch of a branch forks at one of its parent's messages", async () => {
    const mirror = tmp();
    const write = (id: string, meta: Parameters<typeof mirrorMetaJson>[0]) => {
      fs.mkdirSync(path.join(mirror, id));
      fs.writeFileSync(path.join(mirror, id, "meta.json"), mirrorMetaJson(meta));
    };
    write("task", { cwd: "/r" });
    write("task~b1", { cwd: "/r", parentAgentId: "task", forkAt: "p1" });
    write("task~b2", { cwd: "/r", parentAgentId: "task~b1", forkAt: "p2" });
    // A worker a parent forked is its own session, not a branch of it.
    write("bc-w", { cwd: "/r", parentAgentId: "bc-p" });
    const historyId = async (id: string) => mirrorHistoryId((await readMetaJson(path.join(mirror, id)))!, id);
    expect(await historyId("task")).toBe("task");
    expect(await historyId("task~b1")).toBe("task");
    expect(await historyId("task~b2")).toBe("task");
    expect(await historyId("bc-w")).toBe("bc-w");
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
    const off = new CloudAgentWatcher(adapter, { rootDir: tmp(), now: NOW, importAll: () => false, hasOwnAgents: () => false });
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
    const quiet = new CloudAgentWatcher(idle.adapter, { rootDir: tmp(), now: NOW, importAll: () => false, hasOwnAgents: () => false });
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
    // Once each, however many passes: the parent's branch, and the child's none.
    expect(git).toHaveLength(2);
    expect(git).toContainEqual({ agentId: "bc-mine", branch: "feat/x" });
    expect(git).toContainEqual({ agentId: "bc-child" });
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
});

describe("CloudAgentRegistry", () => {
  function registry(agents: Record<string, FakeAgent>, bound: Record<string, string> = {}) {
    const { adapter, client } = fakeAdapter(agents);
    const statuses: string[] = [];
    const binds: string[] = [];
    const dir = tmp();
    const cards: string[] = [];
    const queued: string[] = [];
    const logs: string[] = [];
    /** What the daemon was asked to do with sessions, in order; `hostAnswers` is what each registration answers. */
    const kept: string[] = [];
    const notes: string[] = [];
    const hostAnswers: Array<"hosted" | "not_owner" | "failed"> = [];
    const reg = new CloudAgentRegistry([adapter], {
      bindSession: (c, a) => { binds.push(`${c}=${a}`); },
      agentForConversation: (c) => bound[c],
      setStatus: (c, st) => statuses.push(`${c} ${st}`),
      // A setup card is the turn-stopped banner; an action's result is a system note.
      addLine: async (c, line) => { if (line.role === "system") notes.push(`${c} ${line.content}`); else cards.push(`${c} ${line.key} ${line.content.replace(`${CLIENT_ERROR_BANNER_PREFIX} `, "")}`); },
      enqueueMessage: async (c, content) => { queued.push(`${c} ${content}`); },
      hostSession: async (sid) => { const answer = hostAnswers.shift() ?? "hosted"; kept.push(`host ${sid} ${answer}`); return answer; },
      releaseSession: (sid) => { kept.push(`release ${sid}`); },
      placeSession: async (sid, cwd) => { kept.push(`place ${sid} ${cwd}`); return true; },
      retitleSession: async (c, title, replaces) => { kept.push(`title ${c} ${title} replacing ${replaces.join(",")}`); return true; },
      markArchived: async (c, archived) => { kept.push(`archived ${c} ${archived}`); return true; },
      log: (m) => logs.push(m),
    }, () => path.join(dir, "sessions.json"));
    const watcher = new CloudAgentWatcher(adapter, { rootDir: dir, now: NOW });
    reg.useWatcher(watcher);
    return { reg, client, statuses, binds, cards, queued, logs, kept, notes, hostAnswers, watcher };
  }

  test("a synced mirror's session is hosted, placed in a checkout, titled once; a failed registration is asked again", async () => {
    const { reg, kept, hostAnswers } = registry({});
    // Another device hosts it: this machine's checkout is not where it runs, so it never moves the session.
    hostAnswers.push("not_owner");
    // ...and only that device syncs its transcript: the keep says so.
    expect(await reg.keepSession("bc-x", "conv-x", { cwd: "/src/app" })).toBe(false);
    expect(kept).toEqual(["host bc-x not_owner"]);
    kept.length = 0;

    expect(await reg.keepSession("bc-k", "conv-k", { cwd: "/fake-cloud/acme/app", title: "Fix it", formerTitles: ["New task"] })).toBe(true);
    await reg.keepSession("bc-k", "conv-k", { cwd: "/src/app", title: "Fix it" });
    // A placeholder folder never moves the session; a checkout does, once. Hosted once, titled once.
    expect(kept).toEqual(["host bc-k hosted", "title conv-k Fix it replacing New task", "place bc-k /src/app"]);

    kept.length = 0;
    hostAnswers.push("failed");
    // Unanswered is not refused: the transcript still syncs here.
    expect(await reg.keepSession("bc-f", "conv-f", {})).toBe(true);
    expect(kept).toEqual(["host bc-f failed"]);
    // A keep while the retry is due does not ask again; the retry does, on its own.
    await reg.keepSession("bc-f", "conv-f", {});
    expect(kept).toEqual(["host bc-f failed"]);
    const retry = (reg as any).hostRetries.get("bc-f") as NodeJS.Timeout;
    expect(retry).toBeDefined();
    clearTimeout(retry);
    await (reg as any).host("bc-f", "conv-f", 1);
    expect(kept).toEqual(["host bc-f failed", "host bc-f hosted"]);

    // Another device hosts it: not asked again inside ten minutes.
    kept.length = 0;
    hostAnswers.push("not_owner");
    await reg.keepSession("bc-o", "conv-o", {});
    await reg.keepSession("bc-o", "conv-o", {});
    expect(kept).toEqual(["host bc-o not_owner"]);
  });

  test("the provider's archived flag is recorded when it changes, and never for a provider that cannot tell", async () => {
    const { reg, kept } = registry({});
    await reg.keepSession("bc-a", "conv-a", {});
    await reg.keepSession("bc-a", "conv-a", { cloudArchived: true });
    await reg.keepSession("bc-a", "conv-a", { cloudArchived: true });
    await reg.keepSession("bc-a", "conv-a", { cloudArchived: false });
    expect(kept).toEqual(["host bc-a hosted", "archived conv-a true", "archived conv-a false"]);
  });

  test("a session its mirror can no longer follow is let go, then hosted again when the mirror reaches it", async () => {
    const { reg, kept } = registry({});
    await reg.keepSession("bc-u", "conv-u", {});
    (reg as any).letGo("bc-u");
    await reg.keepSession("bc-u", "conv-u", {});
    expect(kept).toEqual(["host bc-u hosted", "release bc-u", "host bc-u hosted"]);
  });

  test("setup blocks name each provider the machine cannot read, and nothing once it reads", async () => {
    const { reg, watcher } = registry({});
    expect(reg.setupBlocks()).toEqual([]);
    watcher.setRemoteSetup(CloudAgentSetupError.accessDenied({ spec: FAKE_SPEC }, "Fake Cloud is off for this workspace"));
    expect(reg.setupBlocks()).toEqual([{ provider: FAKE_SPEC.id, kind: "access", reason: "Fake Cloud is off for this workspace" }]);
  });

  test("a cloud model key starts a session whose first message creates the agent; a local key does not", async () => {
    const { reg, client, statuses, binds, queued } = registry({});
    expect(await reg.start("cursor", "conv-local", undefined, "composer-2.5", "hi")).toBeNull();
    expect(await reg.start("codex", "conv-codex", undefined, "cloud", "hi")).toBeNull();
    // A launch prompt rides the delivery rail like any first message; nothing is created yet.
    expect(await reg.start("cursor", "conv-1", undefined, "cloud", "build it")).toEqual({});
    expect(queued).toEqual(["conv-1 build it"]);
    expect(client.calls).toEqual([]);
    expect((await reg.deliver("conv-1", "build it"))?.adapter.spec.mirrorDir).toBe("fake-cloud");
    expect(client.calls).toContain("create build it ");
    expect(binds).toEqual(["conv-1=bc-new"]);
    expect(statuses).toEqual(["conv-1 connected", "conv-1 working"]);
    expect(reg.forConversation("conv-1")?.adapter.spec.mirrorDir).toBe("fake-cloud");
    expect((await reg.deliver("conv-1", "more"))?.adapter.spec.mirrorDir).toBe("fake-cloud");
    expect(client.calls).toContain("followUp bc-new more");
    expect(await reg.deliver("conv-elsewhere", "x")).toBeNull();
  });

  test("a mirrored agent bound to a conversation is adopted; Escape cancels its running turn", async () => {
    const { reg, client } = registry({ "bc-seen": { id: "bc-seen", updatedAt: T0, running: true, replies: [] } }, { "conv-2": "bc-seen", "conv-3": "local-uuid" });
    expect(reg.forConversation("conv-3")).toBeUndefined();
    expect(await reg.interrupt("conv-3")).toBeNull();
    expect(await reg.interrupt("conv-2")).toBe("sent");
    expect(client.calls).toContain("cancel bc-seen");
    expect(reg.forConversation("conv-2")!.sessions.ownsAgent("bc-seen")).toBe(true);
  });

  test("interrupt: nothing running, and a failed cancel named by the provider", async () => {
    const { reg, logs } = registry({ "bc-idle": { id: "bc-idle", updatedAt: T0, replies: [] } }, { "conv-i": "bc-idle", "conv-b": "bc-broken" });
    expect(await reg.interrupt("conv-i")).toBe("none");
    await expect(reg.interrupt("conv-b")).rejects.toThrow("Fake Cloud cancel failed: 503");
    reg.interruptInBackground("conv-b");
    await new Promise((r) => setTimeout(r, 10));
    expect(logs).toContain("[fake-cloud] on teardown: Fake Cloud cancel failed: 503");
  });

  test("setup errors: credentials held with the provider's reason, busy passes through, the card posts once a minute", async () => {
    const { reg, cards } = registry({});
    await reg.start("cursor", "conv-4", undefined, "cloud", "");
    (reg.runtimes[0].sessions as any).sessions["conv-4"].agentId = "bc-4";
    await expect(reg.deliver("conv-4", "busy")).rejects.toBeInstanceOf(CloudAgentBusyError);
    expect(cards).toEqual([]);
    const err = await reg.deliver("conv-4", "denied").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.holdReason).toBe("waiting for a fake key");
    // Delivery posted the card; a retry inside the minute does not post it again.
    expect(cards).toEqual(["conv-4 fake-cloud-setup:conv-4:key_invalid Fake Cloud rejected the key (401)."]);
    await reg.deliver("conv-4", "denied").catch(() => {});
    expect(cards).toHaveLength(1);
    expect(reg.setupCard(err, "conv-4", Date.now() + 61_000)).not.toBeNull();
  });

  test("a hold only the provider can clear is asked about half as often each try, and starts over once a message goes out", async () => {
    const { reg } = registry({});
    await reg.start("cursor", "conv-6", undefined, "cloud", "");
    (reg.runtimes[0].sessions as any).sessions["conv-6"].agentId = "bc-6";
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) waits.push((await reg.deliver("conv-6", "no-repo").catch((e) => e)).recheckMs);
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    // Credentials are read on this machine: always soon.
    expect((await reg.deliver("conv-6", "denied").catch((e) => e)).recheckMs).toBe(5_000);
    await reg.deliver("conv-6", "ok");
    expect((await reg.deliver("conv-6", "no-repo").catch((e) => e)).recheckMs).toBe(30_000);
  });

  test("a launch prompt that cannot be queued is the start's error, not a silent loss", async () => {
    const { reg, logs } = registry({});
    (reg as any).deps.enqueueMessage = async () => { throw new Error("not connected"); };
    expect(await reg.start("cursor", "conv-5", undefined, "cloud", "build it")).toEqual({ error: "Fake Cloud session recorded, but its first message could not be queued: not connected" });
    expect(logs).toContain("[fake-cloud] first prompt not queued: not connected");
  });

  test("every provider's mirror events reach the one transcript route with the provider's spec", async () => {
    const { reg } = registry({});
    const dir = tmp();
    const file = path.join(dir, "bc-p", "bc-p.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");
    const routed: string[] = [];
    const home = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = dir;
    try {
      reg.startWatchers({ syncSetting: () => false, onTranscript: (spec, e) => routed.push(`${spec.label} ${e.sessionId} ${e.eventType}`), onGit: () => {} });
    } finally {
      for (const r of reg.runtimes) r.watcher?.stop();
      if (home === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = home;
    }
    expect(reg.runtimes[0].watcher?.rootDir.startsWith(dir)).toBe(true);
    expect(routed).toEqual([]);
    // Priming reads the provider's own directory; route one event through it.
    reg.runtimes[0].watcher!.emit("session", { sessionId: "bc-p", filePath: file, eventType: "add" });
    expect(routed).toEqual(["Fake Cloud bc-p add"]);
  });
});

describe("cloud agent adapters", () => {
  test("each offers exactly the header actions its spec lists", () => {
    for (const adapter of cloudAgentAdapters(tmp())) {
      const offered = (Object.keys(CLOUD_AGENT_ACTION_METHODS) as Array<keyof typeof CLOUD_AGENT_ACTION_METHODS>).filter((action) => typeof adapter[CLOUD_AGENT_ACTION_METHODS[action]] === "function");
      expect([...offered].sort(), adapter.spec.id).toEqual([...(adapter.spec.actions ?? [])].sort());
    }
  });
});

describe("cloud API errors", () => {
  test("the provider's reason is read from every shape it answers with", () => {
    expect(cloudApiErrorOf(401, { detail: "Could not parse your authentication token." }, "x")).toMatchObject({ status: 401, message: "Could not parse your authentication token.", keyRejected: true });
    expect(cloudApiErrorOf(400, { error: { code: "validation_error", message: "bad branch" } }, "x")).toMatchObject({ code: "validation_error", message: "bad branch", keyRejected: false });
    expect(cloudApiErrorOf(403, { code: "forbidden", message: "no access" }, "x")).toMatchObject({ code: "forbidden", message: "no access", keyRejected: true });
    expect(cloudApiErrorOf(502, undefined, "fake GET /x 502").message).toBe("fake GET /x 502");
  });
});

describe("a cloud agent placed in a local checkout", () => {
  test("takes only which repository it is from the checkout: never its branch, HEAD or changes", () => {
    const local = { branch: "feat/mine", commitHash: "abc", status: " M x", diff: "d", remoteUrl: "git@github.com:acme/app.git", root: "/src/app", repoRoot: "/src/app" };
    expect(cloudMirrorRepoFacts(local)).toEqual({ remoteUrl: "git@github.com:acme/app.git", root: "/src/app", repoRoot: "/src/app" });
    expect(cloudMirrorRepoFacts(undefined)).toBeUndefined();
  });

  test("the daemon creates a mirror's conversation with those facts only (its branch comes from the provider)", () => {
    const daemon = fs.readFileSync(path.join(import.meta.dir, "..", "daemon.ts"), "utf8");
    const start = daemon.indexOf("async function processTranscriptDeltaSessionPass(");
    const body = daemon.slice(start, daemon.indexOf("\n}\n", start));
    expect(body.match(/getGitInfo\(/g)).toHaveLength(1);
    expect(body).toContain("mirror ? cloudMirrorRepoFacts(g) : g");
  });
});

describe("PollCadence", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Waits for a condition, up to 5s: a loaded machine slows these tests but cannot change their outcome. */
  const until = async (done: () => boolean) => { for (const end = Date.now() + 5_000; !done() && Date.now() < end;) await wait(5); };

  test("slow while idle, fast while busy or hurried", async () => {
    // Real timers pace the passes; a fake clock decides when a hurry runs out.
    let clock = 0;
    let passes = 0;
    const cadence = new PollCadence(async () => { passes++; }, { pollMs: 60_000, fastPollMs: 10, now: () => clock });
    cadence.start();
    await until(() => passes === 1);
    await wait(50);
    expect(passes).toBe(1);
    cadence.hurry(150);
    await until(() => passes >= 3);
    expect(passes).toBeGreaterThanOrEqual(3);
    clock += 1_000;
    cadence.busy = true;
    const hurried = passes;
    await until(() => passes >= hurried + 3);
    expect(passes).toBeGreaterThanOrEqual(hurried + 3);
    cadence.busy = false;
    const busy = passes;
    await wait(80);
    cadence.stop();
    // Hurry ran out and busy cleared: back to one pass a minute (after the one already due).
    expect(passes - busy).toBeLessThanOrEqual(1);
  });

  test("a watcher polls at the adapter's fast pace while an agent runs, and logs that it watches", async () => {
    const root = tmp();
    const agents: Record<string, FakeAgent> = { "bc-a": { id: "bc-a", updatedAt: T0, running: true, replies: [] } };
    const { adapter, client } = fakeAdapter(agents);
    const logs: string[] = [];
    const w = new CloudAgentWatcher({ ...adapter, pollMs: 60_000, fastPollMs: 10 }, { rootDir: root, now: NOW, log: (m) => logs.push(m) });
    w.start();
    const lists = () => client.calls.filter((c) => c === "list").length;
    await until(() => lists() >= 3);
    agents["bc-a"].running = false;
    const seen = lists();
    await until(() => lists() > seen);
    await wait(60);
    const settled = client.calls.filter((c) => c === "list").length;
    await wait(100);
    w.stop();
    expect(settled).toBeGreaterThanOrEqual(3);
    expect(client.calls.filter((c) => c === "list").length - settled).toBeLessThanOrEqual(1);
    expect(logs).toContain("[fake-cloud] watching (0 known agents)");
  });
});
