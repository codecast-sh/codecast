import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openTaskStart } from "./backgroundTaskStart.js";
import { scanOpenBackgroundTasks } from "./backgroundTaskScan.js";
import { claudeSessionProcessAlive } from "./claudeSessionAlive.js";
import { SubagentFinishTracker, parentTaskNotice, readSubagentRunFacts, subagentParentAlive, subagentRunState, type SubagentRunFacts, type SubagentStatusSink } from "./subagentFinish.js";

const FILE = "/p/proj/parent-uuid/subagents/agent-abc.jsonl";
const CONV = "convChild1";

// Lines in the shapes Claude Code 2.1.332 wrote in the pl-1134 spike (doc s97fpzx).
const line = (d: object) => JSON.stringify(d);
const launch = line({ type: "user", message: { role: "user", content: "bg wait test" }, timestamp: "2026-11-27T01:57:54.000Z" });
const toolUse = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01Sdra", name: "Bash", input: { command: "python3 -c \"import time; time.sleep(90)\"" } }] }, timestamp: "2026-11-27T01:57:54.817Z" });
const toolResult = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Sdra", content: "42" }] }, timestamp: "2026-11-27T01:59:32.673Z" });
const doneText = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "DONE-BG" }] }, timestamp: "2026-11-27T01:59:33.453Z" });
const attachment = line({ type: "attachment", attachment: { type: "edited_text_file" }, timestamp: "2026-11-27T01:59:33.460Z" });
const apiRequest = line({ type: "api-request", timestamp: "2026-11-27T01:59:33.470Z" });
const bgStart = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: babd0ov71. Output is being written to: /tmp/x" }] }, timestamp: "2026-11-27T02:24:43.316Z" });
const started = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "STARTED" }] }, timestamp: "2026-11-27T02:24:43.914Z" });
const bgDone = line({ type: "user", message: { role: "user", content: "[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification><task-id>babd0ov71</task-id><status>completed</status></task-notification>" }, timestamp: "2026-11-27T02:25:04.885Z" });
const rejected = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Sdra", is_error: true, content: "The user doesn't want to proceed with this tool use." }] }, timestamp: "2026-11-27T02:04:22.207Z" });
const interrupted = line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] }, timestamp: "2026-11-27T02:04:22.210Z" });
const resumeMessage = line({ type: "user", message: { role: "user", content: "The coordinator sent a message while you were working:\nRun in the foreground … then reply RESUMED-DONE.\n\nAddress this before completing your current task." }, timestamp: "2026-11-27T02:23:03.439Z" });

const META = { agentType: "general-purpose", description: "bg wait test", toolUseId: "toolu_01MpBn", spawnDepth: 1, requestShape: "background" };
const FINISHED = { ...META, finished: true };
const jsonl = (...lines: string[]) => lines.join("\n") + "\n";
const facts = (meta: object | null, agentJsonl: string, parentAlive = true): SubagentRunFacts => ({ meta, agentJsonl, parentAlive });

describe("subagentRunState", () => {
  test("running mid tool call: no finished, last line an unanswered tool_use", () => {
    expect(subagentRunState(facts(META, jsonl(launch, toolUse)))).toBe("running");
  });
  test("finished: the meta says so and nothing of its own is open", () => {
    expect(subagentRunState(facts(FINISHED, jsonl(launch, toolUse, toolResult, doneText, attachment, apiRequest)))).toBe("stopped");
  });
  test("finished while its own background command runs is still running (it wakes when that reports)", () => {
    expect(subagentRunState(facts(FINISHED, jsonl(launch, bgStart, started)))).toBe("running");
    expect(subagentRunState(facts(FINISHED, jsonl(launch, bgStart, started, bgDone, doneText)))).toBe("stopped");
  });
  test("TaskStop'd: the meta never gets finished, the last message line is the interrupt", () => {
    expect(subagentRunState(facts(META, jsonl(launch, toolUse, rejected, attachment, interrupted)))).toBe("stopped");
  });
  test("resumed by SendMessage: finished cleared, running until it finishes again", () => {
    expect(subagentRunState(facts(META, jsonl(launch, doneText, resumeMessage, toolUse)))).toBe("running");
  });
  test("a dead parent stops it whatever its files say", () => {
    expect(subagentRunState(facts(META, jsonl(launch, toolUse), false))).toBe("stopped");
    expect(subagentRunState(facts({ ...META, teamName: "session-1" }, jsonl(launch), false))).toBe("stopped");
  });
  test("a teammate idles inside its lead: running while the lead lives", () => {
    expect(subagentRunState(facts({ ...FINISHED, taskKind: "in_process_teammate", teamName: "session-1" }, jsonl(launch, doneText)))).toBe("running");
  });
});

