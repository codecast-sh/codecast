import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, cloudAgentCredentialError } from "@codecast/shared/contracts";
import { parseMirrorTranscriptFile } from "../parser.js";
import { cloudApiErrorOf, CloudApiError } from "./http.js";
import { buildCodexCloudTranscript, CodexCloudAdapter, CodexCloudApi, codexCitations, codexTaskTitle, isRunningTurnStatus, taskGit, taskRepo, taskTurnChain, type WhamTask, type WhamTurns } from "./codex.js";
import { checkCloudAgentLogin } from "./registry.js";
import { setupErrorOf, type CloudAgentSession } from "./sessions.js";
import { classifyMirrorTranscriptTail, readMetaJson } from "./transcript.js";
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

  test("best of 2: the task's current attempt, how many ran, and its pull request with the diff", () => {
    const tasks = LIST.items;
    const task = tasks.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!;
    const { messages } = read(BEST_OF_2, { taskId: task.id, pullRequests: task.pull_requests });
    const attempt0 = assistantTurn(BEST_OF_2, 0).id.split("~")[1];
    const attempt1 = assistantTurn(BEST_OF_2, 1).id.split("~")[1];
    expect(messages.some((m) => m.uuid!.includes(attempt0))).toBe(true);
    expect(messages.some((m) => m.uuid!.includes(attempt1))).toBe(false);
    // How many ran, with the one other attempt a click away on the task's page.
    const attempts = messages.find((m) => m.uuid!.endsWith(":attempts"))!.content;
    expect(attempts).toContain("ran 2 attempts");
    expect(attempts).toContain(`the other attempt is on [chatgpt.com](https://chatgpt.com/codex/tasks/${task.id})`);
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

  test("a pull request another attempt opened is named in the attempts note, never taken as the shown attempt's", () => {
    const task = clone(LIST.items.find((t) => t.id === "task_e_6abc46a0eecc832eaa9d4fd8533529f9")!);
    const other = assistantTurn(BEST_OF_2, 1);
    task.pull_requests = task.pull_requests!.map((p) => ({ ...p, assistant_turn_id: other.id }));
    const turns = clone(BEST_OF_2);
    delete assistantTurn(turns, 0).pull_request_data;
    const { messages } = read(turns, { pullRequests: task.pull_requests });
    const note = messages.find((m) => m.uuid!.endsWith(":attempts"))!.content;
    expect(note).toContain("This is attempt 1, the task's current one");
    expect(note).toContain("[Pull request #18](https://github.com/ashot/chatdoc/pull/18) came from attempt 2.");
    expect(messages.find((m) => m.uuid!.endsWith(":pr"))!.content).not.toContain("pull request #18");
    expect(taskGit(task.id, task, taskTurnChain(turns), "ashot/chatdoc")?.prUrl).toBeUndefined();
  });

  test("the chain follows the task's current attempt when the person picked another", () => {
    const turns = clone(BEST_OF_2);
    turns.current_turn_id = assistantTurn(turns, 1).id;
    expect(taskTurnChain(turns).map((t) => t.attempt_placement ?? null)).toEqual([null, 1]);
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
    expect(await a.cancel(api, id)).toBe(`task ${id}`);
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
    const none = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([]) });
    const b = adapter(VALID, none.fetchImpl);
    const err = await b.create(b.client() as CodexCloudApi, SESSION, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.message).toContain("https://chatgpt.com/codex/settings/environments");
  });

  test("a 403 names the admin permission, or the repository Codex cannot reach; a 401 is the sign-in card", () => {
    const a = adapter(VALID);
    const off = setupErrorOf(a, new CloudApiError(403, undefined, "Forbidden"), SESSION)!;
    expect(off.kind).toBe("access");
    expect(off.holdReason).toBeUndefined();
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
    // An ask task pushed no branch of its own.
    expect(git).toEqual([]);
    // Nothing moved: the next pass reads the list only.
    await watcher.poll();
    expect(events).toHaveLength(1);
    // A restart announces the transcript and the branch again: a settled task is not mirrored again,
    // and its first git report can land before its session exists.
    const again = new CloudAgentWatcher(adapter(VALID, fetchImpl), { rootDir, now: () => NOW });
    const replayed: unknown[] = [];
    again.on("git", (g) => replayed.push(g));
    again.on("session", (e) => replayed.push(e.eventType));
    again.start();
    again.stop();
    expect(replayed).toEqual(["add"]);
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
