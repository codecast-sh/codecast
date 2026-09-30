import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, cloudAgentCredentialError } from "@codecast/shared/contracts";
import { parseMirrorTranscriptFile } from "../parser.js";
import { cloudApiErrorOf, CloudApiError } from "./http.js";
import { execFileSync } from "child_process";
import { CLOUD_AGENT_ACTION_SUBTYPE, CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { readTranscriptIngest } from "../workers/ingestClient.js";
import { buildCodexCloudTranscript, CodexCloudAdapter, CodexCloudApi, codexCitations, codexTaskLines, codexTaskTitle, isRunningTurnStatus, taskGit, taskRepo, taskTurnChain, type CodexKnown, type WhamTask, type WhamTurn, type WhamTurns } from "./codex.js";
import { CloudAgentRegistry } from "./registry.js";
import { checkCloudAgentLogin } from "./registry.js";
import { applyInCheckout, CloudAgentSessions, setupErrorOf, type CloudAgentSession } from "./sessions.js";
import { porcelainEntries } from "../gitPlane.js";
import { classifyMirrorTranscriptTail, mirrorMessageUuid, readMetaJson } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError, type CloudAgentLoginCommand } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";
import { deviceLabel } from "../remote/device.js";

// Real payloads from chatgpt.com/backend-api/wham (2026-09-29), scrubbed.
const FIXTURES = path.join(import.meta.dir, "..", "__fixtures__", "codexCloud");
const fixture = <T = any>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const ASK = fixture<WhamTurns>("turns.ask.json");
const FOLLOW_UP = fixture<WhamTurns>("turns.askFollowUp.json");
const BEST_OF_2 = fixture<WhamTurns>("turns.bestOf2.json");
const LEGACY = fixture<WhamTurns>("turns.legacy.json");
const LIST = fixture<{ items: WhamTask[]; cursor: string }>("list.json");

/** A mirror read back the way the daemon's ingest reads it. */
function read(turns: WhamTurns, opts: { taskId?: string; notice?: string; pullRequests?: WhamTask["pull_requests"] } = {}) {
  const jsonl = buildCodexCloudTranscript({ taskId: "task", turns, createdAt: 1, ...opts });
  return { jsonl, messages: parseMirrorTranscriptFile("codex", jsonl, "task") };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const assistantTurn = (turns: WhamTurns, placement = 0) => Object.values(turns.turn_mapping!).map((n) => n.turn!).find((t) => t.type === "assistant" && (t.attempt_placement ?? 0) === placement)!;

/** A JWT with the claims given (unsigned: codecast only reads its own machine's file). */
function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}
function authJson(expSeconds: number): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ exp: expSeconds }),
      refresh_token: "rt",
      account_id: "acct-1",
      id_token: jwt({ email: "person@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
    },
  });
}
const NOW = 1_790_724_000_000;
const VALID = authJson(NOW / 1000 + 3600);
const EXPIRED = authJson(NOW / 1000 - 3600);

