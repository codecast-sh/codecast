/**
 * Codex Cloud's private API, held to the payloads codecast reads.
 *
 * Contract: every recorded payload (packages/cli/src/__fixtures__/codexCloud,
 * real answers from chatgpt.com/backend-api/wham, scrubbed) passes the shape
 * check its read makes, and every field the adapter depends on breaks the
 * read, by name, when it goes missing or changes type. Error bodies: the
 * recorded 400, 401 and 404, and a 403 and 429 in the API's {detail} shape
 * (no account here could record those two).
 *
 * Hardening: a shape break or a run of unexpected answers pauses the lane on
 * the machine (one warn log naming the path, the heartbeat's block, the card
 * on a held message) and a later check that passes resumes it; a workspace
 * without Codex Cloud is one card naming the admin permission and no polling
 * noise; a 429 backs off and names the plan window that is used up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, CLOUD_AGENT_PROVIDERS, CLOUD_AGENT_RETRIED_SUFFIX, classifyApiErrorBanner, cloudAgentCardKind, cloudAgentProblemKind } from "@codecast/shared/contracts";
import { json, type FakeCloudCall } from "../test-helpers/cloudFetch.js";
import { clone, CODEX_NOW, codexAuthJson, codexFixture, whamFetch } from "../test-helpers/codexCloudFixtures.js";
import { CodexCloudAdapter, CodexCloudApi, pickEnvironment, type WhamTask, type WhamTurns } from "./codex.js";
import { CloudAgentRegistry, type CloudAgentThreadLine } from "./registry.js";
import { CloudAgentSessions, cloudSetupErrorOf } from "./sessions.js";
import { CloudShapeError } from "./shape.js";
import { cloudApiErrorOf } from "./http.js";
import { CloudAgentSetupError, CloudAgentUnsentError } from "./types.js";
import { CloudAgentWatcher } from "./watcher.js";

const CODEX = CLOUD_AGENT_PROVIDERS.codex;
const fixture = codexFixture;
const LIST = fixture<{ items: WhamTask[]; cursor: string }>("list.json");
const ASK = fixture<WhamTurns>("turns.ask.json");
const ASK_TASK = LIST.items.find((t) => t.id === "task_e_6abc48f2d3b0832e9e4bb4b303d1bc45")!;
const USAGE = fixture("usage.json");

const NOW = CODEX_NOW;
// Valid for a week: the hardening tests run the clock on for hours.
const VALID = codexAuthJson(CODEX_NOW / 1000 + 7 * 86400);
const wham = whamFetch;
const status = (body: unknown, code: number, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status: code, headers });

let clock = NOW;
function adapter(fetchImpl: typeof fetch) {
  return new CodexCloudAdapter({ readAuth: () => VALID, fetchImpl, now: () => clock });
}
const api = (fetchImpl: typeof fetch) => new CodexCloudApi({}, fetchImpl);

const cleanups: (() => void)[] = [];
afterEach(() => { clock = NOW; for (const fn of cleanups.splice(0)) try { fn(); } catch {} });
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** What a read throws (or null when it answered). */
async function thrown(p: Promise<unknown>): Promise<any> {
  try { await p; return null; } catch (err) { return err; }
}

describe("contract: every recorded payload passes the shape its read checks", () => {
  test("list, task, turns (app-server events and legacy worklogs), one turn, create, follow-up, environments", async () => {
    const task = fixture("task.bestOf2.json");
    const turnsFiles = ["turns.ask.json", "turns.askFollowUp.json", "turns.bestOf2.json", "turns.legacy.json"];
    const created = fixture("create.response.json");
    const { fetchImpl } = wham({
      "GET /tasks/list": json(LIST),
      [`GET /tasks/${task.task.id}`]: json(task),
      "POST /tasks": json(created),
      "GET /environments": json(fixture("environments.json")),
      [`GET /tasks/x/turns/${task.current_assistant_turn?.id ?? "t"}`]: json({ turn: task.current_assistant_turn }),
    });
    const a = api(fetchImpl);
    expect((await a.listTasks()).items).toHaveLength(LIST.items.length);
    expect((await a.task(task.task.id)).task.id).toBe(task.task.id);
    for (const name of turnsFiles) {
      const turns = fixture(name);
      const one = wham({ "GET /tasks/task_e_t/turns": json(turns) });
      const read = await api(one.fetchImpl).turns("task_e_t");
      expect(Object.keys(read.turn_mapping).length).toBeGreaterThan(1);
    }
    expect((await a.createTask({})).task.id).toBe(created.task.id);
    expect(await a.followUp({})).toBeDefined();
    if (task.current_assistant_turn) expect((await a.turn("x", task.current_assistant_turn.id)).turn.id).toBe(task.current_assistant_turn.id);
    const envs = await a.environments();
    expect(envs.length).toBe(fixture<unknown[]>("environments.json").length);
    // What is kept of an environment: never its env vars or secrets.
    expect(Object.keys(envs[0]).sort()).toEqual(expect.arrayContaining(["id", "repos"]));
    expect(JSON.stringify(envs)).not.toMatch(/env_vars|secrets/);
  });

  test("the usage reading: plan, windows and reset come through the meters' own parser", async () => {
    const { fetchImpl } = wham({ "GET /usage": json(USAGE) });
    const read = await api(fetchImpl).usage(NOW);
    expect(read.email).toBe("person@example.com");
    expect(read.reading?.plan_type).toBe("pro");
    expect(read.reading?.weekly).toMatchObject({ percent: 0, resets_at: USAGE.rate_limit.primary_window.reset_at * 1000 });
  });
});

