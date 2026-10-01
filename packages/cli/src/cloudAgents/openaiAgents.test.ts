import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLOUD_AGENT_PROVIDERS, cloudAgentCredentialError } from "@codecast/shared/contracts";
import { parseMirrorTranscriptFile } from "../parser.js";
import { CloudApiError } from "./http.js";
import { absorbSaved, applyAgentsEvent, buildAgentsTranscript, emptyAgentsLog, OpenAIAgentsAdapter, OpenAIAgentsApi, verifyOpenAIAgentsKey, type AgentsEvent, type AgentsSessionLog } from "./openaiAgents.js";
import { CloudAgentSessions, setupErrorOf, type CloudAgentSession } from "./sessions.js";
import { classifyMirrorTranscriptTail } from "./transcript.js";
import { CloudAgentBusyError } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";

// One real session (api.openai.com, 2026-10-01, gpt-5.6-terra): a turn that
// cloned octocat/Hello-World and read its README, then a follow-up whose
// `sleep 40` was cancelled mid-command. Recorded with stream: true on create,
// and the session's event stream opened before the follow-up was sent.
const FIX = path.join(import.meta.dir, "..", "__fixtures__", "openaiAgents");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
type Frame = { event: string; data: AgentsEvent };
const CREATE: Frame[] = read("create-stream.json");
const FOLLOWUP: Frame[] = read("followup-stream.json");
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

interface Call { method: string; path: string; body?: any; headers: Record<string, string> }

/** A fetch that serves canned responses by "METHOD path" and records every call in order. */
function fakeFetch(routes: Record<string, (call: Call) => Response>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers: init?.headers as Record<string, string>, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const hit = routes[`${call.method} ${url.pathname}`];
    return hit ? hit(call) : new Response(JSON.stringify({ error: { type: "not_found_error", code: "not_found_error", message: `No route ${call.method} ${url.pathname}` } }), { status: 404 });
  }) as typeof fetch;
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });
const stream = (frames: Frame[]) => () => new Response(sse(frames), { headers: { "content-type": "text/event-stream" } });
const accepted = () => new Response("", { status: 202 });

const BASE = `/v1/agents/sessions/${SID}`;
const SAVED_ROUTES = {
  [`GET ${BASE}/turns`]: json(TURNS),
  [`GET ${BASE}/items`]: json(ITEMS),
};

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) try { fn(); } catch {} });

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

describe("OpenAI Agents API adapter", () => {
  const adapter = (fetchImpl: typeof fetch, key: string | null = "sk-test") => new OpenAIAgentsAdapter({ readKey: () => key, fetchImpl });
  const api = (fetchImpl: typeof fetch) => new OpenAIAgentsApi("sk-test", fetchImpl);

  test("lists sessions with a version that moves as turns run (the session's last_active_at does not)", async () => {
    const page = await adapter(fakeFetch({})).listAgents(api(fakeFetch({ "GET /v1/agents/sessions": json(LIST) })));
    expect(page.items.map(({ agent: _a, ...rest }) => rest)).toEqual([{ id: SID, updatedAtMs: CREATED_MS, version: `idle|${SESSION.usage.total_tokens}|${SESSION.last_active_at}`, active: false }]);
    expect(page.nextCursor).toBeUndefined();
    const more = await adapter(fakeFetch({})).listAgents(api(fakeFetch({ "GET /v1/agents/sessions": json({ ...LIST, has_more: true }) })));
    expect(more.nextCursor).toBe(LIST.last_id);
  });

  test("the first message creates a streaming session that clones the repository on its branch", async () => {
    const calls: Call[] = [];
    const a = adapter(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE) }, calls));
    const session: CloudAgentSession = { model: "", repoUrl: "https://github.com/octocat/Hello-World", startingRef: "feature/x's" };
    expect(await a.create(api(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE) }, calls)), session, "hi")).toEqual({ agentId: SID });
    a.stop();
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
    expect(session.notice).toBe("Cloned octocat/Hello-World at `feature/x's` into an OpenAI-hosted sandbox, which can't push to GitHub.");

    const bare: CloudAgentSession = { model: "gpt-5.6-luna" };
    const plain = adapter(fakeFetch({}));
    await plain.create(api(fakeFetch({ "POST /v1/agents/sessions": stream(CREATE) }, calls)), bare, "hi");
    plain.stop();
    expect(calls.at(-1)?.body).toMatchObject({ agent: { model: "gpt-5.6-luna" }, environment: { type: "openai_hosted" } });
    expect(calls.at(-1)?.body.environment.setup_commands).toBeUndefined();
    expect(bare.notice).toContain("empty OpenAI-hosted sandbox");
  });

  test("delivery: a follow-up goes out while a turn runs (it steers it), listening before it is sent; 409 holds it", async () => {
    const calls: Call[] = [];
    let busy = false;
    const fetchImpl = fakeFetch({
      [`GET ${BASE}/events`]: stream(FOLLOWUP),
      [`POST ${BASE}/events`]: () => (busy ? new Response(JSON.stringify({ error: { type: "conflict_error", code: "conflict_error", message: "active turn is not steerable" } }), { status: 409 }) : accepted()),
    }, calls);
    const a = adapter(fetchImpl);
    cleanups.push(() => a.stop());
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

  test("a key is checked by whether OpenAI knows it; a refused key is said in OpenAI's words, never a network failure", async () => {
    expect(await verifyOpenAIAgentsKey("sk-good", fakeFetch({ "GET /v1/models": json({ data: [] }) }))).toEqual({ ok: true });
    // A restricted key without the models permission is still a key (other clients read it too).
    const restricted = { error: { type: "invalid_request_error", code: null, message: "You have insufficient permissions for this operation. Missing scopes: api.model.read." } };
    expect(await verifyOpenAIAgentsKey("sk-restricted", fakeFetch({ "GET /v1/models": json(restricted, 403) }))).toEqual({ ok: true });
    const refused = await verifyOpenAIAgentsKey("sk-bad", fakeFetch({ "GET /v1/models": json(ERRORS.invalid_key.body, 401) }));
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