/** A fetch over the wham API: routes by method and path, records every call. */
function wham(routes: Record<string, (body: any) => Response>) {
  const calls: Array<{ method: string; path: string; body?: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/backend-api/wham", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${p}${url.search}`, body, headers: init?.headers as Record<string, string> });
    const hit = routes[`${method} ${p}`];
    return hit ? hit(body) : new Response(JSON.stringify({ detail: "Invalid task ID" }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

function adapter(auth: string | null, fetchImpl?: typeof fetch, extra: Partial<ConstructorParameters<typeof CodexCloudAdapter>[0]> = {}) {
  return new CodexCloudAdapter({ readAuth: () => auth, fetchImpl, now: () => NOW, ...extra });
}

const SESSION: CloudAgentSession = { model: "", repoUrl: "https://github.com/ashot/chatdoc", startingRef: "main" };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });

describe("Codex Cloud transcript: tasks with app-server events", () => {
  test("an ask task: prompt, reasoning, the command with its output, the answer, turn end", () => {
    const { jsonl, messages } = read(ASK);
    expect(messages.map((m) => [m.role, m.thinking ? "thinking" : m.toolCalls?.[0]?.name ?? "text"])).toEqual([
      ["user", "text"],
      ["assistant", "thinking"],
      ["assistant", "commandExecution"],
      ["assistant", "thinking"],
      ["assistant", "text"],
    ]);
    expect(messages[0].content).toStartWith("codecast spike: list the top-level directories");
    // The prompt is the user turn's; the thread's own userMessage item is not shown twice.
    expect(messages.filter((m) => m.content.startsWith("codecast spike"))).toHaveLength(1);
    expect(messages[2].toolCalls![0].input.command).toContain("find .. -name AGENTS.md");
    expect(messages[2].toolResults![0].content).toContain("AGENTS.md");
    // The output items' final answer is the agentMessage already shown: once.
    expect(messages.filter((m) => m.content.startsWith("## Top-level directories"))).toHaveLength(1);
    expect(messages.at(-1)!.stopReason).toBe("end_turn");
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("idle");
  });

  test("every record is dated by the payload, ids by turn and item, so a re-render changes nothing", () => {
    const { jsonl, messages } = read(ASK);
    expect(messages[0].timestamp).toBe(Math.round(1790724338.982565 * 1000));
    // The command completed at its item's completedAtMs.
    expect(messages[2].timestamp).toBe(1790724353851);
    for (let i = 1; i < messages.length; i++) expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    expect(messages[0].uuid).toBe("task:usertrn_e_6abc48f2fb84832e80032cf195e8ccf4");
    expect(messages[2].uuid).toStartWith("task:assttrn_e_6abc48f3df90832e8e63b8c75f9e2116:exec-");
    expect(new Set(messages.map((m) => m.uuid)).size).toBe(messages.length);
    expect(buildCodexCloudTranscript({ taskId: "task", turns: clone(ASK), createdAt: 999 })).toBe(jsonl);
  });

  test("a follow-up renders after its turn, in order, each turn closed", () => {
    const { jsonl, messages } = read(FOLLOW_UP);
    const prompts = messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toStartWith("codecast spike follow-up");
    expect(messages.at(-1)!.content).toBe("Python");
    expect(jsonl.match(/"turn_ended"/g)).toHaveLength(2);
    for (let i = 1; i < messages.length; i++) expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
  });

  test("best of 2: the task's own line is attempt 1, says how many ran, with its pull request and the diff", () => {
    const tasks = LIST.items;
    const task = tasks.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!;
    const { messages } = read(BEST_OF_2, { taskId: task.id, pullRequests: task.pull_requests });
    const attempt0 = assistantTurn(BEST_OF_2, 0).id.split("~")[1];
    const attempt1 = assistantTurn(BEST_OF_2, 1).id.split("~")[1];
    expect(messages.some((m) => m.uuid!.includes(attempt0))).toBe(true);
    expect(messages.some((m) => m.uuid!.includes(attempt1))).toBe(false);
    // How many ran, and that the other is a branch of the session.
    const attempts = messages.find((m) => m.uuid!.endsWith(":attempts"))!.content;
    expect(attempts).toContain("ran 2 attempts at this; this is attempt 1. Each attempt is a branch of this session");
    // Recording the pull request's title and body is not a row of its own: the pull request row says it.
    expect(messages.some((m) => m.toolCalls?.some((c) => /make_pr/i.test(c.name)))).toBe(false);
    const pr = messages.find((m) => m.uuid!.endsWith(":pr"))!;
    expect(pr.content).toStartWith("**docs: add codecast spike marker** · [pull request #18](https://github.com/ashot/chatdoc/pull/18)");
    const diff = messages.find((m) => m.toolCalls?.[0]?.name === "fileChange")!;
    expect(diff.toolCalls![0].input).toEqual({ changes: "update: README.md" });
    expect(diff.toolResults![0].content).toStartWith("diff --git a/README.md b/README.md");
    // Codex's inline citation reads as a path and line.
    expect(messages.find((m) => m.subtype === "final_answer")?.content ?? messages.find((m) => m.content.startsWith("### Summary"))!.content).toContain("`README.md:99`");
  });

  test("the task's repository and pushed branch: its pull request's head", () => {
    const chain = taskTurnChain(BEST_OF_2);
    expect(taskRepo(chain)).toBe("ashot/chatdoc");
    const task = LIST.items.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!;
    expect(taskGit(task.id, task, chain, "ashot/chatdoc")).toEqual({
      agentId: task.id,
      repoUrl: "https://github.com/ashot/chatdoc",
      branch: "codex/add-codecast-spike-comment-to-readme.md",
      prUrl: "https://github.com/ashot/chatdoc/pull/18",
    });
    // An ask task pushed nothing: no branch, never the environment's base branch ("main" in task_status_display).
    const ask = LIST.items.find((t) => t.id === "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")!;
    expect(ask.task_status_display?.branch_name).toBe("main");
    expect(taskGit(ask.id, ask, taskTurnChain(ASK), "ashot/chatdoc")).toBeNull();
  });

  test("a task Codex has not named yet has no title: the session takes its prompt's until the real one comes", () => {
    const created = fixture("create.response.json").task as WhamTask;
    expect(created.title).toBe("New task");
    expect(codexTaskTitle(created)).toBeUndefined();
    expect(codexTaskTitle(LIST.items[0])).toBe(LIST.items[0].title);
  });

  test("a pull request another attempt opened is that attempt's branch's, never the task's own line's", () => {
    const task = clone(LIST.items.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!);
    const other = assistantTurn(BEST_OF_2, 1);
    task.pull_requests = task.pull_requests!.map((p) => ({ ...p, assistant_turn_id: other.id }));
    const turns = clone(BEST_OF_2);
    delete assistantTurn(turns, 0).pull_request_data;
    const { messages } = read(turns, { pullRequests: task.pull_requests });
    expect(messages.find((m) => m.uuid!.endsWith(":pr"))!.content).not.toContain("pull request #18");
    expect(taskGit(task.id, task, taskTurnChain(turns), "ashot/chatdoc")?.prUrl).toBeUndefined();
    const branch = buildCodexCloudTranscript({ taskId: task.id, lineId: other.id, turns, createdAt: 1, pullRequests: task.pull_requests });
    expect(parseMirrorTranscriptFile("codex", branch, task.id).find((m) => m.uuid!.endsWith(":pr"))!.content).toContain("[pull request #18](https://github.com/ashot/chatdoc/pull/18)");
    expect(taskGit(other.id, task, taskTurnChain(turns, other.id), "ashot/chatdoc")).toMatchObject({ agentId: other.id, prUrl: "https://github.com/ashot/chatdoc/pull/18" });
  });

  test("attempts with no placement (older tasks) take the order they started in, each numbered once", () => {
    const turns = clone(BEST_OF_2);
    for (const n of Object.values(turns.turn_mapping!)) if (n.turn) n.turn.attempt_placement = null;
    const [first, second] = [A0, A1].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    expect(taskTurnChain(turns).at(-1)!.id).toBe(first.id);
    const branch = buildCodexCloudTranscript({ taskId: BEST_TASK.id, lineId: second.id, turns, createdAt: 1 });
    expect(branch).toContain("this is attempt 2");
    expect(buildCodexCloudTranscript({ taskId: BEST_TASK.id, turns, createdAt: 1 })).toContain("this is attempt 1");
  });

  test("lines hold still when the task continues from another attempt: each keeps its own", () => {
    const turns = clone(BEST_OF_2);
    turns.current_turn_id = assistantTurn(turns, 1).id;
    expect(taskTurnChain(turns).map((t) => t.attempt_placement ?? null)).toEqual([null, 0]);
    expect(taskTurnChain(turns, assistantTurn(turns, 1).id).map((t) => t.attempt_placement ?? null)).toEqual([null, 1]);
  });
});

describe("Codex Cloud transcript: running, cancelled and failed turns", () => {
  test("a running turn shows its latest event and no turn end; done, it renders whole and the line is gone", () => {
    const running = clone(FOLLOW_UP);
    const last = taskTurnChain(running).at(-1)!;
    last.turn_status = "in_progress";
    last.thread_events = { events: [] };
    last.output_items = [];
    last.latest_event = { text: "Running the tests" };
    const { jsonl, messages } = read(running);
    expect(messages.at(-1)!.content).toBe("ℹ Running the tests");
    expect(messages.at(-1)!.timestamp).toBe(Math.round((last.created_at ?? 0) * 1000));
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("active");
    const done = read(FOLLOW_UP).messages;
    expect(done.some((m) => m.content.startsWith("ℹ Running"))).toBe(false);
    // Rows the running render shared with the finished one keep their id and time.
    for (const m of messages.slice(0, -1)) expect(done.find((d) => d.uuid === m.uuid)?.timestamp).toBe(m.timestamp);
  });

  test("a follow-up just sent (its turn not opened yet) leaves the task working", () => {
    const turns = clone(ASK);
    const prev = assistantTurn(turns).id;
    turns.turn_mapping!["task_e_x~usertrn_e_new"] = { turn: { id: "task_e_x~usertrn_e_new", type: "user", created_at: 1790724400, previous_turn_id: prev, input_items: [{ type: "message", content: [{ content_type: "text", text: "and the version?" }] }] } };
    const { jsonl, messages } = read(turns);
    expect(messages.at(-1)!.content).toBe("and the version?");
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("active");
  });

  test("cancelled says so; failed is a stopped-turn banner with the reason", () => {
    const cancelled = clone(ASK);
    Object.assign(assistantTurn(cancelled), { turn_status: "cancelled", thread_events: { events: [] }, output_items: [] });
    expect(read(cancelled).messages.at(-1)!.content).toBe("ℹ Cancelled.");
    const failed = clone(ASK);
    Object.assign(assistantTurn(failed), { turn_status: "failed", thread_events: { events: [] }, output_items: [], error: { message: "Setup script failed" } });
    const last = read(failed).messages.at(-1)!;
    expect(last.content).toBe(`${CLIENT_ERROR_BANNER_PREFIX} Codex Cloud turn failed: Setup script failed`);
    expect(last.stopReason).toBe("end_turn");
  });

  test("a status the spike never saw has ended the turn, and says what it was", () => {
    const odd = clone(ASK);
    Object.assign(assistantTurn(odd), { turn_status: "timed_out", thread_events: { events: [] }, output_items: [] });
    const { jsonl, messages } = read(odd);
    expect(messages.at(-1)!.content).toBe("ℹ Codex Cloud ended this turn as timed_out.");
    expect(classifyMirrorTranscriptTail(jsonl)).not.toBe("active");
    expect(isRunningTurnStatus("timed_out")).toBe(false);
    expect(isRunningTurnStatus("pending")).toBe(true);
    expect(isRunningTurnStatus("in_progress")).toBe(true);
  });
});

describe("Codex Cloud transcript: legacy tasks (worklog)", () => {
  const { messages } = read(LEGACY);

  test("every follow-up in order, each with its tool calls, outputs, answer and diff", () => {
    const prompts = messages.filter((m) => m.role === "user");
    expect(prompts.map((m) => m.content.slice(0, 20))).toEqual(["migrate the backend ", "I added the env vari", "Install jest", "try testing again, a"]);
    for (let i = 1; i < messages.length; i++) expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    expect(messages.filter((m) => m.uuid!.endsWith(":answer"))).toHaveLength(4);
    expect(messages.filter((m) => m.toolCalls?.[0]?.name === "fileChange")).toHaveLength(3);
  });

  test("shell calls are commands with their terminal output; narration is thinking", () => {
    const ls = messages.find((m) => m.toolCalls?.[0]?.input.command === "ls")!;
    expect(ls.toolCalls![0].name).toBe("commandExecution");
    // The empty read that followed it (feed_chars with no chars) adds its output to the command.
    expect(ls.toolResults![0].content).toContain("root@4304f0c5e18f:/workspace# ls\nchatdoc");
    expect(messages.filter((m) => m.toolCalls?.[0]?.input.command === "")).toHaveLength(0);
    // A key typed into the terminal (Ctrl-C to stop a command) reads as a terminal echoes it.
    const turns = clone(LEGACY);
    const log = Object.values(turns.turn_mapping!).map((n) => n.turn!).find((t) => t.type === "assistant")!.worklog!.messages!;
    log.push({ id: "ctrl-c", author: { role: "assistant" }, create_time: (log.at(-1)!.create_time ?? 0) + 1, content: { content_type: "code", text: JSON.stringify({ session_name: "shell", chars: "\u0003" }) }, recipient: "container.feed_chars" });
    expect(read(turns).messages.find((m) => m.uuid!.endsWith(":ctrl-c"))!.toolCalls![0].input.command).toBe("^C");
    const narration = messages.find((m) => m.thinking?.startsWith("I'll check out the /workspace/chatdoc repo"))!;
    expect(narration.content).toBe("");
    // Any other tool is the item Codex records it as now, its reply as its output.
    const other = clone(LEGACY);
    const log2 = Object.values(other.turn_mapping!).map((n) => n.turn!).find((t) => t.type === "assistant")!.worklog!.messages!;
    const at = (log2.at(-1)!.create_time ?? 0) + 1;
    log2.push(
      { id: "web", author: { role: "assistant" }, create_time: at, content: { content_type: "code", text: JSON.stringify({ q: "mastra" }) }, recipient: "browser.search" },
      { id: "web-r", author: { role: "tool", name: "browser.search" }, create_time: at, content: { content_type: "text", parts: ["3 results"] }, recipient: "all" },
    );
    const web = read(other).messages.find((m) => m.uuid!.endsWith(":web"))!;
    expect(web.toolCalls![0]).toMatchObject({ name: "browser.search", input: { q: "mastra" } });
    expect(web.toolResults![0]).toMatchObject({ toolUseId: "web", content: "3 results" });
    // A terminal reply cut short still reads as its lines, never as raw JSON.
    expect(messages.some((m) => m.toolResults?.[0]?.content.startsWith('{"type"'))).toBe(false);
  });

  test("the answer keeps its text and file citations; a follow-up's diff is its own change", () => {
    const answer = messages.find((m) => m.uuid!.endsWith(":answer"))!;
    expect(answer.content).toStartWith("### Summary\n- Added Mastra as a backend dependency");
    expect(answer.content).toContain("`package.json:40-47`");
    const followUpTurn = "assttrn_e_68aa10af1a50832ea120eb9608419b86";
    const diff = messages.find((m) => m.uuid === `task:${followUpTurn}:diff`)!;
    expect(diff.toolResults![0].content).toStartWith("diff --git a/server/AI.ts");
    // The last turn opened pull request #16: its summary links it.
    expect(messages.filter((m) => m.uuid!.endsWith(":pr")).at(-1)!.content).toContain("[pull request #16](https://github.com/ashot/chatdoc/pull/16)");
  });

  test("opening the shell and recording the pull request add no rows, and their replies join no command", () => {
    expect(messages.filter((m) => m.toolCalls?.some((c) => c.name.startsWith("container.")))).toEqual([]);
    const turns = clone(LEGACY);
    const first = Object.values(turns.turn_mapping!).map((n) => n.turn!).filter((t) => t.type === "assistant").sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))[0];
    const log = first.worklog!.messages!;
    const t = (log.at(-1)!.create_time ?? 0) + 1;
    log.push(
      { id: "mk", author: { role: "assistant" }, create_time: t, content: { content_type: "code", text: JSON.stringify({ title: "feat: x", body: "b" }) }, recipient: "container.make_pr" },
      { id: "mk-r", author: { role: "tool", name: "container.make_pr" }, create_time: t, content: { content_type: "text", parts: ["Recorded PR message."] }, recipient: "all" },
    );
    const all = read(turns).messages;
    expect(all.some((m) => m.uuid!.endsWith(":mk"))).toBe(false);
    expect(all.some((m) => m.toolResults?.some((r) => r.content.includes("Recorded PR message.")))).toBe(false);
  });

  test("a worklog that ends in the answer says it once, from the worklog, citations kept", () => {
    // Live worklogs end with the answer (end_turn), citations and all; the output item repeats it without them.
    const turns = clone(LEGACY);
    const first = Object.values(turns.turn_mapping!).map((n) => n.turn!).filter((t) => t.type === "assistant").sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))[0];
    const log = first.worklog!.messages!;
    log.push({ id: "final", author: { role: "assistant" }, create_time: (log.at(-1)!.create_time ?? 0) + 1, content: { content_type: "text", parts: ["### Summary\n- Added Mastra【F:package.json†L40-L47】【F:server/AI.ts†L19-L22】"] }, recipient: "all", end_turn: true });
    const all = read(turns).messages;
    const key = first.id.slice(first.id.indexOf("~") + 1);
    const answers = all.filter((m) => m.uuid!.includes(key) && m.content.startsWith("### Summary"));
    expect(answers.map((m) => m.uuid)).toEqual([`task:${key}:final`]);
    expect(answers[0].content).toBe("### Summary\n- Added Mastra `package.json:40-47` `server/AI.ts:19-22`");
    // The other turns' logs have no end_turn answer: theirs still comes from the output items.
    expect(all.filter((m) => m.uuid!.endsWith(":answer"))).toHaveLength(3);
  });
});

