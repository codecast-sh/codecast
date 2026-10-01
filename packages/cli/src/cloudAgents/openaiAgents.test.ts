import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCredentialError, cloudAgentOtherLanes, cloudAgentSetupCard, isCloudAgentRepoCard } from "@codecast/shared/contracts";
import { parseMirrorTranscriptFile } from "../parser.js";
import { CloudApiError } from "./http.js";
import { absorbSaved, applyAgentsEvent, buildAgentsTranscript, emptyAgentsLog, OpenAIAgentsAdapter, OpenAIAgentsApi, verifyOpenAIAgentsKey, type AgentsEvent, type AgentsItem, type AgentsSessionLog } from "./openaiAgents.js";
import { CloudAgentSessions, setupErrorOf, type CloudAgentSession } from "./sessions.js";
import { classifyMirrorTranscriptTail } from "./transcript.js";
import { CloudAgentBusyError, CloudAgentSetupError } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";
import { fakeCloudFetch, json, sseBody, type FakeCloudCall as Call } from "../test-helpers/cloudFetch.js";

// One real session (api.openai.com, 2026-10-01, gpt-5.6-terra): a turn that
// cloned octocat/Hello-World and read its README, then a follow-up whose
// `sleep 40` was cancelled mid-command. Recorded with stream: true on create,
// and the session's event stream opened before the follow-up was sent.
const FIX = path.join(import.meta.dir, "..", "__fixtures__", "openaiAgents");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
type Frame = { event: string; data: AgentsEvent };
const CREATE: Frame[] = read("create-stream.json");
const FOLLOWUP: Frame[] = read("followup-stream.json");
// A live turn whose command printed over 16 seconds (2026-10-01, gpt-5.4-mini).
const COMMAND_OUTPUT: Frame[] = read("command-output-stream.json");
const ITEMS = read("items.json");
const TURNS = read("turns.json");
const SESSION = read("session.json");
const LIST = read("list.json");
const ERRORS = read("errors.json");
const SID: string = SESSION.id;
const CREATED_MS = SESSION.created_at * 1000;
const PROMPT = "codecast test: run `cat Hello-World/README` and tell me its contents.";
const CUT_COMMAND = "exec_b27cbc4711d37c157fdb4306e71b20d07550c2b91e16992bd7";

const sse = (frames: Frame[]) => frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");

/** Fold frames into a record, one millisecond apart from the session's creation. */
function streamed(frames: Frame[], log: AgentsSessionLog = emptyAgentsLog(), from = CREATED_MS): AgentsSessionLog {
  frames.forEach((f, i) => applyAgentsEvent(log, f.data, from + i));
  return log;
}

function render(log: AgentsSessionLog) {
  const jsonl = buildAgentsTranscript({ log, createdAt: CREATED_MS });
  return { jsonl, msgs: parseMirrorTranscriptFile("codex", jsonl, SID) };
}

const fakeFetch = (routes: Record<string, (call: Call) => Response>, calls: Call[] = []) => fakeCloudFetch(routes, { calls });
const stream = (frames: Frame[]) => sseBody(sse(frames));
const accepted = () => new Response("", { status: 202 });
/** GitHub's answer to an anonymous clone of a public repository. */
const PUBLIC_REPO = { "GET /octocat/Hello-World.git/info/refs": json({}) };

const BASE = `/v1/agents/sessions/${SID}`;
/** A saved list (recorded oldest first) served in the order the call asks for. */
const listed = (page: { data: unknown[] }) => (call: Call) => new Response(JSON.stringify(new URLSearchParams(call.search).get("order") === "desc" ? { ...page, data: [...page.data].reverse() } : page));
const SAVED_ROUTES = {
  [`GET ${BASE}/turns`]: listed(TURNS),
  [`GET ${BASE}/items`]: listed(ITEMS),
};

const adapter = (fetchImpl: typeof fetch, key: string | null = "sk-test") => new OpenAIAgentsAdapter({ readKey: () => key, fetchImpl });
const api = (fetchImpl: typeof fetch) => new OpenAIAgentsApi("sk-test", fetchImpl);