// A named Agent call (`name` given) runs as an in-process teammate: its meta
// has taskKind/teamName, it never gets `finished`, and its id is a<name>-<hex>.
const NAMED_ID = "areview-mobile-fe89e5471ddad254";
const TEAMMATE = { agentType: "review-mobile", description: "Review phone app", name: "review-mobile", taskKind: "in_process_teammate", teamName: "session-199be19e" };
const noticeLine = (id: string, status: string, at: string) => line({ type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent "review" was stopped by Claude</summary>\n</task-notification>` }, timestamp: at });
const teammateIdle = jsonl(launch, line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Report sent." }] }, timestamp: "2026-11-27T04:30:00.000Z" }));

describe("a named agent stops when its parent's latest notice for it says so", () => {
  test("a killed notice after its last line stops it", () => {
    expect(subagentRunState({ meta: TEAMMATE, agentJsonl: teammateIdle, parentAlive: true, parentNotice: { status: "killed", at: Date.parse("2026-11-27T04:31:00.000Z") } })).toBe("stopped");
    expect(subagentRunState({ meta: TEAMMATE, agentJsonl: teammateIdle, parentAlive: true, parentNotice: { status: "stopped", at: Date.parse("2026-11-27T04:31:00.000Z") } })).toBe("stopped");
  });
  test("lines written after the notice mean it was revived", () => {
    expect(subagentRunState({ meta: TEAMMATE, agentJsonl: teammateIdle, parentAlive: true, parentNotice: { status: "killed", at: Date.parse("2026-11-27T04:29:00.000Z") } })).toBe("running");
  });
  test("a completed notice, or none, leaves a teammate running", () => {
    expect(subagentRunState({ meta: TEAMMATE, agentJsonl: teammateIdle, parentAlive: true, parentNotice: { status: "completed", at: Date.parse("2026-11-27T04:31:00.000Z") } })).toBe("running");
    expect(subagentRunState({ meta: TEAMMATE, agentJsonl: teammateIdle, parentAlive: true, parentNotice: null })).toBe("running");
  });
  test("parentTaskNotice reads the latest notification naming the agent, among batched ids", () => {
    const parent = jsonl(
      noticeLine(NAMED_ID, "completed", "2026-11-27T04:20:00.000Z"),
      line({ type: "queue-operation", operation: "enqueue", content: `<task-notification><task-id>bother1</task-id><task-id>${NAMED_ID}</task-id><status>killed</status></task-notification>`, timestamp: "2026-11-27T04:31:00.000Z" }),
      noticeLine("a0559479375992e8a", "completed", "2026-11-27T04:32:00.000Z"),
    );
    expect(parentTaskNotice(parent, NAMED_ID)).toEqual({ status: "killed", at: Date.parse("2026-11-27T04:31:00.000Z") });
    expect(parentTaskNotice(parent, "nobody")).toBeNull();
  });
  test("readSubagentRunFacts finds the notice in the parent's transcript beside the subagents dir", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "named-agent-"));
    fs.mkdirSync(path.join(project, "parent-uuid", "subagents"), { recursive: true });
    const agentPath = path.join(project, "parent-uuid", "subagents", `agent-${NAMED_ID}.jsonl`);
    fs.writeFileSync(agentPath, teammateIdle);
    fs.writeFileSync(agentPath.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(TEAMMATE));
    fs.writeFileSync(path.join(project, "parent-uuid.jsonl"), jsonl(launch, noticeLine(NAMED_ID, "killed", "2026-11-27T04:31:00.000Z")));
    const facts = await readSubagentRunFacts(agentPath);
    expect(facts?.parentNotice).toEqual({ status: "killed", at: Date.parse("2026-11-27T04:31:00.000Z") });
    expect(subagentRunState(facts!)).toBe("stopped");
  });
});

describe("a SendMessage resume opens the resumed agent as the parent's background work", () => {
  const resumeResult = '{"success":true,"message":"Resuming agent aca2c98","resumedAgentId":"aca2c98614b1916fb","pin":{"id":"aca2c98614b1916fb","name":"aca2c98614b1916fb","ref":"e7fb8a"}}';
  test("the resume tool_result opens the agent id", () => {
    expect(openTaskStart(resumeResult)).toEqual({ id: "aca2c98614b1916fb", kind: "agent" });
  });
  test("the parent's open set holds it until the resumed run notifies", () => {
    const sendMessage = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01Dy7J", name: "SendMessage", input: { to: "aca2c98614b1916fb", message: "Run …" } }] } });
    const result = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Dy7J", content: [{ type: "text", text: resumeResult }] }] } });
    const notice = line({ type: "user", message: { role: "user", content: "<task-notification>\n<task-id>aca2c98614b1916fb</task-id>\n<tool-use-id>toolu_01Dy7J</tool-use-id>\n<status>completed</status>\n<summary>Agent \"resume target\" finished</summary>\n</task-notification>" } });
    expect([...scanOpenBackgroundTasks(jsonl(sendMessage, result))]).toEqual(["aca2c98614b1916fb"]);
    expect([...scanOpenBackgroundTasks(jsonl(sendMessage, result, notice))]).toEqual([]);
  });
  test("a refused SendMessage opens nothing", () => {
    expect(openTaskStart('{"success":false,"message":"No agent named \'a8665f7\' is reachable."}')).toBeUndefined();
  });
});

describe("parent liveness", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-"));
  const probe = (alive: Set<number>, starts: Record<number, string | null>) => ({ alive: (pid: number) => alive.has(pid), startOf: (pid: number) => starts[pid] ?? null });
  test("alive only while the pid lives and still has the registered start", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "32471.json"), JSON.stringify({ pid: 32471, sessionId: "parent", procStart: "Fri Nov 27 01:54:53 2026" }));
    expect(claudeSessionProcessAlive(d, "parent", probe(new Set([32471]), { 32471: "Fri Nov 27  01:54:53 2026" }))).toBe(true);
    expect(claudeSessionProcessAlive(d, "parent", probe(new Set(), {}))).toBe(false);
    expect(claudeSessionProcessAlive(d, "parent", probe(new Set([32471]), { 32471: "Sat Nov 28 09:00:00 2026" }))).toBe(false);
    expect(claudeSessionProcessAlive(d, "other", probe(new Set([32471]), { 32471: "Fri Nov 27 01:54:53 2026" }))).toBe(false);
    // ps could not say: never read as dead.
    expect(claudeSessionProcessAlive(d, "parent", probe(new Set([32471]), {}))).toBe(true);
  });
  test("the parent of a transcript is looked up in its own config dir", () => {
    const config = dir();
    fs.mkdirSync(path.join(config, "sessions"));
    fs.writeFileSync(path.join(config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "parent-uuid" }));
    expect(subagentParentAlive(path.join(config, "projects", "-p", "parent-uuid", "subagents", "agent-a1.jsonl"))).toBe(true);
    expect(subagentParentAlive(path.join(config, "projects", "-p", "gone-uuid", "subagents", "agent-a1.jsonl"))).toBe(false);
  });
});

function harness(initial: SubagentRunFacts | null) {
  let state = initial;
  const calls: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const sink: SubagentStatusSink = {
    markSessionCompleted: async (id) => { calls.push(`completed:${id}`); },
    markSessionActive: async (id) => { calls.push(`active:${id}`); },
  };
  const tracker = new SubagentFinishTracker({
    readState: async () => state,
    setTimer: (fn) => { const h = nextTimer++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  return {
    tracker, calls, sink,
    set(next: SubagentRunFacts | null) { state = next; },
    pendingTimers: () => timers.size,
    /** Fire every armed timer, as if the transcript stayed quiet, and let the check finish. */
    async quiet() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("SubagentFinishTracker", () => {
  test("a finished subagent is marked completed once, after the transcript goes quiet", async () => {
    const h = harness(facts(META, jsonl(launch, toolUse)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    h.set(facts(FINISHED, jsonl(launch, toolUse, toolResult, doneText)));
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.pendingTimers()).toBe(1);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
    await h.tracker.check(FILE);
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("a TaskStop'd subagent is completed, not left Working", async () => {
    const h = harness(facts(META, jsonl(launch, toolUse, rejected, attachment, interrupted)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("finished while its own background work runs is not completed early", async () => {
    const h = harness(facts(FINISHED, jsonl(launch, bgStart, started)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([]);
    // The child reports, the agent wakes and finishes.
    h.set(facts(FINISHED, jsonl(launch, bgStart, started, bgDone, doneText)));
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("growth after completion reopens it once, then it can finish again", async () => {
    const h = harness(facts(FINISHED, jsonl(launch, doneText)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
    // Parent resumes it with SendMessage: new lines land and the meta loses finished.
    h.set(facts(META, jsonl(launch, doneText, resumeMessage, toolUse)));
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`, `active:${CONV}`]);
    h.set(facts(FINISHED, jsonl(launch, doneText, resumeMessage, toolUse, toolResult, doneText)));
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`, `active:${CONV}`, `completed:${CONV}`]);
  });

  test("meta written after the last transcript line is still caught by the quiet timer", async () => {
    const h = harness(facts(META, jsonl(launch, doneText)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([]);
    h.set(facts(FINISHED, jsonl(launch, doneText)));
    await h.quiet();
    expect(h.calls).toEqual([`completed:${CONV}`]);
  });

  test("a check that started before new lines landed gives up", async () => {
    let release!: () => void;
    const calls: string[] = [];
    const sink: SubagentStatusSink = {
      markSessionCompleted: async (id) => { calls.push(`completed:${id}`); },
      markSessionActive: async (id) => { calls.push(`active:${id}`); },
    };
    const tracker = new SubagentFinishTracker({
      readState: () => new Promise((r) => { release = () => r(facts(FINISHED, jsonl(launch, doneText))); }),
      setTimer: () => 0, clearTimer: () => {},
    });
    tracker.noteCreated(FILE);
    await tracker.noteGrowth(FILE, CONV, sink);
    const checking = tracker.check(FILE);
    await tracker.noteGrowth(FILE, CONV, sink);
    release();
    await checking;
    expect(calls).toEqual([]);
  });

  test("first growth this daemon sees asserts active once; created rows and teammates are skipped", async () => {
    const h = harness(facts(META, jsonl(launch, toolUse)));
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    expect(h.calls).toEqual([`active:${CONV}`]);

    const created = "/p/proj/parent-uuid/subagents/agent-new.jsonl";
    h.tracker.noteCreated(created);
    await h.tracker.noteGrowth(created, "convNew", h.sink);

    const mate = harness(facts({ ...FINISHED, teamName: "session-1" }, jsonl(launch, doneText), false));
    await mate.tracker.noteGrowth(FILE, CONV, mate.sink);
    await mate.quiet();
    expect(mate.calls).toEqual([]);
    expect(h.calls).toEqual([`active:${CONV}`]);
  });

  test("top-level transcripts are ignored", async () => {
    const h = harness(facts(FINISHED, jsonl(launch, doneText)));
    await h.tracker.noteGrowth("/p/proj/parent-uuid.jsonl", CONV, h.sink);
    expect(h.pendingTimers()).toBe(0);
    await h.quiet();
    expect(h.calls).toEqual([]);
  });

  test("stop clears armed timers and blocks later checks", async () => {
    const h = harness(facts(FINISHED, jsonl(launch, doneText)));
    h.tracker.noteCreated(FILE);
    await h.tracker.noteGrowth(FILE, CONV, h.sink);
    h.tracker.stop();
    expect(h.pendingTimers()).toBe(0);
    await h.tracker.check(FILE);
    expect(h.calls).toEqual([]);
  });
});