describe("Codex Cloud API", () => {
  test("the list: every task, dated in ms, versioned by what moves, paged by its cursor", async () => {
    const { fetchImpl, calls } = wham({ "GET /tasks/list": json(LIST) });
    const api = adapter(VALID, fetchImpl).client() as CodexCloudApi;
    const page = await adapter(VALID, fetchImpl).listAgents(api);
    expect(page.items).toHaveLength(6);
    expect(page.items[0]).toMatchObject({ id: "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45", updatedAtMs: Math.round(1790724360.440929 * 1000), active: false });
    expect(page.items[0].version).toContain("completed");
    expect(page.nextCursor).toBe(LIST.cursor);
    expect(calls[0].path).toBe("/tasks/list?limit=20&task_filter=current");
    // The machine's own Codex headers.
    expect(calls[0].headers.Authorization).toStartWith("Bearer ");
    expect(calls[0].headers["ChatGPT-Account-Id"]).toBe("acct-1");
  });

  test("error bodies: {detail}, {detail: {type, message}} and {error: {message, type}}", () => {
    const e401 = cloudApiErrorOf(401, fixture("error.401.json"), "x");
    expect(e401.message).toContain("Could not parse your authentication token");
    expect(e401.keyRejected).toBe(true);
    expect(cloudApiErrorOf(404, fixture("error.404.json"), "x").message).toBe("Invalid task ID");
    const e400 = cloudApiErrorOf(400, fixture("error.400.json"), "x");
    expect(e400.code).toBe("invalid_request_error");
    expect(e400.message).not.toBe("x");
    const e403 = cloudApiErrorOf(403, { detail: { type: "repo_not_accessible", message: "Repository is not accessible" } }, "x");
    expect([e403.code, e403.message]).toEqual(["repo_not_accessible", "Repository is not accessible"]);
  });
});