// Undone newest first, each awaited: a watcher stops (and its mirrors land) before its folder goes.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) try { await fn(); } catch {} });

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("OpenAI Agents API transcript", () => {
  test("a streamed turn renders as prompt, commentary, the command with its output, and the answer", () => {
    const { jsonl, msgs } = render(streamed(CREATE));
    expect(msgs.map((m) => [m.role, m.content, m.subtype ?? null])).toEqual([
      ["user", PROMPT, null],
      ["assistant", "I’ll wait for the workspace, then read that file.", "commentary"],
      ["assistant", "", null],
      ["assistant", "Hello World!", "final_answer"],
    ]);
    const command = msgs[2];
    expect(command.toolCalls?.[0]).toMatchObject({ name: "commandExecution", input: { command: "/bin/bash -lc 'cat Hello-World/README'", cwd: "/workspace" } });
    expect(command.toolResults?.[0]?.content).toBe("Hello World!\n");
    expect(command.toolResults?.[0]?.isError).toBeFalsy();
    // Every record names the item it renders.
    expect(msgs.every((m) => m.uuid?.startsWith(`${SID}:`) && !/:\d+$/.test(m.uuid))).toBe(true);
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("idle");
  });

  test("text streams in as it arrives; a command still running shows without a result, and the turn stays open", () => {
    const upTo = (pred: (f: Frame) => boolean) => CREATE.slice(0, CREATE.findIndex(pred) + 1);
    // Halfway through the commentary's deltas.
    const deltas = CREATE.filter((f) => f.event === "agent.session.turn.output_text.delta");
    const partial = render(streamed(upTo((f) => f.data === deltas[3].data)));
    const said = partial.msgs.at(-1)!.content;
    expect("I’ll wait for the workspace, then read that file.".startsWith(said) && said.length > 0 && said.length < 40).toBe(true);
    expect(classifyMirrorTranscriptTail(partial.jsonl)).toBe("active");
    const running = render(streamed(upTo((f) => f.event === "agent.session.turn.item.added" && f.data.item?.type === "command_execution")));
    expect(running.msgs.at(-1)?.toolCalls?.[0]?.name).toBe("commandExecution");
    expect(running.msgs.at(-1)?.toolResults).toBeUndefined();
  });

  test("the saved turns and items merge over the stream: same rows at the same times, and a command only the stream saw stays", () => {
    const live = streamed([...CREATE, ...FOLLOWUP]);
    const before = render(live).msgs;
    absorbSaved(live, TURNS.data, ITEMS.data);
    const after = render(live).msgs;
    // Re-rendered from the record: nothing moves, nothing doubles.
    for (const m of before) expect(after.find((a) => a.uuid === m.uuid)?.timestamp).toBe(m.timestamp);
    expect(new Set(after.map((m) => m.uuid)).size).toBe(after.length);
    // The API saves no item for the command the cancel cut off; the stream showed it.
    expect(ITEMS.data.some((i: { id: string }) => i.id === CUT_COMMAND)).toBe(false);
    expect(after.some((m) => m.uuid === `${SID}:${CUT_COMMAND}`)).toBe(true);
    expect(after.at(-1)).toMatchObject({ role: "assistant", content: "ℹ Cancelled." });

    // Read from the API alone (an imported session): every saved item, in turn order, dated from its turn.
    const saved = emptyAgentsLog();
    saved.session = SESSION;
    absorbSaved(saved, TURNS.data, ITEMS.data);
    const { msgs, jsonl } = render(saved);
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual([PROMPT, "codecast test: run `sleep 40; echo done` and report the output."]);
    expect(msgs[0].timestamp).toBe(TURNS.data[0].created_at * 1000);
    expect(msgs.map((m) => m.timestamp)).toEqual([...msgs.map((m) => m.timestamp)].sort((a, b) => a - b));
    expect(classifyMirrorTranscriptTail(jsonl)).toBe("idle");
  });

  test("a sandbox that could not be set up says why, and that the clone reaches public repositories only", () => {
    const log = emptyAgentsLog();
    log.session = { ...SESSION, status: "failed", error: "Session failed", metadata: { repo: "ashot/private" } };
    applyAgentsEvent(log, { type: "agent.session.environment.failed", environment: { status: "failed", error: { message: "setup command exited with status 128" } } }, CREATED_MS);
    const last = render(log).msgs.at(-1)!;
    expect(last.content).toContain("OpenAI Agents API session failed: Session failed.");
    expect(last.content).toContain("setup command exited with status 128");
    expect(last.content).toContain("clones ashot/private from GitHub without credentials, so it reaches public repositories only");
  });
});

