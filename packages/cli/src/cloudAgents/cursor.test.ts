import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CloudApiError } from "./http.js";
import { setupErrorOf } from "./sessions.js";
import { CursorCloudAdapter, CursorCloudApi, buildCursorCloudTranscript, forkedWorkers, mergeEventLog, type CursorCloudRun, type CursorRunEvent } from "./cursor.js";
import { CloudAgentWatcher, type CloudAgentWatcherOptions } from "./watcher.js";
import { parseMirrorTranscriptFile } from "../parser.js";
import { classifyMirrorTranscriptTail } from "./transcript.js";
import { CLIENT_ERROR_BANNER_PREFIX, classifyApiErrorBanner, cloudAgentCredentialError } from "@codecast/shared/contracts";
import { CloudAgentSetupError } from "./types.js";
import { deviceLabel } from "../remote/device.js";

// A real run's stream (api.cursor.com, 2026-09-29), deltas stripped.
const SSE = fs.readFileSync(path.join(import.meta.dir, "..", "__fixtures__", "cursorCloudRun.sse"), "utf8");
const AGENT = "bc-f778d439-1bd2-4f6a-ae1e-26ae7c4bdac5";
const RUN: CursorCloudRun = { id: "run-5e77f9d7-e1e5-4213-b30f-6d6051ec98e8", agentId: AGENT, status: "FINISHED", createdAt: "2026-09-29T07:53:41.213Z", updatedAt: "2026-09-29T07:54:11.515Z", result: "pong" };
const CONVERSATION = [
  { id: "u1", type: "user_message", text: "Run the shell command `uname -a` and then reply with just the word pong." },
  { id: "a1", type: "assistant_message", text: "pong" },
];

/** A fetch that serves canned responses by path. */
function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const hit = routes[url.pathname];
    if (!hit) return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    return hit();
  }) as typeof fetch;
}

async function streamEvents(agent = AGENT, run = RUN.id, sse = SSE): Promise<CursorRunEvent[]> {
  const api = new CursorCloudApi("crsr_test", fakeFetch({ [`/v1/agents/${agent}/runs/${run}/stream`]: () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) }), "https://api.test");
  const events: CursorRunEvent[] = [];
  expect(await api.streamRun(agent, run, (e) => events.push(e))).toBe(true);
  return events;
}

// A real multitask agent: two turns before any run, then "Start multitasking"
// forks a worker, two chat turns, and the worker's report comes back as a turn
// of its own. The stream read here is its FIRST run's, which carries every
// later turn too.
const MT_AGENT = "bc-f4091919-2051-4906-b735-74f6340e2124";
const MT_SSE = fs.readFileSync(path.join(import.meta.dir, "..", "__fixtures__", "cursorCloudMultitask.sse"), "utf8");
const MT_CONVERSATION = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "__fixtures__", "cursorCloudMultitask.conversation.json"), "utf8"));
const MT_RUN: CursorCloudRun = { id: "run-107a6675-4dd4-4f05-981b-b167d74a82e9", agentId: MT_AGENT, status: "FINISHED", createdAt: "2026-09-29T06:18:58.686Z", updatedAt: "2026-09-29T06:19:10.000Z" };

/** The Cursor mirror as the daemon builds it: the core watcher over the Cursor adapter. */
function cursorWatcher(opts: CloudAgentWatcherOptions & { readKey: () => string | null; fetchImpl?: typeof fetch }): CloudAgentWatcher<CursorCloudAdapter> {
  return new CloudAgentWatcher(new CursorCloudAdapter({ readKey: opts.readKey, fetchImpl: opts.fetchImpl }), opts);
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });

describe("Cursor Cloud transcript", () => {
  test("a finished run renders as prompt, shell call with its output, reply, turn end", async () => {
    const events = await streamEvents();
    const jsonl = buildCursorCloudTranscript({ conversation: CONVERSATION, log: events, latestRun: RUN, createdAt: 0 });
    const msgs = parseMirrorTranscriptFile("cursor", jsonl, AGENT);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[0].content).toBe(CONVERSATION[0].text);
    expect(msgs[1].toolCalls).toEqual([{ id: "toolu_01VSnKCZ2NzLEgwaqadi5kJv", name: "Shell", input: { command: "uname -a", description: "Get system information" } }]);
    expect(msgs[2].toolResults?.[0].content).toContain("Linux cursor");
    expect(msgs[3].content).toBe("pong");
    expect(msgs[3].stopReason).toBe("end_turn");
    // Ids name what each row renders from, never its position.
    expect(msgs.map((m) => m.uuid)).toEqual([`${AGENT}:u1`, `${AGENT}:use-toolu_01VSnKCZ2NzLEgwaqadi5kJv`, `${AGENT}:result-toolu_01VSnKCZ2NzLEgwaqadi5kJv`, expect.stringMatching(new RegExp(`^${AGENT}:seg-\\d+-\\d+$`))]);
    // The same turn from the conversation alone: the prompt keeps its row.
    const bare = parseMirrorTranscriptFile("cursor", buildCursorCloudTranscript({ conversation: CONVERSATION, log: [], latestRun: RUN, createdAt: 0 }), AGENT);
    expect(bare.map((m) => m.uuid)).toEqual([`${AGENT}:u1`, `${AGENT}:a1`]);
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("idle");
  });

  test("multitask: every reply stays under its own prompt, the fork shows as a Task call, the report is its own turn", async () => {
    const log = mergeEventLog(await streamEvents(MT_AGENT, "run-e3dd96f7-9663-4b1d-bc74-5d445a7bb666", MT_SSE));
    const msgs = parseMirrorTranscriptFile("cursor", buildCursorCloudTranscript({ conversation: MT_CONVERSATION, log, latestRun: MT_RUN, createdAt: 0 }), MT_AGENT);
    // Each prompt is followed by that turn's replies and nothing of the next turn's.
    const turns: string[][] = [];
    for (const m of msgs) {
      if (m.role === "user" && !m.toolResults) turns.push([m.content.startsWith("<task-notification>") ? m.content : m.content.slice(0, 30)]);
      else if (m.role === "assistant" && m.content) turns[turns.length - 1].push(m.content);
    }
    expect(turns).toEqual([
      ["this is a test", "Got it — I'm here and working. When you're ready, send a real task and I'll pick it up."],
      ["you are funny", expect.stringContaining("I'll take the compliment")],
      ["Start multitasking", "I'll fork one background worker and stop in the foreground so it can continue the task.", "Forked a background worker to continue the task. I'll pick up when it reports back."],
      ["cool", "Sounds good. Whenever you have a real task, send it over and I’ll get to work."],
      ["oyu there?", "Yes, I’m here. What do you want to work on?"],
      [expect.stringContaining("<task-notification>"), expect.stringContaining("[Forked multitask worker](https://cursor.com/agents/bc-7574adff")],
    ]);
    const notice = msgs.find((m) => m.content.startsWith("<task-notification>"))!.content;
    expect(notice).toContain('<summary>Agent "Forked multitask worker" completed</summary>');
    expect(notice).toContain("<task-id>bc-7574adff-bfe8-505b-86e2-671066bb0716</task-id>");
    expect(notice).toContain("There is no coding task to continue.");
    expect(notice).not.toContain("Perform any necessary follow-up");
    // Rows in time order: nothing is dated ahead of a later turn's prompt.
    const stamps = msgs.map((m) => m.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    // One row per id: the fork's call completes two turns later without a second row.
    const ids = msgs.map((m) => m.uuid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(msgs.filter((m) => m.toolCalls?.some((t) => t.name === "Task"))).toHaveLength(1);
    const task = msgs.flatMap((m) => m.toolCalls ?? []).find((t) => t.name === "Task");
    expect(task?.input).toMatchObject({ description: "Forked multitask worker", agentId: "bc-7574adff-bfe8-505b-86e2-671066bb0716" });
    expect(forkedWorkers(log)).toEqual([{ agentId: "bc-7574adff-bfe8-505b-86e2-671066bb0716", description: "Forked multitask worker" }]);
  });

  test("a turn the log opened ahead of the conversation stays open, with no prompt yet", async () => {
    const events = await streamEvents();
    const running: CursorCloudRun = { ...RUN, id: "run-2", status: "RUNNING" };
    const next: CursorRunEvent[] = [
      { event: "turn_start", id: "1790669000000-0", data: {} },
      { event: "assistant", id: "1790669000100-0", data: { text: "working on it" } },
    ];
    const jsonl = buildCursorCloudTranscript({ conversation: CONVERSATION, log: mergeEventLog(events, next), latestRun: running, createdAt: 0 });
    const msgs = parseMirrorTranscriptFile("cursor", jsonl, AGENT);
    expect(msgs.at(-2)?.content).toBe("pong");
    expect(msgs.at(-1)?.content).toBe("working on it");
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("active");
  });

  test("with no stream left, turns come from the conversation; a failed run shows the error banner", () => {
    const failed: CursorCloudRun = { ...RUN, status: "ERROR" };
    const msgs = parseMirrorTranscriptFile("cursor", buildCursorCloudTranscript({ conversation: CONVERSATION, log: [], latestRun: failed, createdAt: 0 }), AGENT);
    expect(msgs.map((m) => m.content)).toEqual([CONVERSATION[0].text, "pong", `${CLIENT_ERROR_BANNER_PREFIX} Cursor Cloud run error`]);
  });

  test("the same event read from two runs' streams is kept once", async () => {
    const events = await streamEvents();
    expect(mergeEventLog(events, events)).toHaveLength(events.filter((e) => e.id).length);
  });

  test("the credential cards the adapter posts are the ones the web offers Connect on", () => {
    const adapter = new CursorCloudAdapter({ readKey: () => null });
    const rejected = setupErrorOf(adapter, new CloudApiError(401, "error", "Invalid User API Key"), { model: "" })!;
    for (const err of [CloudAgentSetupError.credentialsMissing(adapter), rejected]) {
      expect(cloudAgentCredentialError("cursor", err.message)?.id).toBe("cursor");
      expect(classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${err.message}`)).toBe("auth");
    }
    // The card names the machine the daemon runs on, as the web lists it.
    expect(rejected.message).toBe(`Cursor rejected the API key on ${deviceLabel()} (Invalid User API Key).`);
  });
});

describe("CursorCloudWatcher import setting", () => {
  test("with account import off, only agents codecast started are mirrored", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cloud-off-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = (id: string) => ({ id, name: id, status: "IDLE", createdAt: RUN.createdAt, updatedAt: RUN.updatedAt });
    const json = (body: unknown) => () => new Response(JSON.stringify(body));
    const watcher = cursorWatcher({
      rootDir: root,
      readKey: () => "crsr_test",
      importAll: () => false,
      isOwnAgent: (id) => id === "bc-mine",
      now: () => Date.parse(RUN.updatedAt),
      fetchImpl: fakeFetch({
        "/v1/agents": json({ items: [agent("bc-mine"), agent("bc-theirs")] }),
        "/v1/agents/bc-mine/runs": json({ items: [] }),
        "/v1/agents/bc-theirs/runs": json({ items: [] }),
        "/v0/agents/bc-mine/conversation": json({ messages: [{ id: "u", type: "user_message", text: "hi" }] }),
        "/v0/agents/bc-theirs/conversation": json({ messages: [{ id: "u", type: "user_message", text: "hi" }] }),
      }),
    });
    const seen: string[] = [];
    watcher.on("session", (e) => seen.push(e.sessionId));
    await watcher.poll();
    expect(seen).toEqual(["bc-mine"]);
  });
});

describe("CursorCloudWatcher", () => {
  test("mirrors an agent into a Cursor JSONL transcript with its meta, and emits a session event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cloud-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = { id: AGENT, name: "codecast probe", status: "IDLE", repos: [{ url: "https://github.com/ashot/codecast" }], url: `https://cursor.com/agents/${AGENT}`, createdAt: RUN.createdAt, updatedAt: RUN.updatedAt, latestRunId: RUN.id };
    const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const EMPTY_RUN: CursorCloudRun = { ...RUN, id: "run-empty", createdAt: "2026-09-29T07:53:00.000Z" };
    const watcher = cursorWatcher({
      rootDir: root,
      readKey: () => "crsr_test",
      resolveRepoDir: async (repo) => (repo.name === "codecast" ? "/Users/me/src/codecast" : null),
      now: () => Date.parse(RUN.updatedAt),
      fetchImpl: fakeFetch({
        "/v1/agents": json({ items: [agent] }),
        // The first run's stream is empty (seen live): it must not stand in for the second.
        [`/v1/agents/${AGENT}/runs`]: json({ items: [RUN, EMPTY_RUN] }),
        [`/v1/agents/${AGENT}/runs/run-empty/stream`]: () => new Response(""),
        [`/v1/agents/${AGENT}/runs/${RUN.id}/stream`]: () => new Response(SSE),
        [`/v0/agents/${AGENT}/conversation`]: json({ id: AGENT, messages: CONVERSATION }),
      }),
    });
    const sessions: Array<{ sessionId: string; filePath: string }> = [];
    watcher.on("session", (e) => sessions.push(e));
    await watcher.poll();
    expect(sessions).toEqual([{ sessionId: AGENT, filePath: watcher.transcriptPath(AGENT), eventType: "add" } as any]);
    const msgs = parseMirrorTranscriptFile("cursor", fs.readFileSync(watcher.transcriptPath(AGENT), "utf8"), AGENT);
    expect(msgs.at(-1)?.content).toBe("pong");
    expect(msgs.some((m) => m.toolCalls?.[0]?.name === "Shell")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, AGENT, "meta.json"), "utf8"))).toMatchObject({ cwd: "/Users/me/src/codecast", title: "codecast probe" });
    // Settled and unchanged: the next poll neither refetches nor re-emits.
    await watcher.poll();
    expect(sessions.length).toBe(1);
    // A restarted watcher announces what is already on disk before any poll.
    const restarted = cursorWatcher({ rootDir: root, readKey: () => null, pollMs: 3_600_000 });
    const primed: Array<{ sessionId: string }> = [];
    restarted.on("session", (e) => primed.push(e));
    restarted.start();
    restarted.stop();
    expect(primed.map((e) => e.sessionId)).toEqual([AGENT]);
  });
});