describe("Codex Cloud sign-in (read only, never refreshed)", () => {
  test("no login is the missing-credentials card; an expired token is its own card, naming the machine and the date", () => {
    const missing = adapter(null).client() as CloudAgentSetupError;
    expect(missing.kind).toBe("key_missing");
    expect(cloudAgentCredentialError("codex", missing.message)?.id).toBe("codex");
    const expired = adapter(EXPIRED).client() as CloudAgentSetupError;
    expect(expired.kind).toBe("key_invalid");
    expect(expired.message).toBe(`The Codex sign-in on ${deviceLabel()} expired ${new Date(NOW - 3600_000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`);
    expect(expired.message).not.toContain("refused");
    expect(cloudAgentCredentialError("codex", expired.message)?.id).toBe("codex");
    expect(expired.holdReason).toBe(`waiting for a Codex sign-in on ${deviceLabel()}`);
    expect(adapter(VALID).client()).toBeInstanceOf(CodexCloudApi);
  });

  test("an API-key login is no sign-in here, and the card says what signing in changes", () => {
    const apiKey = adapter(JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: null })).client() as CloudAgentSetupError;
    expect(apiKey.kind).toBe("key_missing");
    expect(apiKey.reason).toContain("API key");
    expect(cloudAgentCredentialError("codex", apiKey.message)?.id).toBe("codex");
  });

  test("check (the core's verdict): the account and plan Codex names; signed out, expired, refused and turned off each say so", async () => {
    const ok = wham({ "GET /usage": json({ email: "person@example.com", plan_type: "pro" }), "GET /tasks/list": json({ items: [] }) });
    expect(await checkCloudAgentLogin(adapter(VALID, ok.fetchImpl))).toEqual({ state: "signed_in", account: "person@example.com", plan: "pro" });
    expect(await checkCloudAgentLogin(adapter(null))).toEqual({ state: "signed_out" });
    const apiKey = await checkCloudAgentLogin(adapter(JSON.stringify({ OPENAI_API_KEY: "sk-test" })));
    expect(apiKey.state).toBe("signed_out");
    expect(apiKey.detail).toContain("ChatGPT plan");
    expect((await checkCloudAgentLogin(adapter(EXPIRED))).state).toBe("expired");
    const refused = wham({ "GET /usage": json(fixture("error.401.json"), 401), "GET /tasks/list": json(fixture("error.401.json"), 401) });
    expect((await checkCloudAgentLogin(adapter(VALID, refused.fetchImpl))).state).toBe("expired");
    const off = wham({ "GET /usage": json({ plan_type: "enterprise" }), "GET /tasks/list": json({ detail: "Forbidden" }, 403) });
    const disabled = await checkCloudAgentLogin(adapter(VALID, off.fetchImpl));
    expect(disabled.state).toBe("disabled");
    expect(disabled.detail).toContain("Use Codex in the cloud");
    const down = wham({ "GET /usage": json({}, 500), "GET /tasks/list": json({ detail: "upstream down" }, 502) });
    expect(await checkCloudAgentLogin(adapter(VALID, down.fetchImpl))).toMatchObject({ state: "unreachable", detail: "upstream down" });
    // A 403 from the proxy in front of the API (a challenge page, no reason of the API's own) says nothing about the workspace.
    const challenge = wham({ "GET /usage": json({ plan_type: "pro" }), "GET /tasks/list": () => new Response("<html>Just a moment...</html>", { status: 403 }) });
    expect(await checkCloudAgentLogin(adapter(VALID, challenge.fetchImpl))).toMatchObject({ state: "unreachable" });
  });

  test("sign in runs the machine's own codex login, saying how to install it when it is missing", async () => {
    const ran: CloudAgentLoginCommand[] = [];
    await adapter(null, undefined, { runLogin: async (command) => { ran.push(command); } }).login!.start();
    expect(ran[0].argv).toEqual(["codex", "login"]);
    // A machine with no browser signs in with a code it shows, opened on any device.
    expect(ran[0].headlessArgv).toEqual(["codex", "login", "--device-auth"]);
    expect(ran[0].missing).toContain("npm i -g @openai/codex");
  });
});