describe("OpenAI Agents API record merge", () => {
  const T = "turn_gap";
  const START = 1_790_000_000;
  const turn = (status: string) => ({ id: T, status, created_at: START, ...(status === "completed" ? { completed_at: START + 60 } : {}) });
  const msg = (id: string, role: "user" | "assistant", text: string, extra: Partial<AgentsItem> = {}): AgentsItem => ({ type: "message", id, turn_id: T, role, status: "completed", content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...extra });
  const exec: AgentsItem = { type: "command_execution", id: "exec_1", turn_id: T, command: "ls", status: "completed", output: "a\n", exit_code: 0 };
  const fresh = () => { const log = emptyAgentsLog(); log.session = { ...SESSION, created_at: START }; return log; };

  test("an item a reopened stream missed lands where the saved list has it, dated between its neighbours, never after the answer", () => {
    // A restart while the turn runs: the saved read, then a stream that opens after the command finished.
    const log = fresh();
    absorbSaved(log, [turn("in_progress")], [msg("msg_u", "user", "go"), msg("msg_a1", "assistant", "looking", { phase: "commentary" })]);
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_fin", "assistant", "done", { phase: "final_answer" }) }, START * 1000 + 500);
    applyAgentsEvent(log, { type: "agent.session.turn.completed", turn: turn("completed") }, START * 1000 + 501);
    // The turn's end: the saved record has the command the stream never showed.
    absorbSaved(log, [turn("completed")], [msg("msg_u", "user", "go"), msg("msg_a1", "assistant", "looking", { phase: "commentary" }), exec, msg("msg_fin", "assistant", "done", { phase: "final_answer" })]);
    expect(log.items.map((i) => i.id)).toEqual(["msg_u", "msg_a1", "exec_1", "msg_fin"]);
    expect(log.at.exec_1).toBeGreaterThan(log.at.msg_a1);
    expect(log.at.exec_1).toBeLessThan(log.at.msg_fin);
    const msgs = render(log).msgs;
    expect(msgs.map((m) => m.uuid?.split(":")[1])).toEqual(["msg_u", "msg_a1", "exec_1", "msg_fin"]);
    expect(msgs.map((m) => m.timestamp)).toEqual([...msgs.map((m) => m.timestamp)].sort((a, b) => a - b));
  });

  test("rows keep the order they were first shown in: a command run in the background stays ahead of what was said while it ran", () => {
    // Seen live (2026-10-01): the stream shows the command, then the commentary; the saved list, ordered by completion, has them the other way.
    const log = fresh();
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_u", "user", "go") }, START * 1000 + 1);
    applyAgentsEvent(log, { type: "agent.session.turn.item.added", item: { ...exec, status: "in_progress", output: null } }, START * 1000 + 100);
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_c", "assistant", "started; polling", { phase: "commentary" }) }, START * 1000 + 120);
    absorbSaved(log, [turn("completed")], [msg("msg_u", "user", "go"), msg("msg_c", "assistant", "started; polling", { phase: "commentary" }), exec]);
    expect(log.items.map((i) => i.id)).toEqual(["msg_u", "exec_1", "msg_c"]);
    expect(log.items.find((i) => i.id === "exec_1")?.status).toBe("completed");
    const msgs = render(log).msgs;
    expect(msgs.map((m) => m.timestamp)).toEqual([...msgs.map((m) => m.timestamp)].sort((a, b) => a - b));
  });

  test("a saved read never moves the record backwards, and a turn a live stream follows takes its items from the stream", () => {
    const log = fresh();
    applyAgentsEvent(log, { type: "agent.session.turn.completed", turn: turn("completed") }, START * 1000 + 900);
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_a", "assistant", "the whole answer") }, START * 1000 + 800);
    // Read before the stream got there: the turn still running, the answer half written.
    absorbSaved(log, [turn("in_progress")], [msg("msg_a", "assistant", "the who", { status: "in_progress" })]);
    expect(log.turns[T].status).toBe("completed");
    expect(log.items.find((i) => i.id === "msg_a")?.content?.[0].text).toBe("the whole answer");

    // A follow-up's stream opened before its turn began: the saved copies of that turn wait, and the stream dates its items as they come.
    const live = fresh();
    absorbSaved(live, [turn("in_progress")], [msg("msg_u", "user", "go"), msg("msg_c", "assistant", "on it")], new Set([T]));
    expect(live.items).toEqual([]);
    applyAgentsEvent(live, { type: "agent.session.turn.item.done", item: msg("msg_u", "user", "go") }, START * 1000 + 10);
    applyAgentsEvent(live, { type: "agent.session.turn.item.done", item: msg("msg_c", "assistant", "on it") }, START * 1000 + 40_000);
    expect(live.at.msg_c).toBe(START * 1000 + 40_000);
  });

  test("how a turn ended is never dated before its last row (OpenAI dates the end in whole seconds)", () => {
    const log = fresh();
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_u", "user", "go") }, START * 1000 + 1);
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_a", "assistant", "half an answer") }, START * 1000 + 5_400);
    applyAgentsEvent(log, { type: "agent.session.turn.cancelled", turn: { id: T, status: "cancelled", created_at: START, completed_at: START + 5 } }, START * 1000 + 5_450);
    const msgs = parseMirrorTranscriptFile("codex", buildAgentsTranscript({ log, createdAt: START * 1000 }), SID);
    expect(msgs.map((m) => m.content)).toEqual(["go", "half an answer", "ℹ Cancelled."]);
    expect(msgs[2].timestamp).toBe(START * 1000 + 5_400);
  });

  test("a turn that starts over an hour after the last one ended says its sandbox may be a fresh one", () => {
    const log = fresh();
    const second = "turn_late";
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: msg("msg_u", "user", "make note.txt") }, START * 1000 + 1);
    applyAgentsEvent(log, { type: "agent.session.turn.completed", turn: { ...turn("completed"), completed_at: START + 10 } }, START * 1000 + 10_000);
    const late = START + 10 + 3_720;
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: { ...msg("msg_u2", "user", "cat note.txt"), turn_id: second } }, late * 1000 + 5);
    applyAgentsEvent(log, { type: "agent.session.turn.completed", turn: { id: second, status: "completed", created_at: late, completed_at: late + 5 } }, late * 1000 + 5_000);
    const msgs = parseMirrorTranscriptFile("codex", buildAgentsTranscript({ log, createdAt: START * 1000 }), SID);
    expect(msgs.map((m) => m.content)).toEqual(["make note.txt", expect.stringContaining("files from earlier turns may be gone"), "cat note.txt"]);
    expect(msgs[1].content).toContain("1h+ after the last one ended");
    // Within the hour: nothing said.
    const soon = fresh();
    applyAgentsEvent(soon, { type: "agent.session.turn.completed", turn: { ...turn("completed"), completed_at: START + 10 } }, START * 1000);
    applyAgentsEvent(soon, { type: "agent.session.turn.completed", turn: { id: second, status: "completed", created_at: START + 600, completed_at: START + 605 } }, START * 1000);
    expect(buildAgentsTranscript({ log: soon, createdAt: START * 1000 })).not.toContain("may be gone");
  });

  test("a command's streamed output stays when a cancel cuts it off, and one that showed none says so", () => {
    const deltas = COMMAND_OUTPUT.filter((f) => f.event === "agent.output.command_execution_output.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(typeof deltas[0].data.delta).toBe("string");
    const upTo = COMMAND_OUTPUT.slice(0, COMMAND_OUTPUT.indexOf(deltas.at(-1)!) + 1);
    const log = streamed(upTo);
    const id = deltas[0].data.item_id!;
    const cut = { ...log.items.find((i) => i.id === id)!, status: "incomplete", output: null };
    applyAgentsEvent(log, { type: "agent.session.turn.item.done", item: cut }, CREATED_MS + 999);
    const result = render(log).msgs.find((m) => m.uuid === `${SID}:${id}`)?.toolResults?.[0]?.content;
    expect(result).toContain("line4");

    const silent = streamed(COMMAND_OUTPUT.slice(0, COMMAND_OUTPUT.findIndex((f) => f.event === "agent.session.turn.item.added" && f.data.item?.type === "command_execution") + 1));
    applyAgentsEvent(silent, { type: "agent.session.turn.item.done", item: { ...silent.items.at(-1)!, status: "incomplete", output: null } }, CREATED_MS + 999);
    expect(render(silent).msgs.at(-1)?.toolResults?.[0]?.content).toContain("stopped before it finished");

    // The whole recorded turn: the saved output is the command's own.
    const whole = render(streamed(COMMAND_OUTPUT)).msgs.find((m) => m.uuid === `${SID}:${id}`);
    expect(whole?.toolResults?.[0]?.content).toBe("line1\r\nline2\r\nline3\r\nline4\r\n");
  });

  test("a session's lists are read newest first, only back to what the record has settled", async () => {
    const calls: Call[] = [];
    const pages: Record<string, { data: AgentsItem[]; has_more: boolean; last_id: string }> = {
      "": { data: [msg("m4", "assistant", "4"), msg("m3", "assistant", "3")], has_more: true, last_id: "m3" },
      m3: { data: [msg("m2", "assistant", "2"), msg("m1", "assistant", "1")], has_more: false, last_id: "m1" },
    };
    const a = api(fakeFetch({ [`GET ${BASE}/items`]: (c) => new Response(JSON.stringify(pages[new URLSearchParams(c.search).get("after") ?? ""])) }, calls));
    expect((await a.items(SID)).map((i) => i.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(new URLSearchParams(calls[0].search).get("order")).toBe("desc");
    calls.length = 0;
    expect((await a.items(SID, (i) => i.id === "m3")).map((i) => i.id)).toEqual(["m3", "m4"]);
    expect(calls.length).toBe(1);
  });
});

describe("OpenAI Agents API adapter", () => {

  test("lists sessions with a version that moves as turns run (the session's last_active_at does not)", async () => {
    const page = await adapter(fakeFetch({})).listAgents(api(fakeFetch({ "GET /v1/agents/sessions": json(LIST) })));
    expect(page.items.map(({ agent: _a, ...rest }) => rest)).toEqual([{ id: SID, updatedAtMs: CREATED_MS, version: `idle|${SESSION.usage.total_tokens}|${SESSION.last_active_at}`, active: false }]);
    expect(page.nextCursor).toBeUndefined();
    const more = await adapter(fakeFetch({})).listAgents(api(fakeFetch({ "GET /v1/agents/sessions": json({ ...LIST, has_more: true }) })));
    expect(more.nextCursor).toBe(LIST.last_id);
  });

  test("the first message creates a streaming session that clones the repository on its branch", async () => {
    const calls: Call[] = [];
    const a = adapter(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE), ...PUBLIC_REPO }, calls));
    const session: CloudAgentSession = { model: "", repoUrl: "https://github.com/octocat/Hello-World", startingRef: "feature/x's" };
    // Said as what the setup does: the clone has not happened yet.
    expect(await a.create(api(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE) }, calls)), session, "hi")).toEqual({
      agentId: SID,
      notice: "Clones octocat/Hello-World at `feature/x's` into an OpenAI-hosted sandbox, which can't push to GitHub.",
    });
    a.streams.stop();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers).toMatchObject({ "OpenAI-Beta": "agents=v1", Accept: "text/event-stream" });
    expect(post.body).toMatchObject({
      agent: { model: CLOUD_AGENT_PROVIDERS.codex_api.defaultModel },
      environment: { type: "openai_hosted", setup_commands: [{ command: "git clone --depth 50 --branch 'feature/x'\\''s' https://github.com/octocat/Hello-World.git 'Hello-World'", cwd: "/workspace" }] },
      input: "hi",
      metadata: { source: "codecast", repo: "octocat/Hello-World" },
      stream: true,
    });
    expect(post.body.agent.instructions).toContain("/workspace/Hello-World");

    const bare: CloudAgentSession = { model: "gpt-5.6-luna" };
    const plain = adapter(fakeFetch({}));
    const created = await plain.create(api(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE) }, calls)), bare, "hi");
    plain.streams.stop();
    expect(calls.at(-1)?.body).toMatchObject({ agent: { model: "gpt-5.6-luna" }, environment: { type: "openai_hosted" } });
    expect(calls.at(-1)?.body.environment.setup_commands).toBeUndefined();
    expect(created.notice).toContain("empty OpenAI-hosted sandbox");
    expect(bare.notice).toBeUndefined();
  });

  test("a private repository is refused before a session is created, with the repository card the web gives this lane", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ "GET /ashot/private.git/info/refs": () => new Response("", { status: 401 }), "POST /v1/agents/sessions": stream(CREATE) }, calls);
    const err = await adapter(fetchImpl).create(api(fetchImpl), { model: "", repoUrl: "https://github.com/ashot/private" }, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.kind).toBe("repo");
    expect(err.message).toContain("ashot/private");
    expect(cloudAgentSetupCard("codex", err.message)?.id).toBe("codex_api");
    // The card the web offers the other lane on: Codex Cloud reaches private repositories.
    expect(isCloudAgentRepoCard(CLOUD_AGENT_PROVIDERS.codex_api, err.message)).toBe(true);
    expect(cloudAgentOtherLanes(CLOUD_AGENT_PROVIDERS.codex_api).map((l) => l.id)).toEqual(["codex"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("creating says OpenAI's reason when the stream answers with an error instead of a session", async () => {
    const fetchImpl = fakeFetch({ "POST /v1/agents/sessions": stream([{ event: "error", data: { type: "error", error: { message: "You exceeded your current quota." } } }]) });
    await expect(adapter(fetchImpl).create(api(fetchImpl), { model: "" }, "hi")).rejects.toThrow("You exceeded your current quota.");
  });

  test("delivery: a follow-up goes out while a turn runs (it steers it), listening before it is sent; 409 holds it", async () => {
    const calls: Call[] = [];
    let busy = false;
    const fetchImpl = fakeFetch({
      [`GET ${BASE}/events`]: stream(FOLLOWUP),
      [`POST ${BASE}/events`]: () => (busy ? new Response(JSON.stringify({ error: { type: "conflict_error", code: "conflict_error", message: "active turn is not steerable" } }), { status: 409 }) : accepted()),
    }, calls);
    const a = adapter(fetchImpl);
    cleanups.push(() => a.streams.stop());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-agents-sessions-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ conv1: { agentId: SID, model: "" } }));
    const statuses: string[] = [];
    const sessions = new CloudAgentSessions(a, {
      // The mirror last saw the turn running: a provider that does not steer would hold the message here.
      watcher: () => ({ follow: async () => {}, setNotice() {}, isRunning: () => true }),
      bindSession() {},
      agentForConversation: () => undefined,
      setStatus: (_c, s) => statuses.push(s),
      log() {},
    }, path.join(dir, "sessions.json"));
    expect(await sessions.deliver("conv1", "and also this")).toBe(true);
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([`GET ${BASE}/events`, `POST ${BASE}/events`]);
    expect(calls[1].body).toEqual({ events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "and also this" }] }] }] });
    expect(statuses).toEqual(["working"]);
    busy = true;
    await expect(sessions.deliver("conv1", "one more")).rejects.toBeInstanceOf(CloudAgentBusyError);
  });

  test("cancel stops only a running turn", async () => {
    const calls: Call[] = [];
    let status = "in_progress";
    const fetchImpl = fakeFetch({ [`GET ${BASE}`]: () => new Response(JSON.stringify({ ...SESSION, status })), [`POST ${BASE}/events`]: accepted }, calls);
    const a = adapter(fetchImpl);
    expect(await a.cancel(api(fetchImpl), SID)).toBe("the running turn");
    expect(calls.at(-1)?.body).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
    status = "idle";
    expect(await a.cancel(api(fetchImpl), SID)).toBeNull();
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  test("a key is checked against the Agents API; one kept from it is stored with what it lacks, a refused one is said in OpenAI's words", async () => {
    const calls: Call[] = [];
    expect(await verifyOpenAIAgentsKey("sk-good", fakeFetch({ "GET /v1/agents/sessions": json({ data: [] }) }, calls))).toEqual({ ok: true });
    expect(calls[0].headers).toMatchObject({ "OpenAI-Beta": "agents=v1" });
    // A key restricted away from the Agents API is still a key (opencode and pi read it too): kept, and the dialog says what it needs.
    // OpenAI answers a restricted key's missing scope with 401 and no code, as it does a 403.
    const restricted = { error: { type: "invalid_request_error", code: null, message: "You have insufficient permissions for this operation. Missing scopes: api.agents.read." } };
    for (const status of [401, 403]) {
      const kept = await verifyOpenAIAgentsKey("sk-restricted", fakeFetch({ "GET /v1/agents/sessions": json(restricted, status) }));
      expect(kept.ok).toBe(true);
      const detail = kept.ok ? kept.detail ?? "" : "";
      expect(detail).toContain("Missing scopes: api.agents.read");
      expect(detail).toContain("Agents permission");
    }
    // A project without the beta: kept too, saying why this lane can't use it (no permission to give).
    for (const [status, body] of [[404, { error: { type: "invalid_request_error", code: "unknown_url", message: "Invalid URL (GET /v1/agents/sessions)" } }], [400, { error: { type: "invalid_request_error", code: "invalid_beta", message: "Agents API is not available for this project." } }]] as const) {
      const kept = await verifyOpenAIAgentsKey("sk-nobeta", fakeFetch({ "GET /v1/agents/sessions": json(body, status) }));
      expect(kept).toEqual({ ok: true, detail: `It can't run OpenAI Agents API sessions yet (${body.error.message.replace(/\.$/, "")}).` });
    }
    const refused = await verifyOpenAIAgentsKey("sk-bad", fakeFetch({ "GET /v1/agents/sessions": json(ERRORS.invalid_key.body, 401) }));
    expect(refused).toEqual({ ok: false, error: `OpenAI rejected this key: ${ERRORS.invalid_key.body.error.message}` });
    const offline = await verifyOpenAIAgentsKey("sk-x", (async () => { throw new Error("getaddrinfo ENOTFOUND api.openai.com"); }) as unknown as typeof fetch);
    expect(offline).toEqual({ ok: false, error: "Couldn't reach OpenAI to check the key: getaddrinfo ENOTFOUND api.openai.com" });
  });

  test("a refused key is the credential card the web connects; no key is the missing one", async () => {
    const a = adapter(fakeFetch({}), null);
    const missing = a.client();
    expect(missing).toMatchObject({ kind: "key_missing" });
    expect(cloudAgentCredentialError("codex", (missing as Error).message)?.id).toBe("codex_api");
    const err = await api(fakeFetch({ "GET /v1/agents/sessions": json(ERRORS.invalid_key.body, 401) })).listSessions(1).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    const card = setupErrorOf(a, err)!;
    expect(card.kind).toBe("key_invalid");
    expect(cloudAgentCredentialError("codex", card.message)?.id).toBe("codex_api");
    // Not found is not a setup problem.
    expect(setupErrorOf(a, await api(fakeFetch({})).session("sess_doesnotexist").catch((e) => e))).toBeNull();
  });
});