describe("Cursor Cloud setup failures", () => {
  test("API errors carry Cursor's own message, from either error shape", async () => {
    const api = new CursorCloudApi("crsr_test", fakeFetch({
      "/v1/agents": () => new Response(JSON.stringify({ error: { code: "validation_error", message: "Failed to verify existence of branch 'main' in repository codecast-sh/codecast. Please ensure the branch name is correct." } }), { status: 400 }),
      "/v1/me": () => new Response(JSON.stringify({ code: "error", message: "Invalid User API Key" }), { status: 401 }),
    }), "https://api.test");
    await expect(api.createAgent({})).rejects.toMatchObject({ status: 400, code: "validation_error", message: expect.stringContaining("codecast-sh/codecast") });
    await expect(api.request("GET", "/v1/me")).rejects.toMatchObject({ status: 401, message: "Invalid User API Key" });
  });

  test("the start notice opens the transcript under the first prompt", () => {
    const msgs = parseMirrorTranscriptFile("cursor", buildCursorCloudTranscript({ conversation: CONVERSATION, log: [], latestRun: RUN, createdAt: 0, notice: "Started from `main`: `feat` is not on GitHub yet." }), AGENT);
    expect(msgs.map((m) => m.uuid)).toEqual([`${AGENT}:u1`, `${AGENT}:notice-start`, `${AGENT}:a1`]);
    expect(msgs[1].content).toContain("is not on GitHub yet");
  });
});