describe("Codex Cloud drive", () => {
  test("a follow-up continues the current turn, in ask mode for an ask task", async () => {
    const task = LIST.items.find((t) => t.id === "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")!;
    const { fetchImpl, calls } = wham({ [`GET /tasks/${task.id}/turns`]: json(ASK), [`GET /tasks/${task.id}`]: json({ task }), "POST /tasks": json({ task: { id: task.id } }) });
    const a = adapter(VALID, fetchImpl);
    await a.followUp(a.client() as CodexCloudApi, task.id, "and the version?");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      follow_up: { task_id: task.id, turn_id: assistantTurn(ASK).id, run_environment_in_qa_mode: true },
      input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: "and the version?" }] }],
    });
  });

  test("a follow-up to a task it cannot read fails rather than guess code mode", async () => {
    const id = "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45";
    const { fetchImpl, calls } = wham({ [`GET /tasks/${id}/turns`]: json(ASK), [`GET /tasks/${id}`]: json({ detail: "Bad gateway" }, 502) });
    const a = adapter(VALID, fetchImpl);
    await expect(a.followUp(a.client() as CodexCloudApi, id, "more")).rejects.toBeInstanceOf(CloudApiError);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a follow-up while a turn runs is busy (held and retried); cancel stops it", async () => {
    const running = clone(ASK);
    assistantTurn(running).turn_status = "pending";
    const id = "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45";
    const { fetchImpl, calls } = wham({ [`GET /tasks/${id}/turns`]: json(running), [`GET /tasks/${id}`]: json({ task: {} }), [`POST /tasks/${id}/cancel`]: json({ success: true }) });
    const a = adapter(VALID, fetchImpl);
    const api = a.client() as CodexCloudApi;
    await expect(a.followUp(api, id, "more")).rejects.toBeInstanceOf(CloudAgentBusyError);
    expect(await a.cancel(api, id)).toBe("the running turn");
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/tasks/${id}/cancel`, body: {} });
    const idle = wham({ [`GET /tasks/${id}/turns`]: json(ASK) });
    expect(await a.cancel(new CodexCloudApi({}, idle.fetchImpl), id)).toBeNull();
  });

  test("create picks the repository's environment; none is a setup card with the environments link", async () => {
    const env = { id: "env1", label: "ashot/chatdoc", env_vars: { SECRET: "x" }, secrets: { K: "v" }, repo_map: { r: { repository_full_name: "ashot/chatdoc", default_branch: "main" } } };
    const ok = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([env]), "POST /tasks": json({ task: { id: "task_e_new" } }) });
    const a = adapter(VALID, ok.fetchImpl);
    expect(await a.create(a.client() as CodexCloudApi, { ...SESSION, startingRef: undefined }, "hi")).toEqual({ agentId: "task_e_new", url: "https://chatgpt.com/codex/tasks/task_e_new" });
    expect(ok.calls.at(-1)!.body.new_task).toEqual({ environment_id: "env1", branch: "main", run_environment_in_qa_mode: false });
    const none = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([]), "GET /environments": json([{ ...env, id: "other", repo_map: { r: { repository_full_name: "ashot/elsewhere" } } }]) });
    const b = adapter(VALID, none.fetchImpl);
    const err = await b.create(b.client() as CodexCloudApi, SESSION, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.message).toContain("https://chatgpt.com/codex/settings/environments");
  });

  test("a 403 names the admin permission, or the repository Codex cannot reach; a 401 is the sign-in card", () => {
    const a = adapter(VALID);
    const off = setupErrorOf(a, new CloudApiError(403, undefined, "Forbidden"), SESSION)!;
    expect(off.kind).toBe("access");
    expect(off.holdReason).toBe("waiting until Codex Cloud lets this account in");
    expect(off.message).toContain("Use Codex in the cloud");
    expect(cloudAgentCredentialError("codex", off.message)).toBeNull();
    const repo = setupErrorOf(a, new CloudApiError(403, "repo_not_accessible", "Repository is not accessible"), SESSION)!;
    expect(repo.kind).toBe("repo");
    expect(repo.message).toContain("ashot/chatdoc");
    const signIn = setupErrorOf(a, new CloudApiError(401, undefined, "Could not parse your authentication token."), SESSION)!;
    expect(signIn.kind).toBe("key_invalid");
    expect(cloudAgentCredentialError("codex", signIn.message)?.id).toBe("codex");
  });
});

describe("Codex Cloud mirror (the core watcher over the adapter)", () => {
  function mirrorDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cloud-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }
  const ask = LIST.items.find((t) => t.id === "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")!;
  const routes = { "GET /tasks/list": json({ items: [ask] }), [`GET /tasks/${ask.id}/turns`]: json(ASK) };

  test("a pass writes the task's transcript and meta (title, url, placed in its repo's checkout), and emits it", async () => {
    const rootDir = mirrorDir();
    const { fetchImpl } = wham(routes);
    const watcher = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir, now: () => NOW, resolveRepoDir: async (r) => r.name === "chatdoc" ? "/Users/me/src/chatdoc" : null });
    const events: string[] = [];
    const git: unknown[] = [];
    watcher.on("session", (e) => events.push(`${e.eventType} ${e.sessionId}`));
    watcher.on("git", (g) => git.push(g));
    await watcher.poll();
    expect(events).toEqual([`add ${ask.id}`]);
    const meta = await readMetaJson(path.join(rootDir, ask.id));
    expect(meta).toMatchObject({ cwd: "/Users/me/src/chatdoc", title: "List top-level directories and read package.json" });
    const written = fs.readFileSync(watcher.transcriptPath(ask.id), "utf8");
    expect(written).toBe(buildCodexCloudTranscript({ taskId: ask.id, turns: ASK, createdAt: Math.round(ask.created_at! * 1000) }));
    // An ask task pushed no branch of its own, which is said (it clears one a session carries).
    expect(git).toEqual([{ agentId: ask.id }]);
    // Nothing moved: the next pass reads the list only.
    await watcher.poll();
    expect(events).toHaveLength(1);
    // A restart announces the transcript and the branch again (here none, which clears a stale one):
    // a settled task is not mirrored again, and its first git report can land before its session exists.
    const again = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir, now: () => NOW });
    const replayed: unknown[] = [];
    again.on("git", (g) => replayed.push(g));
    again.on("session", (e) => replayed.push(e.eventType));
    again.start();
    again.stop();
    expect(replayed).toEqual(["add", { agentId: ask.id }]);
    // No environment secrets reach the mirror.
    expect(fs.readdirSync(path.join(rootDir, ask.id)).map((f) => fs.readFileSync(path.join(rootDir, ask.id, f), "utf8")).join("")).not.toContain("env_vars");
  });

  test("a task whose turns fail keeps no other task from syncing, and waits before it is read again", async () => {
    const broken = { ...ask, id: "task_e_broken" };
    const { fetchImpl, calls } = wham({ "GET /tasks/list": json({ items: [broken, ask] }), [`GET /tasks/${ask.id}/turns`]: json(ASK), "GET /tasks/task_e_broken/turns": json({ detail: "upstream down" }, 502) });
    let now = NOW;
    const watcher = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir: mirrorDir(), now: () => now });
    const events: string[] = [];
    const errors: string[] = [];
    watcher.on("session", (e) => events.push(e.sessionId));
    watcher.on("error", (e) => errors.push(e.message));
    await watcher.poll();
    expect(events).toEqual([ask.id]);
    expect(errors).toEqual(["task_e_broken: upstream down"]);
    const brokenReads = () => calls.filter((c) => c.path === "/tasks/task_e_broken/turns").length;
    await watcher.poll();
    expect(brokenReads()).toBe(1);
    now += 61_000;
    await watcher.poll();
    expect(brokenReads()).toBe(2);
  });

  test("a new title alone reaches the session, and meta.json keeps the provider's earlier ones", async () => {
    const rootDir = mirrorDir();
    const routes = { "GET /tasks/list": json({ items: [{ ...ask, title: "New task", has_generated_title: false }] }), [`GET /tasks/${ask.id}/turns`]: json(ASK) };
    const watcher = new CloudAgentWatcher(adapter(VALID, wham(routes).fetchImpl), { rootDir, now: () => NOW });
    const events: string[] = [];
    watcher.on("session", (e) => events.push(e.eventType));
    await watcher.poll();
    expect((await readMetaJson(path.join(rootDir, ask.id)))?.title).toBeUndefined();
    for (const [title, bump] of [["Count lines", 1], ["Count README lines", 2]] as const) {
      routes["GET /tasks/list"] = json({ items: [{ ...ask, title, updated_at: ask.updated_at! + bump }] });
      await watcher.poll();
    }
    expect(events).toEqual(["add", "change", "change"]);
    expect(await readMetaJson(path.join(rootDir, ask.id))).toMatchObject({ title: "Count README lines", formerTitles: ["New task", "Count lines"] });
  });

  test("with the account's sync off and nothing of codecast's to follow, a pass does not call the API at all", async () => {
    const { fetchImpl, calls } = wham(routes);
    const watcher = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir: mirrorDir(), now: () => NOW, importAll: () => false, hasOwnAgents: () => false });
    await watcher.poll();
    expect(calls).toEqual([]);
  });
});

test("codex citations: file ones read as path and lines, terminal ones are dropped", () => {
  expect(codexCitations("See README.md. 【F:README.md†L99】 and 【F:src/a.ts†L3-L9】【a1b2c3†L1-L3】")).toBe("See README.md. `README.md:99` and `src/a.ts:3-9`");
  // Two in a row, or one glued to a word, stay separate code spans.
  expect(codexCitations("tool use【F:server/AI.ts†L19-L22】【F:server/AI.ts†L618-L627】.")).toBe("tool use `server/AI.ts:19-22` `server/AI.ts:618-627`.");
});

// ── Phase 3: driving Codex Cloud ─────────────────────────────────────────────

const BEST_TASK = LIST.items.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!;
const ASK_TASK = LIST.items.find((t) => t.id === "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")!;
const A0 = assistantTurn(BEST_OF_2, 0);
const A1 = assistantTurn(BEST_OF_2, 1);
const PROMPT = A1.previous_turn_id!.split("~")[1];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function handle(agentId: string) {
  return { agentId, data: () => ({}), save() {}, notice: async () => undefined, scheduleRender() {}, follow: async () => {}, log() {} };
}
/** A follow-up on a turn: its user turn and a settled answer, chained the way the API chains them. */
function followUpOn(turns: WhamTurns, on: WhamTurn, key: string, extra: Partial<WhamTurn> = {}): { user: WhamTurn; answer: WhamTurn } {
  const task = on.id.split("~")[0];
  const user: WhamTurn = { id: `${task}~usertrn_${key}`, type: "user", previous_turn_id: on.id, created_at: (on.created_at ?? 0) + 100, input_items: [{ type: "message", content: [{ content_type: "text", text: `follow-up ${key}` }] }] };
  const answer: WhamTurn = { id: `${task}~assttrn_${key}`, type: "assistant", previous_turn_id: user.id, created_at: (on.created_at ?? 0) + 101, turn_status: "completed", output_items: [{ type: "message", content: [{ content_type: "text", text: `answer ${key}` }] }], ...extra };
  turns.turn_mapping![user.id] = { turn: user };
  turns.turn_mapping![answer.id] = { turn: answer };
  return { user, answer };
}

describe("Codex Cloud attempts as branches", () => {
  test("the task's own line and one branch per other attempt, forking at the prompt they share", () => {
    const lines = codexTaskLines(BEST_TASK.id, BEST_OF_2);
    expect(lines.map((l) => l.id)).toEqual([BEST_TASK.id, A1.id]);
    expect(lines[1]).toMatchObject({ parent: BEST_TASK.id, forkAt: PROMPT, ownFrom: 1 });
    // Read the way the ingest reads a branch (under its parent's id): the prompt is the very same message.
    const main = parseMirrorTranscriptFile("codex", buildCodexCloudTranscript({ taskId: BEST_TASK.id, turns: BEST_OF_2, createdAt: 1 }), BEST_TASK.id);
    const branch = parseMirrorTranscriptFile("codex", buildCodexCloudTranscript({ taskId: BEST_TASK.id, lineId: A1.id, turns: BEST_OF_2, createdAt: 1 }), BEST_TASK.id);
    const fork = mirrorMessageUuid(BEST_TASK.id, PROMPT);
    expect(main[0].uuid).toBe(fork);
    expect(branch[0]).toEqual(main[0]);
    expect(branch.find((m) => m.uuid!.endsWith(":attempts"))!.content).toContain("this is attempt 2");
    expect(branch.some((m) => m.uuid!.includes(A0.id.split("~")[1]))).toBe(false);
    expect(main.some((m) => m.uuid!.includes(A1.id.split("~")[1]))).toBe(false);
  });

  test("a follow-up sent on a branch continues that attempt, on that branch only", () => {
    const turns = clone(BEST_OF_2);
    const { user, answer } = followUpOn(turns, A1, "b1");
    expect(taskTurnChain(turns).map((t) => t.id)).toEqual([A0.previous_turn_id!, A0.id]);
    expect(taskTurnChain(turns, A1.id).map((t) => t.id)).toEqual([A1.previous_turn_id!, A1.id, user.id, answer.id]);
  });

  test("the mirror: the task's line names each branch with its fork point, the task's version and what it read; a branch mirrors from that alone", async () => {
    const { fetchImpl, calls } = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(BEST_OF_2) });
    const a = adapter(VALID, fetchImpl);
    const api = a.client() as CodexCloudApi;
    const main = (await a.mirror(api, handle(BEST_TASK.id), BEST_TASK))!;
    expect(main.children).toEqual([{ agentId: A1.id, description: "attempt 2", forkAt: PROMPT, version: main.version, known: { task: BEST_TASK, turns: BEST_OF_2 } }]);
    const read = calls.length;
    const branch = (await a.mirror(api, handle(A1.id), main.children![0].known as CodexKnown))!;
    expect(calls.length).toBe(read);
    expect(branch).toMatchObject({ title: `Attempt 2: ${BEST_TASK.title}`, version: main.version, url: CLOUD_AGENT_PROVIDERS.codex.agentUrl(BEST_TASK.id), children: [] });
    // This attempt pushed nothing (the pull request is attempt 1's): no branch of its own.
    expect(branch.git).toBeNull();
    // Every line says whether the task is archived; a branch's link is the task's page, never the branch id.
    expect([main.archived, branch.archived]).toEqual([false, false]);
    expect(CLOUD_AGENT_PROVIDERS.codex.agentUrl(A1.id)).toBe(`https://chatgpt.com/codex/tasks/${BEST_TASK.id}`);
    expect((await a.mirror(api, handle(BEST_TASK.id), { ...BEST_TASK, archived: true }))!.archived).toBe(true);
    // A line the task no longer has is skipped, not rendered empty.
    expect(await a.mirror(api, handle(`${BEST_TASK.id}~assttrn_gone`), main.children![0].known as CodexKnown)).toBeNull();
  });

  test("the watcher writes each branch with its fork point, and the ingest reads it as a fork of the task's session at the prompt", async () => {
    const rootDir = tmpDir("codex-branches-");
    const routes: Record<string, (b: any) => Response> = { "GET /tasks/list": json({ items: [BEST_TASK] }), [`GET /tasks/${BEST_TASK.id}/turns`]: json(BEST_OF_2) };
    const { fetchImpl, calls } = wham(routes);
    const watcher = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir, now: () => NOW });
    const events: string[] = [];
    watcher.on("session", (e) => events.push(`${e.eventType} ${e.sessionId}`));
    await watcher.poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(events.sort()).toEqual([`add ${A1.id}`, `add ${BEST_TASK.id}`].sort());
    expect(await readMetaJson(path.join(rootDir, A1.id))).toMatchObject({ parentAgentId: BEST_TASK.id, forkAt: PROMPT, title: `Attempt 2: ${BEST_TASK.title}` });
    const ingest = await readTranscriptIngest({ client: "codex", file: watcher.transcriptPath(A1.id), sessionId: A1.id, offset: 0, mirror: true });
    expect(ingest.metadata).toMatchObject({ forkOf: BEST_TASK.id, forkAtUuid: mirrorMessageUuid(BEST_TASK.id, PROMPT) });
    expect(ingest.metadata.parentSessionId).toBeUndefined();
    expect(ingest.messages[0].uuid).toBe(mirrorMessageUuid(BEST_TASK.id, PROMPT));
    // Nothing moved: no branch is read again. The task moved: both lines are, from one read of its turns.
    const turnReads = () => calls.filter((c) => c.path === `/tasks/${BEST_TASK.id}/turns`).length;
    await watcher.poll();
    expect(turnReads()).toBe(1);
    const moved = clone(BEST_OF_2);
    followUpOn(moved, A1, "b2");
    routes["GET /tasks/list"] = json({ items: [{ ...BEST_TASK, updated_at: BEST_TASK.updated_at! + 5 }] });
    routes[`GET /tasks/${BEST_TASK.id}/turns`] = json(moved);
    await watcher.poll();
    await new Promise((r) => setTimeout(r, 20));
    expect(turnReads()).toBe(2);
    expect(fs.readFileSync(watcher.transcriptPath(A1.id), "utf8")).toContain("follow-up b2");
    expect(fs.readFileSync(watcher.transcriptPath(BEST_TASK.id), "utf8")).not.toContain("follow-up b2");
  });
});

