import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorCloudApi, CursorCloudWatcher, buildCursorCloudTranscript, githubHttpsUrl, type CursorCloudRun, type CursorRunEvent } from "./cursorCloud.js";
import { parseCursorTranscriptFile } from "./parser.js";
import { classifyCursorTranscriptTail } from "./workers/ingestMetadata.js";
import { CLIENT_ERROR_BANNER_PREFIX } from "@codecast/shared/contracts";

// A real run's stream (api.cursor.com, 2026-09-29), deltas stripped.
const SSE = fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "cursorCloudRun.sse"), "utf8");
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

async function streamEvents(): Promise<CursorRunEvent[]> {
  const api = new CursorCloudApi("crsr_test", fakeFetch({ [`/v1/agents/${AGENT}/runs/${RUN.id}/stream`]: () => new Response(SSE, { headers: { "content-type": "text/event-stream" } }) }), "https://api.test");
  const events: CursorRunEvent[] = [];
  expect(await api.streamRun(AGENT, RUN.id, (e) => events.push(e))).toBe(true);
  return events;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });

describe("Cursor Cloud transcript", () => {
  test("a finished run renders as prompt, shell call with its output, reply, turn end", async () => {
    const events = await streamEvents();
    expect(events.map((e) => e.event)).toEqual(["status", "tool_call", "tool_call", "assistant", "assistant", "status", "result"]);
    const jsonl = buildCursorCloudTranscript([{ run: RUN, events }], CONVERSATION);
    const msgs = parseCursorTranscriptFile(jsonl, AGENT);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[0].content).toBe(CONVERSATION[0].text);
    expect(msgs[0].timestamp).toBe(Date.parse(RUN.createdAt));
    expect(msgs[1].toolCalls).toEqual([{ id: "toolu_01VSnKCZ2NzLEgwaqadi5kJv", name: "Shell", input: { command: "uname -a", description: "Get system information" } }]);
    expect(msgs[2].toolResults?.[0].toolUseId).toBe("toolu_01VSnKCZ2NzLEgwaqadi5kJv");
    expect(msgs[2].toolResults?.[0].content).toContain("Linux cursor");
    expect(msgs[3].content).toBe("pong");
    expect(msgs[3].stopReason).toBe("end_turn");
    expect(msgs.map((m) => m.uuid)).toEqual([`${AGENT}:0`, `${AGENT}:1`, `${AGENT}:2`, `${AGENT}:3`]);
    expect(classifyCursorTranscriptTail(jsonl)).toBe("idle");
  });

  test("a running run keeps the turn open; a follow-up prompt pairs with the second run", async () => {
    const events = await streamEvents();
    const second: CursorCloudRun = { ...RUN, id: "run-2", status: "RUNNING", createdAt: "2026-09-29T08:00:00.000Z" };
    const conversation = [...CONVERSATION, { id: "u2", type: "user_message", text: "and again" }];
    const jsonl = buildCursorCloudTranscript([{ run: second, events: [] }, { run: RUN, events }], conversation);
    const msgs = parseCursorTranscriptFile(jsonl, AGENT);
    expect(msgs[msgs.length - 1]).toMatchObject({ role: "user", content: "and again" });
    expect(classifyCursorTranscriptTail(jsonl)).toBe("active");
  });

  test("an expired stream falls back to the conversation's replies; a failed run shows the error banner", () => {
    const failed: CursorCloudRun = { ...RUN, status: "ERROR" };
    const msgs = parseCursorTranscriptFile(buildCursorCloudTranscript([{ run: failed, events: null }], CONVERSATION), AGENT);
    expect(msgs.map((m) => m.content)).toEqual([CONVERSATION[0].text, "pong", `${CLIENT_ERROR_BANNER_PREFIX} Cursor Cloud run error`]);
  });

  test("GitHub remotes normalize to the https form the API takes", () => {
    expect(githubHttpsUrl("git@github.com:ashot/codecast.git")).toBe("https://github.com/ashot/codecast");
    expect(githubHttpsUrl("https://github.com/ashot/codecast")).toBe("https://github.com/ashot/codecast");
    expect(githubHttpsUrl("git@gitlab.com:a/b.git")).toBeNull();
  });
});

describe("CursorCloudWatcher", () => {
  test("mirrors an agent into a Cursor JSONL transcript with its meta, and emits a session event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cloud-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = { id: AGENT, name: "codecast probe", status: "IDLE", repos: [{ url: "https://github.com/ashot/codecast" }], url: `https://cursor.com/agents/${AGENT}`, createdAt: RUN.createdAt, updatedAt: RUN.updatedAt, latestRunId: RUN.id };
    const json = (body: unknown) => () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const watcher = new CursorCloudWatcher({
      rootDir: root,
      readKey: () => "crsr_test",
      resolveRepoDir: async (repo) => (repo.name === "codecast" ? "/Users/me/src/codecast" : null),
      now: () => Date.parse(RUN.updatedAt),
      fetchImpl: fakeFetch({
        "/v1/agents": json({ items: [agent] }),
        [`/v1/agents/${AGENT}/runs`]: json({ items: [RUN] }),
        [`/v1/agents/${AGENT}/runs/${RUN.id}/stream`]: () => new Response(SSE),
        [`/v0/agents/${AGENT}/conversation`]: json({ id: AGENT, messages: CONVERSATION }),
      }),
    });
    const sessions: Array<{ sessionId: string; filePath: string }> = [];
    watcher.on("session", (e) => sessions.push(e));
    await watcher.poll();
    expect(sessions).toEqual([{ sessionId: AGENT, filePath: watcher.transcriptPath(AGENT), eventType: "add" } as any]);
    const msgs = parseCursorTranscriptFile(fs.readFileSync(watcher.transcriptPath(AGENT), "utf8"), AGENT);
    expect(msgs.at(-1)?.content).toBe("pong");
    expect(JSON.parse(fs.readFileSync(path.join(root, AGENT, "meta.json"), "utf8"))).toMatchObject({ cwd: "/Users/me/src/codecast", title: "codecast probe" });
    // Settled and unchanged: the next poll neither refetches nor re-emits.
    await watcher.poll();
    expect(sessions.length).toBe(1);
  });
});