describe("contract: every field the adapter reads breaks its read, by name, when it changes", () => {
  type Case = [label: string, route: string, body: () => unknown, read: (a: CodexCloudApi) => Promise<unknown>, path: string];
  const list = () => clone(LIST) as any;
  const turns = () => clone(ASK) as any;
  const firstTurn = (t: any) => Object.values<any>(t.turn_mapping)[0].turn;
  const assistant = (t: any) => Object.values<any>(t.turn_mapping).map((n) => n.turn).find((x) => x.type === "assistant");
  const cases: Case[] = [
    ["the list's items", "GET /tasks/list", () => ({ tasks: LIST.items }), (a) => a.listTasks(), "GET /tasks/list: items should be an array, got nothing"],
    ["a task's id", "GET /tasks/list", () => { const l = list(); l.items[0].id = 7; return l; }, (a) => a.listTasks(), "items[].id should be a string, got a number"],
    ["when a listed task changed", "GET /tasks/list", () => { const l = list(); delete l.items[0].updated_at; return l; }, (a) => a.listTasks(), "items[].updated_at should be a number, got nothing"],
    ["a listed task's status", "GET /tasks/list", () => { const l = list(); l.items[0].task_status_display.latest_turn_status_display.turn_status = 3; return l; }, (a) => a.listTasks(), "items[].task_status_display.latest_turn_status_display.turn_status should be a string, got a number"],
    ["a task's pull requests", "GET /tasks/list", () => { const l = list(); l.items[0].pull_requests = { url: "x" }; return l; }, (a) => a.listTasks(), "items[].pull_requests should be an array, got an object"],
    ["the task by id", "GET /tasks/task_e_t", () => ({ id: "task_e_t" }), (a) => a.task("task_e_t"), "GET /tasks/{id}: task should be an object, got nothing"],
    ["the turns", "GET /tasks/task_e_t/turns", () => ({ turns: {} }), (a) => a.turns("task_e_t"), "GET /tasks/{id}/turns: turn_mapping should be an object, got nothing"],
    ["a turn's kind", "GET /tasks/task_e_t/turns", () => { const t = turns(); firstTurn(t).type = "system"; return t; }, (a) => a.turns("task_e_t"), 'turn_mapping.*.turn.type should be "user" or "assistant", got "system"'],
    ["when a turn started", "GET /tasks/task_e_t/turns", () => { const t = turns(); firstTurn(t).created_at = "today"; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.created_at should be a number, got a string"],
    ["a turn's chain", "GET /tasks/task_e_t/turns", () => { const t = turns(); assistant(t).previous_turn_id = 1; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.previous_turn_id should be a string, got a number"],
    ["a turn's status", "GET /tasks/task_e_t/turns", () => { const t = turns(); assistant(t).turn_status = { s: 1 }; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.turn_status should be a string, got an object"],
    ["an app-server event", "GET /tasks/task_e_t/turns", () => { const t = turns(); delete assistant(t).thread_events.events[0].method; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.thread_events.events[].method should be a string, got nothing"],
    ["an event's item", "GET /tasks/task_e_t/turns", () => { const t = turns(); const e = assistant(t).thread_events.events.find((x: any) => x.params?.item); e.params.item.type = 2; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.thread_events.events[].params.item.type should be a string, got a number"],
    ["an output item", "GET /tasks/task_e_t/turns", () => { const t = turns(); delete assistant(t).output_items[0].type; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.output_items[].type should be a string, got nothing"],
    ["a worklog message (legacy tasks)", "GET /tasks/task_e_t/turns", () => { const t = clone(fixture("turns.legacy.json")); assistant(t).worklog.messages[1].create_time = "noon"; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.worklog.messages[].create_time should be a number, got a string"],
    ["the repository a task works on", "GET /tasks/task_e_t/turns", () => { const t = turns(); assistant(t).environment.repo_map = []; return t; }, (a) => a.turns("task_e_t"), "turn_mapping.*.turn.environment.repo_map should be an object, got an array"],
    ["a created task's id", "POST /tasks", () => ({ id: "task_e_new" }), (a) => a.createTask({}), "POST /tasks: task should be an object, got nothing"],
    ["an environment's id", "GET /environments", () => [{ id: 3, env_vars: { TOKEN: "s3cret" } }], (a) => a.environments(), "GET /environments: [].id should be a string, got a number"],
    ["the environments", "GET /environments", () => ({ environments: [] }), (a) => a.environments(), "GET /environments: the body should be an array, got an object"],
  ];
  for (const [label, route, body, read, expected] of cases) {
    test(label, async () => {
      const { fetchImpl } = wham({ [route]: json(body()) });
      const err = await thrown(read(api(fetchImpl)));
      expect(err).toBeInstanceOf(CloudShapeError);
      expect(err.message).toContain(expected);
    });
  }

  test("a break never quotes a value: an environment's secrets stay out of the error", async () => {
    const { fetchImpl } = wham({ "GET /environments": json([{ id: 3, env_vars: { TOKEN: "s3cret" }, secrets: { K: "s3cret" } }]) });
    const err = await thrown(api(fetchImpl).environments());
    expect(err.message).toBe("GET /environments: [].id should be a string, got a number");
    expect(err.message).not.toContain("s3cret");
  });

  test("a body that is not JSON (a proxy's page with a 200) is a break, not an empty answer", async () => {
    const { fetchImpl } = wham({ "GET /tasks/list": () => new Response("<html>Just a moment...</html>", { status: 200 }) });
    expect((await thrown(api(fetchImpl).listTasks())).message).toBe("GET /tasks/list: the body should be an object, got nothing");
  });

  test("a turn id in the path is named {id}, so one break reads the same on every task", async () => {
    const { fetchImpl } = wham({ "GET /tasks/task_e_1/turns/task_e_1~assttrn_e_2": json({}) });
    expect((await thrown(api(fetchImpl).turn("task_e_1", "task_e_1~assttrn_e_2"))).message).toBe("GET /tasks/{id}/turns/{id}: turn should be an object, got nothing");
  });
});

describe("contract: error bodies", () => {
  const a = adapter(wham({}).fetchImpl);

  test("400 (recorded): the validation error's message and type; an answer codecast should never get", async () => {
    const err = cloudApiErrorOf(400, fixture("error.400.json"), "x");
    expect(err).toMatchObject({ status: 400, code: "invalid_request_error", fromApi: true });
    expect(err.message).toContain("Input should be 'draft' or 'auto_merge'");
    expect(await cloudSetupErrorOf(a, null, err)).toBeNull();
  });

  test("401 (recorded): the sign-in card, in Codex's words", async () => {
    const err = cloudApiErrorOf(401, fixture("error.401.json"), "x");
    const card = (await cloudSetupErrorOf(a, null, err))!;
    expect(card.kind).toBe("key_invalid");
    expect(card.message).toContain("Could not parse your authentication token");
    expect(cloudAgentCardKind(CODEX, card.message)).toBe("credential");
  });

  test("404 (recorded): an unknown task, which the mirror marks gone", () => {
    expect(cloudApiErrorOf(404, fixture("error.404.json"), "x")).toMatchObject({ status: 404, message: "Invalid task ID", fromApi: true });
  });

  test("403 from an Enterprise workspace without Codex Cloud: the card names the workspace setting and the RBAC permission", async () => {
    const err = cloudApiErrorOf(403, { detail: "You do not have access to Codex cloud tasks in this workspace." }, "x");
    const card = (await cloudSetupErrorOf(a, null, err))!;
    expect(card.kind).toBe("access");
    expect(card.message).toBe(`Codex Cloud is not enabled for you in this ChatGPT workspace (You do not have access to Codex cloud tasks in this workspace.). A workspace owner can turn on "Use Codex in the cloud" in the workspace's settings, or grant your role the "Use Codex in the cloud" permission where roles are custom (RBAC)${CLOUD_AGENT_RETRIED_SUFFIX}`);
    expect(cloudAgentCardKind(CODEX, card.message)).toBe("setup");
    // A proxy's 403 (a challenge page, no reason of the API's own) says nothing about the workspace.
    expect(await cloudSetupErrorOf(a, null, cloudApiErrorOf(403, undefined, "codex GET /tasks/list 403"))).toBeNull();
  });

  test("429 with the plan's window used up: the window, the plan and when it resets, waited for", async () => {
    const used = clone(USAGE);
    used.rate_limit.primary_window.used_percent = 100;
    const { fetchImpl } = wham({ "GET /usage": json(used) });
    const limited = adapter(fetchImpl);
    const err = cloudApiErrorOf(429, { detail: "Rate limit reached" }, "x");
    const card = (await cloudSetupErrorOf(limited, limited.client(), err))!;
    expect(card.kind).toBe("limit");
    // The window as the usage meters name it, the plan as people name it; the reset is data, counted down where it is shown.
    expect(card.message).toBe(`Codex Cloud limit reached: the Week (7d) window of your ChatGPT Pro plan is used up${CLOUD_AGENT_RETRIED_SUFFIX}`);
    expect(card.resetsAt).toBeGreaterThan(NOW);
    expect(cloudAgentProblemKind(CODEX, card.message)).toBe("limit");
    // The reset is days away: asked about again within six hours, never later.
    expect(card.recheckMs).toBe(6 * 60 * 60_000);
  });

  test("429 with room left on the plan: the requests are rate limited, for as long as Retry-After says", async () => {
    const { fetchImpl } = wham({ "GET /usage": json(USAGE), "GET /tasks/list": status({ detail: "Too many requests" }, 429, { "retry-after": "120" }) });
    const limited = adapter(fetchImpl);
    const err = await thrown(limited.listAgents(limited.client() as CodexCloudApi));
    expect(err).toMatchObject({ status: 429, retryAfterMs: 120_000 });
    const card = (await cloudSetupErrorOf(limited, limited.client(), err))!;
    expect(card.kind).toBe("limit");
    // The provider named once, and no countdown frozen into a card that stays in the thread.
    expect(card.message).toMatch(/^Codex Cloud limit reached: requests from .+ are rate limited \(Too many requests\); the message retries on its own\.$/);
    expect(card.recheckMs).toBe(120_000);
  });
});

/** A watcher over the adapter, with its log and errors kept. */
function watch(fetchImpl: typeof fetch, opts: { importAll?: boolean } = {}) {
  const logs: Array<[string, string | undefined]> = [];
  const errors: string[] = [];
  const watcher = new CloudAgentWatcher(adapter(fetchImpl), { rootDir: tmpDir("codex-hard-"), now: () => clock, log: (m, level) => logs.push([m, level]), importAll: () => opts.importAll ?? true });
  watcher.on("error", (e) => errors.push(e.message));
  return { watcher, logs, errors, warns: () => logs.filter(([, l]) => l === "warn").map(([m]) => m) };
}

describe("kill switch: a changed API pauses the lane, and a check that passes resumes it", () => {
  test("a shape break in the list: paused with one warn naming the path, nothing read until a check is due, then resumed", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": json({ tasks: [ASK_TASK] }), [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher, warns, logs } = watch(fetchImpl);
    const synced: string[] = [];
    watcher.on("session", (e) => synced.push(e.sessionId));
    await watcher.poll();
    const problem = watcher.setupProblem!;
    expect(problem.kind).toBe("changed");
    expect(problem.message).toMatch(/^Codex Cloud changed in a way codecast can't read yet\. Syncing on .+ is paused and checks again every 5 minutes; the message retries on its own\.$/);
    // Where it broke is the log's, not the card's.
    expect(problem.detail).toBe("GET /tasks/list: items should be an array, got nothing");
    expect(warns()).toEqual([`[codex-cloud] paused: ${problem.message} (${problem.detail})`]);
    // Polls before the check is due read nothing at all.
    const before = calls.length;
    clock += 60_000;
    await watcher.poll();
    await watcher.poll();
    expect(calls.length).toBe(before);
    // Due, still broken: one list call, no new warn, still paused.
    clock += 5 * 60_000;
    await watcher.poll();
    expect(calls.length).toBe(before + 1);
    expect(warns()).toHaveLength(1);
    // Codex answers as expected again: the check passes, the lane resumes and the same poll syncs.
    routes["GET /tasks/list"] = json({ items: [ASK_TASK] });
    clock += 5 * 60_000;
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    expect(logs.map(([m]) => m)).toContain("[codex-cloud] Codex Cloud answers again: syncing resumed");
    expect(synced).toEqual([ASK_TASK.id]);
  });

  test("a shape break in one task's turns pauses the lane too, and the check reads that task again before resuming", async () => {
    const broken = clone(ASK) as any;
    Object.values<any>(broken.turn_mapping)[0].turn.type = "system";
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": json({ items: [ASK_TASK] }), [`GET /tasks/${ASK_TASK.id}/turns`]: json(broken) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher } = watch(fetchImpl);
    await watcher.poll();
    expect(watcher.setupProblem?.detail).toContain('GET /tasks/{id}/turns: turn_mapping.*.turn.type should be "user" or "assistant", got "system"');
    // A send that finds the same change names no task: the one the read found broken is still the one checked.
    await watcher.report(watcher.adapter.client(), new CloudShapeError("id", "a string", "nothing", "POST /tasks"));
    // The list alone answering is not enough: the task that broke is read again, and still breaks.
    clock += 5 * 60_000;
    await watcher.poll();
    expect(calls.slice(-3).map((c) => c.path).sort()).toEqual(["/tasks/list", `/tasks/${ASK_TASK.id}`, `/tasks/${ASK_TASK.id}/turns`]);
    expect(watcher.setupProblem?.kind).toBe("changed");
    routes[`GET /tasks/${ASK_TASK.id}/turns`] = json(ASK);
    clock += 5 * 60_000;
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
  });

  test("a shape break in one task alone never holds the account: once another task reads, it waits on its own (a warn names it) and the rest sync", async () => {
    const broken = clone(ASK) as any;
    Object.values<any>(broken.turn_mapping)[0].turn.type = "system";
    const A = { ...ASK_TASK, id: `task_e_${"a".repeat(32)}` };
    const B = ASK_TASK;
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": json({ items: [A, B] }), [`GET /tasks/${A.id}/turns`]: json(broken), [`GET /tasks/${B.id}/turns`]: json(ASK) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher, warns } = watch(fetchImpl);
    const synced: string[] = [];
    watcher.on("session", (e) => synced.push(e.sessionId));
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("changed");
    expect(synced).toEqual([]);
    clock += 5 * 60_000 + 1;
    const before = calls.length;
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    expect(synced).toEqual([B.id]);
    expect(warns().at(-1)).toContain(`${A.id} still can't be read`);
    // The check's reads are the pass's: the list once, each task once.
    const pass = calls.slice(before).map((c) => c.path);
    expect(pass.filter((p) => p === "/tasks/list")).toHaveLength(1);
    expect(pass.filter((p) => p === `/tasks/${B.id}/turns`)).toHaveLength(1);
    // A, read again after its own backoff, still breaks: the lane runs on.
    for (let i = 0; i < 4; i++) {
      clock += 20 * 60_000;
      await watcher.poll();
      expect(watcher.setupProblem).toBeNull();
    }
    expect(calls.filter((c) => c.path === `/tasks/${A.id}/turns`).length).toBeGreaterThan(2);
  });

  test("a broken task stays the lane's problem while no other task reads cleanly (an outage proves nothing)", async () => {
    const broken = clone(ASK) as any;
    Object.values<any>(broken.turn_mapping)[0].turn.type = "system";
    const A = { ...ASK_TASK, id: `task_e_${"a".repeat(32)}` };
    const B = ASK_TASK;
    const { fetchImpl } = wham({ "GET /tasks/list": json({ items: [A, B] }), [`GET /tasks/${A.id}/turns`]: json(broken), [`GET /tasks/${B.id}/turns`]: status({ detail: "upstream" }, 502) });
    const { watcher } = watch(fetchImpl);
    await watcher.poll();
    clock += 5 * 60_000 + 1;
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("changed");
  });

  test("three unexpected answers in a row pause it; one between answered reads never does", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": status(fixture("error.400.json"), 400) };
    const { fetchImpl } = wham(routes);
    const { watcher } = watch(fetchImpl);
    await watcher.poll();
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    routes["GET /tasks/list"] = json({ items: [] });
    await watcher.poll();
    routes["GET /tasks/list"] = status(fixture("error.400.json"), 400);
    await watcher.poll();
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("changed");
    expect(watcher.setupProblem?.detail).toContain("3 answers in a row it does not expect, the last: [{'type': 'literal_error'");
  });

  test("one task that keeps answering an unexpected 4xx never keeps the lane paused: the check hands it to its own backoff, and the rest sync", async () => {
    // Four recent tasks: three whose turns answer 400, and D, healthy.
    const [A, B, C] = ["a", "b", "c"].map((x) => ({ ...ASK_TASK, id: `task_e_${x.repeat(32)}` }));
    const D = ASK_TASK;
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": json({ items: [A, B, C, D] }), [`GET /tasks/${D.id}/turns`]: json(ASK) };
    for (const t of [A, B, C]) routes[`GET /tasks/${t.id}/turns`] = status(fixture("error.400.json"), 400);
    const { fetchImpl } = wham(routes);
    const { watcher } = watch(fetchImpl);
    const synced: string[] = [];
    watcher.on("session", (e) => synced.push(e.sessionId));
    // Three different tasks answering 400 in a row read as a change, at first.
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("changed");
    // The check: the list answers and the task that broke fails again on its own, so the lane resumes and D syncs.
    for (let i = 0; i < 6; i++) {
      clock += 5 * 60_000 + 1;
      await watcher.poll();
    }
    expect(watcher.setupProblem).toBeNull();
    expect(synced).toContain(D.id);
  });

  test("a refusal found on one task is that task's alone: the lane runs, and no workspace block is reported", async () => {
    const A = { ...ASK_TASK, id: `task_e_${"a".repeat(32)}` };
    const B = ASK_TASK;
    const { fetchImpl } = wham({ "GET /tasks/list": json({ items: [A, B] }), [`GET /tasks/${A.id}/turns`]: status({ detail: "You do not have access to this task" }, 403), [`GET /tasks/${B.id}/turns`]: json(ASK) });
    const { watcher, warns } = watch(fetchImpl);
    const synced: string[] = [];
    watcher.on("session", (e) => synced.push(e.sessionId));
    for (let i = 0; i < 4; i++) {
      await watcher.poll();
      expect(watcher.setupProblem).toBeNull();
      clock += 5 * 60_000 + 1;
    }
    expect(synced).toEqual([B.id]);
    expect(warns()).toEqual([]);
  });

  test("a 403 in no words of Codex's (a proxy's challenge page) is read like an outage: never as Codex changing", async () => {
    const { fetchImpl } = wham({ "GET /tasks/list": () => new Response("<html>Just a moment...</html>", { status: 403 }) });
    const { watcher, warns, errors } = watch(fetchImpl);
    for (let i = 0; i < 4; i++) await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    expect(warns()).toEqual([]);
    expect(errors).toHaveLength(4);
  });

  test("an outage (5xx) or a network failure is never read as a change", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": status({ detail: "upstream" }, 502) };
    const { fetchImpl } = wham(routes);
    const { watcher } = watch(fetchImpl);
    for (let i = 0; i < 5; i++) await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
  });

  test("the heartbeat reports the pause as the machine's block, and a held message gets one card saying so, never sent", async () => {
    const { fetchImpl, calls } = wham({ "GET /tasks/list": json({}) });
    const lines: CloudAgentThreadLine[] = [];
    const reg = registry(fetchImpl, lines, "task_e_known");
    const { watcher } = watch(fetchImpl);
    reg.useWatcher(watcher);
    await watcher.poll();
    expect(reg.setupBlocks()).toEqual([{ provider: "codex", kind: "changed", reason: watcher.setupProblem!.reason }]);
    const before = calls.length;
    const err = await thrown(reg.deliver("conv-1", "next step"));
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.holdReason).toBe("waiting until codecast can read Codex Cloud again");
    expect(calls.length).toBe(before);
    expect(lines).toHaveLength(1);
    expect(lines[0].content).toStartWith(`${CLIENT_ERROR_BANNER_PREFIX} Codex Cloud changed in a way codecast can't read yet`);
    expect(cloudAgentCardKind(CODEX, lines[0].content.slice(CLIENT_ERROR_BANNER_PREFIX.length))).toBe("setup");
    expect(cloudAgentProblemKind(CODEX, lines[0].content.slice(CLIENT_ERROR_BANNER_PREFIX.length))).toBe("changed");
    expect(classifyApiErrorBanner(lines[0].content)).toBe("error");
  });

  test("a create whose answer changed: the task may exist, so the message is never sent again, and the lane pauses", async () => {
    const env = { id: "env1", repo_map: { r: { repository_full_name: "ashot/chatdoc", default_branch: "main" } } };
    const { fetchImpl, calls } = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json([env]), "POST /tasks": json({ id: "task_e_new" }) });
    const lines: CloudAgentThreadLine[] = [];
    const reg = registry(fetchImpl, lines);
    const { watcher } = watch(fetchImpl);
    reg.useWatcher(watcher);
    const sessions = reg.runtimes[0].sessions as CloudAgentSessions;
    (sessions as any).sessions["conv-1"] = { model: "", repoUrl: "https://github.com/ashot/chatdoc", repo: { owner: "ashot", name: "chatdoc" } };
    const err = await thrown(reg.deliver("conv-1", "start"));
    expect(err).toBeInstanceOf(CloudAgentUnsentError);
    expect(err.message).toContain("So that it is not started twice, the message is not sent again");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(watcher.setupProblem?.kind).toBe("changed");
    // Its own card: where to look (the provider's task list), and no retry.
    const unsent = lines.at(-1)!.content.slice(CLIENT_ERROR_BANNER_PREFIX.length);
    expect(cloudAgentCardKind(CODEX, unsent)).toBe("unsent");
    expect(unsent).toContain("look for it at https://chatgpt.com/codex,");
  });
});

describe("Enterprise 403: one card naming the admin permission, and no polling noise", () => {
  test("the list's 403 blocks the machine; each later pass is one quiet check; the admin turning it on resumes", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /tasks/list": status({ detail: "Codex cloud is disabled for this workspace" }, 403), [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher, warns, errors } = watch(fetchImpl);
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("access");
    expect(watcher.setupProblem?.reason).toContain('"Use Codex in the cloud"');
    for (let i = 0; i < 4; i++) await watcher.poll();
    // One list call per pass and nothing else; one warn, one error from the first pass, then silence.
    expect(calls.every((c) => c.path === "/tasks/list")).toBe(true);
    expect(calls).toHaveLength(5);
    expect(warns()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    routes["GET /tasks/list"] = json({ items: [ASK_TASK] });
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    expect(calls.at(-1)!.path).toBe(`/tasks/${ASK_TASK.id}/turns`);
  });
});

describe("429: back off, and say the plan's usage is used up", () => {
  test("a rate limit with Retry-After: no read until it passes, then the lane runs again", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /usage": json(USAGE), "GET /tasks/list": status({ detail: "Too many requests" }, 429, { "retry-after": "600" }) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher } = watch(fetchImpl);
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("limit");
    const listReads = () => calls.filter((c) => c.path === "/tasks/list").length;
    clock += 9 * 60_000;
    await watcher.poll();
    expect(listReads()).toBe(1);
    routes["GET /tasks/list"] = json({ items: [] });
    clock += 2 * 60_000;
    await watcher.poll();
    // The check, whose list read is the first page of the pass it lets run.
    expect(listReads()).toBe(2);
    expect(watcher.setupProblem).toBeNull();
  });

  test("a rate limit naming no wait: checks back off, doubling", async () => {
    const { fetchImpl, calls } = wham({ "GET /usage": json(USAGE), "GET /tasks/list": status({ detail: "slow down" }, 429) });
    const { watcher } = watch(fetchImpl);
    const listReads = () => calls.filter((c) => c.path === "/tasks/list").length;
    await watcher.poll();
    clock += 61_000;
    await watcher.poll();
    expect(listReads()).toBe(2);
    clock += 61_000;
    await watcher.poll();
    expect(listReads()).toBe(2);
    clock += 61_000;
    await watcher.poll();
    expect(listReads()).toBe(3);
  });

  test("a send refused because the plan is used up: held with a card naming the window, until it resets", async () => {
    const used = clone(USAGE);
    used.rate_limit.primary_window.used_percent = 100;
    used.rate_limit.primary_window.reset_at = (NOW + 2 * 60 * 60_000) / 1000;
    const { fetchImpl } = wham({ "GET /usage": json(used), [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK), [`GET /tasks/${ASK_TASK.id}`]: json({ task: ASK_TASK }), "POST /tasks": status({ detail: "You've hit your usage limit." }, 429) });
    const lines: CloudAgentThreadLine[] = [];
    const reg = registry(fetchImpl, lines, ASK_TASK.id);
    const err = await thrown(reg.deliver("conv-1", "more"));
    expect(err).toBeInstanceOf(CloudAgentSetupError);
    expect(err.kind).toBe("limit");
    expect(err.holdReason).toBe("waiting for the Codex Cloud limit to reset");
    expect(err.recheckMs).toBeGreaterThan(115 * 60_000);
    expect(err.recheckMs).toBeLessThanOrEqual(2 * 60 * 60_000);
    expect(lines[0].content).toContain("Codex Cloud limit reached: the Week (7d) window of your ChatGPT Pro plan is used up");
  });

  test("a send's plan limit holds sends only: a running task keeps syncing, the machine reports the limit, and a send that goes out lifts it", async () => {
    const used = usedUp(5 * 60 * 60_000);
    const R = runningTask("r");
    const routes: Record<string, (c: FakeCloudCall) => Response> = {
      "GET /usage": json(used),
      "GET /tasks/list": json({ items: [R, ASK_TASK] }),
      [`GET /tasks/${R.id}/turns`]: json(runningTurns()),
      [`GET /tasks/${ASK_TASK.id}/turns`]: json(ASK),
      [`GET /tasks/${ASK_TASK.id}`]: json({ task: ASK_TASK }),
      "POST /tasks": status({ detail: "You've hit your usage limit." }, 429),
    };
    const { fetchImpl, calls } = wham(routes);
    const lines: CloudAgentThreadLine[] = [];
    const reg = registry(fetchImpl, lines, ASK_TASK.id);
    const { watcher } = watch(fetchImpl);
    reg.useWatcher(watcher);
    const unfollowed: string[] = [];
    watcher.on("unfollowed", (id) => unfollowed.push(id));
    await watcher.poll();
    expect((await thrown(reg.deliver("conv-1", "more"))).kind).toBe("limit");
    // Reported for the composer and Settings, with the reset to count down.
    expect(reg.setupBlocks()).toEqual([expect.objectContaining({ provider: "codex", kind: "limit", resets_at: used.rate_limit.primary_window.reset_at * 1000 })]);
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === `/tasks/${R.id}/turns`).length;
    const before = reads();
    // An hour of fast polls.
    for (let i = 0; i < 30; i++) {
      clock += 2 * 60_000;
      await watcher.poll();
    }
    // Every pass still reads the running task, so it is never let go.
    expect(reads()).toBe(before + 30);
    expect(unfollowed).toEqual([]);
    expect(watcher.setupProblem?.kind).toBe("limit");
    routes["POST /tasks"] = json({});
    expect(await reg.deliver("conv-1", "more")).not.toBeNull();
    expect(watcher.setupProblem).toBeNull();
  });

  test("a read's 429 while the plan is used up waits as long as Retry-After says, not until the plan resets", async () => {
    const routes: Record<string, (c: FakeCloudCall) => Response> = { "GET /usage": json(usedUp(5 * 60 * 60_000)), "GET /tasks/list": status({ detail: "Too many requests" }, 429, { "retry-after": "120" }) };
    const { fetchImpl, calls } = wham(routes);
    const { watcher } = watch(fetchImpl);
    await watcher.poll();
    expect(watcher.setupProblem?.kind).toBe("limit");
    routes["GET /tasks/list"] = json({ items: [] });
    clock += 2 * 60_000 + 1;
    await watcher.poll();
    expect(watcher.setupProblem).toBeNull();
    expect(calls.filter((c) => c.path === "/tasks/list")).toHaveLength(2);
  });
});

/** The usage reading with the plan's week window used up, resetting `inMs` from now. */
function usedUp(inMs: number) {
  const used = clone(USAGE);
  used.rate_limit.primary_window.used_percent = 100;
  used.rate_limit.primary_window.reset_at = (NOW + inMs) / 1000;
  return used;
}

/** A listed task whose latest turn runs. */
function runningTask(x: string): WhamTask {
  const t = clone(ASK_TASK) as any;
  t.id = `task_e_${x.repeat(32)}`;
  t.task_status_display = { ...t.task_status_display, latest_turn_status_display: { ...t.task_status_display?.latest_turn_status_display, turn_status: "in_progress" } };
  return t;
}

/** The ask task's turns with its answer still running. */
function runningTurns() {
  const t = clone(ASK) as any;
  for (const node of Object.values<any>(t.turn_mapping)) if (node.turn.type === "assistant") node.turn.turn_status = "in_progress";
  return t;
}

describe("pickEnvironment reads only checked environments", () => {
  test("an environments answer of the wrong shape is a break, not 'no environment for this repo'", async () => {
    const { fetchImpl } = wham({ "GET /environments/by-repo/github/ashot/chatdoc": json({ items: [] }) });
    expect(await thrown(pickEnvironment(api(fetchImpl), "ashot", "chatdoc"))).toBeInstanceOf(CloudShapeError);
  });
});

/** A registry over the Codex adapter alone, its thread lines kept; `agentId`: conv-1 is already bound to that task. */
function registry(fetchImpl: typeof fetch, lines: CloudAgentThreadLine[], agentId?: string) {
  return new CloudAgentRegistry([adapter(fetchImpl)], {
    bindSession: () => {},
    agentForConversation: (c) => (c === "conv-1" ? agentId : undefined),
    setStatus: () => {},
    addLine: async (_c, line) => { lines.push(line); },
    enqueueMessage: async () => {},
    hostSession: async () => "hosted",
    releaseSession: () => {},
    placeSession: async () => true,
    retitleSession: async () => true,
    markArchived: async () => true,
    log: () => {},
  }, () => path.join(tmpDir("codex-hard-sessions-"), "sessions.json"));
}