describe("Codex Cloud launch options (the composer's ask mode and attempts)", () => {
  const codex = CLOUD_AGENT_PROVIDERS.codex;
  test("create: the repository's pinned environment, the branch, ask mode and attempts", async () => {
    const envA = { id: "envA", repo_map: { r: { repository_full_name: "ashot/chatdoc", default_branch: "main" } }, env_vars: { SECRET: "x" } };
    const envB = { ...envA, id: "envB", is_pinned: true };
    const { fetchImpl, calls } = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([envA, envB]), "POST /tasks": json({ task: { id: "task_e_new" } }) });
    const a = adapter(VALID, fetchImpl);
    await a.create(a.client() as CodexCloudApi, { ...SESSION, ask: true, attempts: 2 }, "what does it do?");
    expect(calls.at(-1)!.body).toEqual({
      new_task: { environment_id: "envB", branch: "main", run_environment_in_qa_mode: true },
      input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: "what does it do?" }] }],
      metadata: { best_of_n: 2 },
    });
    // No environment made for the repository: one whose repositories name it.
    const other = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([]), "GET /environments": json([{ ...envA, id: "elsewhere", repo_map: { r: { repository_full_name: "ashot/other" } } }, { ...envA, id: "named" }]), "POST /tasks": json({ task: { id: "task_e_new" } }) });
    const b = adapter(VALID, other.fetchImpl);
    await b.create(b.client() as CodexCloudApi, SESSION, "hi");
    expect(other.calls.at(-1)!.body.new_task.environment_id).toBe("named");
    expect(other.calls.at(-1)!.body.metadata).toBeUndefined();
  });

  test("the composer's session becomes the task: start records the launch, the first message creates the task with it and binds the conversation", async () => {
    const repo = tmpDir("codex-repo-");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:ashot/chatdoc.git"]);
    const env = { id: "env1", repo_map: { r: { repository_full_name: "ashot/chatdoc", default_branch: "main" } } };
    const { fetchImpl, calls } = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([env]), "POST /tasks": json({ task: { id: "task_e_new" } }) });
    const binds: string[] = [];
    const queued: string[] = [];
    const reg = new CloudAgentRegistry([adapter(VALID, fetchImpl)], {
      bindSession: (c, agentId) => binds.push(`${c}=${agentId}`),
      agentForConversation: () => undefined,
      setStatus: () => {},
      addLine: async () => {},
      enqueueMessage: async (c, content) => { queued.push(`${c} ${content}`); },
      hostSession: async () => "hosted",
      releaseSession: () => {},
      placeSession: async () => true,
      retitleSession: async () => true,
      markArchived: async () => true,
      log: () => {},
    }, () => path.join(tmpDir("codex-sessions-"), "sessions.json"));
    expect(await reg.start("codex", "conv-1", repo, "cloud:ask+x2", "explain the repo")).toEqual({});
    expect(queued).toEqual(["conv-1 explain the repo"]);
    expect(await reg.start("codex", "conv-local", repo, "gpt-5.5", "hi")).toBeNull();
    expect((await reg.deliver("conv-1", "explain the repo"))?.adapter.spec.id).toBe("codex");
    expect(calls.at(-1)!.body).toMatchObject({ new_task: { environment_id: "env1", run_environment_in_qa_mode: true }, metadata: { best_of_n: 2 } });
    expect(binds).toEqual(["conv-1=task_e_new"]);
  }, 30_000);
});