describe("OpenAI Agents API mirror", () => {
  function mirrorDir(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
  }

  test("imports a listed session into a codex transcript placed in the repository's checkout, and leaves a settled one alone", async () => {
    const root = mirrorDir("openai-agents-");
    const calls: Call[] = [];
    const watcher = new CloudAgentWatcher(new OpenAIAgentsAdapter({ readKey: () => "sk-test", fetchImpl: fakeFetch({ "GET /v1/agents/sessions": json(LIST), ...SAVED_ROUTES }, calls) }), {
      rootDir: root,
      resolveRepoDir: async (repo) => (repo.name === "Hello-World" ? "/Users/me/src/Hello-World" : null),
      now: () => CREATED_MS + 60_000,
    });
    cleanups.push(() => watcher.stop());
    const seen: string[] = [];
    watcher.on("session", (e) => seen.push(e.sessionId));
    await watcher.poll();
    expect(seen).toEqual([SID]);
    const msgs = parseMirrorTranscriptFile("codex", fs.readFileSync(watcher.transcriptPath(SID), "utf8"), SID);
    expect(msgs[0]).toMatchObject({ role: "user", content: PROMPT });
    expect(msgs.some((m) => m.content === "Hello World!" && m.subtype === "final_answer")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, SID, "meta.json"), "utf8"))).toMatchObject({ cwd: "/Users/me/src/Hello-World", cloud: true });
    const reads = calls.length;
    await watcher.poll();
    expect(seen.length).toBe(1);
    expect(calls.length).toBe(reads + 1);
  });

  test("a running session is followed live: its stream renders as it comes, and when the turn ends the saved record is read again", async () => {
    const root = mirrorDir("openai-agents-live-");
    const calls: Call[] = [];
    let status = "in_progress";
    const fetchImpl = fakeFetch({
      "GET /v1/agents/sessions": () => new Response(JSON.stringify({ ...LIST, data: [{ ...LIST.data[0], status }] })),
      [`GET ${BASE}`]: () => new Response(JSON.stringify({ ...SESSION, status })),
      [`GET ${BASE}/events`]: () => { status = "idle"; return stream(FOLLOWUP)(); },
      ...SAVED_ROUTES,
    }, calls);
    const watcher = new CloudAgentWatcher(new OpenAIAgentsAdapter({ readKey: () => "sk-test", fetchImpl }), { rootDir: root, now: () => CREATED_MS + 60_000 });
    cleanups.push(() => watcher.stop());
    await watcher.poll();
    const file = watcher.transcriptPath(SID);
    await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(CUT_COMMAND) && fs.readFileSync(file, "utf8").includes("Cancelled."));
    const msgs = parseMirrorTranscriptFile("codex", fs.readFileSync(file, "utf8"), SID);
    expect(msgs.find((m) => m.uuid === `${SID}:${CUT_COMMAND}`)?.toolCalls?.[0]?.input).toMatchObject({ command: "/bin/bash -lc 'sleep 40; echo done'" });
    await until(() => calls.filter((c) => c.path === `${BASE}/items`).length >= 2);
    expect(classifyMirrorTranscriptTail(fs.readFileSync(file, "utf8"))).toBe("idle");
    const record = JSON.parse(fs.readFileSync(path.join(root, SID, "events.json"), "utf8"));
    expect(record.items.some((i: { id: string }) => i.id === CUT_COMMAND)).toBe(true);
  });
});