describe("Codex Cloud drive: follow-ups, held while busy, cancel", () => {
  test("a follow-up on a branch continues that attempt's last turn", async () => {
    const { fetchImpl, calls } = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(BEST_OF_2), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }), "POST /tasks": json({ task: { id: BEST_TASK.id } }) });
    const a = adapter(VALID, fetchImpl);
    await a.followUp(a.client() as CodexCloudApi, A1.id, "tighten it");
    expect(calls.at(-1)!.body.follow_up).toEqual({ task_id: BEST_TASK.id, turn_id: A1.id, run_environment_in_qa_mode: false });
    await a.followUp(a.client() as CodexCloudApi, BEST_TASK.id, "and this one");
    expect(calls.at(-1)!.body.follow_up.turn_id).toBe(A0.id);
  });

  test("any running turn of the task holds a follow-up, on every line", async () => {
    const running = clone(BEST_OF_2);
    assistantTurn(running, 0).turn_status = "in_progress";
    const { fetchImpl, calls } = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(running), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }) });
    const a = adapter(VALID, fetchImpl);
    await expect(a.followUp(a.client() as CodexCloudApi, A1.id, "more")).rejects.toBeInstanceOf(CloudAgentBusyError);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("held while busy: known from the mirror's last read without asking Codex, and the hold says why", async () => {
    const { fetchImpl, calls } = wham({});
    const statuses: string[] = [];
    const s = new CloudAgentSessions(adapter(VALID, fetchImpl), {
      watcher: () => ({ follow: async () => {}, setNotice: () => {}, isRunning: (id) => id === BEST_TASK.id }),
      bindSession: () => {},
      agentForConversation: () => BEST_TASK.id,
      setStatus: (_c, st) => statuses.push(st),
      log: () => {},
    }, path.join(tmpDir("codex-sessions-"), "sessions.json"));
    const err = await s.deliver("conv-1", "next").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentBusyError);
    expect(err.holdReason).toBe("waiting for Codex Cloud to finish the running turn");
    expect(err.message).toStartWith("AGENT_STDIN_NOT_READY");
    expect(calls).toEqual([]);
    expect(statuses).toEqual([]);
  });

  test("a turn Codex runs that the mirror has not seen yet (sent from chatgpt.com): held, and the mirror follows the task so the next tries ask nobody", async () => {
    const running = clone(BEST_OF_2);
    assistantTurn(running, 0).turn_status = "in_progress";
    const { fetchImpl, calls } = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(running), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }) });
    const followed: string[] = [];
    const s = new CloudAgentSessions(adapter(VALID, fetchImpl), {
      watcher: () => ({ follow: async (id) => { followed.push(id); }, setNotice: () => {}, isRunning: (id) => followed.includes(id) }),
      bindSession: () => {}, agentForConversation: () => BEST_TASK.id, setStatus: () => {}, log: () => {},
    }, path.join(tmpDir("codex-sessions-"), "sessions.json"));
    await expect(s.deliver("conv-1", "next")).rejects.toBeInstanceOf(CloudAgentBusyError);
    expect(followed).toEqual([BEST_TASK.id]);
    const reads = calls.length;
    await expect(s.deliver("conv-1", "next")).rejects.toBeInstanceOf(CloudAgentBusyError);
    expect(calls.length).toBe(reads);
  });

  test("cancel from a branch cancels its own running turn, and never another line's", async () => {
    const running = clone(BEST_OF_2);
    assistantTurn(running, 1).turn_status = "pending";
    const { fetchImpl, calls } = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(running), [`POST /tasks/${BEST_TASK.id}/cancel`]: json({ success: true }) });
    const a = adapter(VALID, fetchImpl);
    // The task's own line (attempt 1) has nothing running: stopping its session leaves attempt 2 working.
    expect(await a.cancel(a.client() as CodexCloudApi, BEST_TASK.id)).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(await a.cancel(a.client() as CodexCloudApi, A1.id)).toBe("the running turn");
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: `/tasks/${BEST_TASK.id}/cancel` });
    // Attempts running side by side stop together (Codex cancels a whole task), and the result says so.
    assistantTurn(running, 0).turn_status = "in_progress";
    expect(await a.cancel(a.client() as CodexCloudApi, BEST_TASK.id)).toBe("the running turn, and the task's other attempts with it");
  });
});

describe("Codex Cloud session actions", () => {
  function withoutPr(turns: WhamTurns): WhamTurns {
    const out = clone(turns);
    for (const n of Object.values(out.turn_mapping!)) if (n.turn) { delete n.turn.pull_request_data; n.turn.pull_request_status = "not_created"; }
    return out;
  }

  test("Create PR: a draft from the branch's changes without Codex's tag, and its link once Codex opened it", async () => {
    const turns = withoutPr(BEST_OF_2);
    const answers = [{ turn: { ...A1, pull_request_data: null, pull_request_status: "creating" } }, { turn: { ...A1, pull_request_status: "created", pull_request_data: { url: "https://github.com/ashot/chatdoc/pull/99", number: 99, head: "codex/branch-2" } } }];
    const { fetchImpl, calls } = wham({
      [`GET /tasks/${BEST_TASK.id}/turns`]: json(turns),
      [`GET /tasks/${BEST_TASK.id}`]: json({ task: { ...BEST_TASK, pull_requests: [], external_pull_requests: [] } }),
      [`POST /tasks/${BEST_TASK.id}/turns/${A1.id}/pr`]: json({ success: true }),
      [`GET /tasks/${BEST_TASK.id}/turns/${A1.id}`]: () => new Response(JSON.stringify(answers.shift())),
    });
    const a = adapter(VALID, fetchImpl, { sleep: async () => {} });
    expect(await a.createPullRequest(a.client() as CodexCloudApi, A1.id)).toEqual({ url: "https://github.com/ashot/chatdoc/pull/99" });
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/tasks/${BEST_TASK.id}/turns/${A1.id}/pr`, body: { mode: "draft", add_codex_tag: false } });
    // One the task already has (on the turn, or only in the task's pull requests) is its link, with nothing sent.
    const open = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(BEST_OF_2), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }) });
    const b = adapter(VALID, open.fetchImpl);
    expect((await b.createPullRequest(b.client() as CodexCloudApi, BEST_TASK.id)).url).toBe("https://github.com/ashot/chatdoc/pull/18");
    expect(open.calls.some((c) => c.method === "POST")).toBe(false);
    // A later follow-up that changed code on a line that already has a pull request: that one, not a second.
    const later = clone(BEST_OF_2);
    later.current_turn_id = followUpOn(later, A0, "m1", { output_items: [{ type: "follow_up_diff", output_diff: { diff: "diff --git a/b b/b\n" } }] }).answer.id;
    const moved = wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(later), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }) });
    const d = adapter(VALID, moved.fetchImpl);
    expect((await d.createPullRequest(d.client() as CodexCloudApi, BEST_TASK.id)).url).toBe("https://github.com/ashot/chatdoc/pull/18");
    expect(moved.calls.some((c) => c.method === "POST")).toBe(false);
    // An ask task changed no code.
    const ask = wham({ [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK), [`GET /tasks/${ASK_TASK.id}`]: json({ task: ASK_TASK }) });
    const c = adapter(VALID, ask.fetchImpl);
    await expect(c.createPullRequest(c.client() as CodexCloudApi, ASK_TASK.id)).rejects.toThrow("changed no code");
  });

  test("Apply: the line's own recorded diff, whichever attempt it is and wherever the task moved on to", async () => {
    const plan = async (turns: WhamTurns, line: string) => {
      const a = adapter(VALID, wham({ [`GET /tasks/${BEST_TASK.id}/turns`]: json(turns) }).fetchImpl);
      return a.applyPlan(a.client() as CodexCloudApi, line);
    };
    const a1 = await plan(BEST_OF_2, A1.id);
    expect(a1).toMatchObject({ repo: "ashot/chatdoc", what: "attempt 2's changes" });
    expect(a1.diff).toStartWith("diff --git a/README.md b/README.md");
    // Attempt 1 changed nothing: attempt 2 is still attempt 2, with its own diff
    // (Codex's CLI would count it as attempt 1, since it skips attempts without one).
    const noDiff = clone(BEST_OF_2);
    assistantTurn(noDiff, 0).output_items = [];
    expect(await plan(noDiff, A1.id)).toEqual(a1);
    await expect(plan(noDiff, BEST_TASK.id)).rejects.toThrow("changed no code");
    // The task moved on from attempt 2 (a follow-up on attempt 1): attempt 2's line still applies its own changes.
    const onMain = clone(BEST_OF_2);
    onMain.current_turn_id = followUpOn(onMain, A0, "m1").answer.id;
    expect(await plan(onMain, A1.id)).toEqual(a1);
    expect((await plan(onMain, BEST_TASK.id)).diff).toBe((await plan(BEST_OF_2, BEST_TASK.id)).diff);
    // A follow-up that changed code carries its own diff and the line's whole one (the pr item, verified live):
    // Apply takes the whole one, or a checkout at the base branch gets only the last turn's part.
    const followed = clone(BEST_OF_2);
    const own = "diff --git a/b.txt b/b.txt\n";
    const whole = "diff --git a/README.md b/README.md\ndiff --git a/b.txt b/b.txt\n";
    followed.current_turn_id = followUpOn(followed, A0, "m2", { output_items: [{ type: "pr", output_diff: { diff: whole } }, { type: "follow_up_diff", output_diff: { diff: own } }] }).answer.id;
    expect((await plan(followed, BEST_TASK.id)).diff).toBe(whole);
  });

  test("applyInCheckout: refused without a checkout or with local changes to a file it touches; else git apply at the checkout's root", async () => {
    const repo = tmpDir("codex-apply-");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git("add", "README.md");
    git("commit", "-qm", "init");
    const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hi\n+codecast test p3\n";
    const plan = { repo: "ashot/chatdoc", diff, what: "the task's changes" };
    await expect(applyInCheckout(plan, null)).rejects.toThrow("has no checkout of ashot/chatdoc");
    fs.writeFileSync(path.join(repo, "README.md"), "local edit\n");
    await expect(applyInCheckout(plan, repo)).rejects.toThrow("has local changes to a file these changes touch (README.md)");
    git("checkout", "--", "README.md");
    // A session started in a folder inside the checkout applies at its root:
    // the diff's paths are the repository's, and so is the dirty check.
    const sub = path.join(repo, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(repo, "other.txt"), "untouched by the task\n");
    const root = fs.realpathSync(repo);
    expect(await applyInCheckout(plan, sub)).toEqual({ root, files: ["README.md"] });
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hi\ncodecast test p3\n");
    // Applied again, git's own words say why not.
    await expect(applyInCheckout(plan, repo)).rejects.toThrow("has local changes to a file these changes touch (README.md)");
    git("checkout", "--", "README.md");
    await expect(applyInCheckout({ ...plan, diff: diff.replace(" hi", " not there") }, repo)).rejects.toThrow("patch does not apply");
    await expect(applyInCheckout(plan, tmpDir("codex-not-git-"))).rejects.toThrow("is not a git checkout of ashot/chatdoc");
  }, 30_000);

  test("a task started from a second checkout (a worktree) stays there, its branches too, and Apply runs there", async () => {
    const commit = (dir: string) => execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const checkout = (prefix: string) => {
      const dir = fs.realpathSync(tmpDir(prefix));
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:ashot/chatdoc.git"]);
      fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
      execFileSync("git", ["-C", dir, "add", "README.md"]);
      commit(dir);
      return dir;
    };
    const worktree = checkout("codex-worktree-");
    const other = checkout("codex-other-repo-");
    execFileSync("git", ["-C", other, "remote", "set-url", "origin", "git@github.com:ashot/other.git"]);
    const turns = withoutPr(BEST_OF_2);
    // The fixture's diffs are cut short: attempt 2 gets one that applies.
    assistantTurn(turns, 1).output_items = [{ type: "pr", output_diff: { diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hi\n+attempt 2\n" } }];
    const { fetchImpl } = wham({ "GET /tasks/list": json({ items: [BEST_TASK] }), [`GET /tasks/${BEST_TASK.id}/turns`]: json(turns), [`GET /tasks/${BEST_TASK.id}`]: json({ task: BEST_TASK }) });
    const reg = new CloudAgentRegistry([adapter(VALID, fetchImpl)], {
      bindSession: () => {}, agentForConversation: (c) => ({ "conv-main": BEST_TASK.id, "conv-branch": A1.id } as Record<string, string>)[c], setStatus: () => {},
      addLine: async () => {}, enqueueMessage: async () => {}, hostSession: async () => "hosted", releaseSession: () => {},
      placeSession: async () => true, retitleSession: async () => true, markArchived: async () => true, log: () => {},
    }, () => path.join(tmpDir("codex-sessions-"), "sessions.json"));
    const runtime = reg.runtimes[0];
    await runtime.sessions.start("conv-main", worktree, "cloud");
    runtime.sessions.get("conv-main")!.agentId = BEST_TASK.id;
    const watcher = new CloudAgentWatcher(runtime.adapter, { rootDir: tmpDir("codex-mirror-"), now: () => NOW, resolveRepoDir: (repo, agentId) => reg.checkoutOf(runtime, agentId, repo) });
    reg.useWatcher(watcher);
    await watcher.poll();
    const cwdOf = async (id: string) => (await readMetaJson(path.dirname(watcher.transcriptPath(id))))?.cwd;
    // A branch is mirrored after its parent's pass.
    for (let i = 0; i < 100 && !await cwdOf(A1.id); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await cwdOf(BEST_TASK.id)).toBe(worktree);
    expect(await cwdOf(A1.id)).toBe(worktree);
    // A folder that is not a checkout of the task's repository is no placement for it.
    expect(await runtime.sessions.startedIn(BEST_TASK.id, { owner: "ashot", name: "other" })).toBeNull();
    const { message } = await reg.act("conv-branch", "apply");
    expect(message).toBe(`Applied attempt 2's changes to ${worktree} (1 file, not committed).`);
    expect(fs.readFileSync(path.join(worktree, "README.md"), "utf8")).toBe("hi\nattempt 2\n");
  }, 30_000);

  test("porcelainEntries: every path git status -z names, a rename's new path and not its old one", () => {
    expect(porcelainEntries(" M README.md\0R  new name.md\0old name.md\0?? x.txt\0").map((e) => e.path)).toEqual(["README.md", "new name.md", "x.txt"]);
    expect(porcelainEntries(" M README.md\0")).toEqual([{ status: " M", path: "README.md" }]);
    expect(porcelainEntries("")).toEqual([]);
  });

  test("the registry says each action's result in the thread, a refusal too", async () => {
    const { fetchImpl, calls } = wham({ [`POST /tasks/${ASK_TASK.id}/archive`]: json({ success: true }), [`POST /tasks/${ASK_TASK.id}/recover`]: json({ success: true }), [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK), [`GET /tasks/${ASK_TASK.id}`]: json({ task: ASK_TASK }) });
    const notes: string[] = [];
    const reg = new CloudAgentRegistry([adapter(VALID, fetchImpl)], {
      bindSession: () => {}, agentForConversation: (c) => (c === "conv-ask" ? ASK_TASK.id : undefined), setStatus: () => {},
      addLine: async (c, line) => { expect(line).toMatchObject({ role: "system", subtype: CLOUD_AGENT_ACTION_SUBTYPE }); notes.push(`${c}: ${line.content}`); },
      enqueueMessage: async () => {}, hostSession: async () => "hosted", releaseSession: () => {},
      placeSession: async () => true, retitleSession: async () => true, markArchived: async () => true, log: () => {},
    }, () => path.join(tmpDir("codex-sessions-"), "sessions.json"));
    expect((await reg.act("conv-ask", "archive")).message).toBe("Archived on Codex Cloud. It stays here; Unarchive brings it back there.");
    await reg.act("conv-ask", "unarchive");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/tasks/${ASK_TASK.id}/archive`, `/tasks/${ASK_TASK.id}/recover`]);
    await expect(reg.act("conv-ask", "create_pr")).rejects.toThrow("Create draft PR failed: this branch changed no code");
    expect(notes).toEqual([
      "conv-ask: Archived on Codex Cloud. It stays here; Unarchive brings it back there.",
      "conv-ask: Unarchived on Codex Cloud.",
      "conv-ask: Create draft PR failed: this branch changed no code (an ask task answers without changes)",
    ]);
    await expect(reg.act("conv-local", "archive")).rejects.toThrow("does not run on a cloud agent");
  });
});

