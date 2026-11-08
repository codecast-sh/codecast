import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMidWorkReviveNotice, watchdogRestartReason } from "@codecast/shared/contracts";
import { REVIVE_BUDGET } from "./midWorkRevive.js";
import {
  MEM_FORCE_BYTES, MEM_RESTART_BYTES, STUCK_MS,
  describeOwnWork, liveWorkflowRuns, sessionLastActivityMs, sessionWatchdogDecision, watchdogReviveMessage, type WatchdogFacts,
} from "./sessionWatchdog.js";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const MIN = 60_000;
const GIB = 1024 ** 3;

function facts(over: Partial<WatchdogFacts> = {}): WatchdogFacts {
  return {
    status: "working", busySinceMs: NOW - 47 * MIN, lastActivityMs: NOW - 31 * MIN,
    awakeSinceMs: NOW - 24 * 60 * MIN, waitingOn: null, rssBytes: 2 * GIB, priorRestarts: [], now: NOW,
    ...over,
  };
}

describe("sessionWatchdogDecision: hung", () => {
  test("busy 30 min with no activity for 30 min is restarted and revived", () => {
    const v = sessionWatchdogDecision(facts());
    expect(v).toMatchObject({ restart: true, cause: "hung", resume: "revive" });
  });

  test("recent subagent or workflow activity keeps it alive", () => {
    expect(sessionWatchdogDecision(facts({ lastActivityMs: NOW - 2 * MIN }))).toEqual({ restart: false, reason: "healthy" });
  });

  // b6e142dc on 2026-10-28: busy 47 min, its transcript quiet 30 min, waiting
  // on its own Workflow whose agents wrote elsewhere. The local watchdog killed it.
  test("a session waiting on its own background work is never hung", () => {
    const v = sessionWatchdogDecision(facts({ waitingOn: "workflow wf_abc" }));
    expect(v).toEqual({ restart: false, reason: "waiting-on-own-work", detail: "workflow wf_abc" });
  });

  test("a busy status whose transcript ended the turn is a missed Stop hook, not a hang", () => {
    expect(sessionWatchdogDecision(facts({ transcriptTurnEnded: true }))).toEqual({ restart: false, reason: "healthy" });
  });

  test("a short busy stretch is not hung, however quiet", () => {
    expect(sessionWatchdogDecision(facts({ busySinceMs: NOW - 10 * MIN })).restart).toBe(false);
  });

  test("a session between turns is never hung", () => {
    for (const status of ["idle", "waiting", "dormant", "permission_blocked", undefined]) {
      expect(sessionWatchdogDecision(facts({ status })).restart).toBe(false);
    }
  });

  test("time asleep is not time hung", () => {
    expect(sessionWatchdogDecision(facts({ awakeSinceMs: NOW - 5 * MIN })).restart).toBe(false);
    expect(sessionWatchdogDecision(facts({ awakeSinceMs: NOW - STUCK_MS })).restart).toBe(true);
  });
});

describe("sessionWatchdogDecision: memory", () => {
  test("over the restart line while idle is restarted without a turn", () => {
    const v = sessionWatchdogDecision(facts({ status: "idle", busySinceMs: undefined, rssBytes: 35 * GIB }));
    expect(v).toEqual({ restart: true, cause: "memory", resume: "resume-only", detail: "it leaked memory (35 GB resident)" });
  });

  test("over the restart line while busy waits for the turn to end, until the hard ceiling", () => {
    const busy = facts({ lastActivityMs: NOW - MIN, rssBytes: MEM_RESTART_BYTES + GIB });
    expect(sessionWatchdogDecision(busy)).toMatchObject({ restart: false, reason: "memory-waits-for-turn-end" });
    expect(sessionWatchdogDecision({ ...busy, rssBytes: MEM_FORCE_BYTES })).toMatchObject({ restart: true, cause: "memory", resume: "revive" });
  });

  test("between turns but owning background work also waits until the ceiling, then is revived", () => {
    const owning = facts({ status: "waiting", rssBytes: 40 * GIB, waitingOn: "1 background task(s)" });
    expect(sessionWatchdogDecision(owning).restart).toBe(false);
    expect(sessionWatchdogDecision({ ...owning, rssBytes: 50 * GIB })).toMatchObject({ restart: true, resume: "revive" });
  });

  test("under the line is left alone", () => {
    expect(sessionWatchdogDecision(facts({ status: "idle", rssBytes: 31 * GIB }))).toEqual({ restart: false, reason: "healthy" });
  });
});

describe("sessionWatchdogDecision: budget", () => {
  test("shares the mid-work revive budget and stops when it is spent", () => {
    const spent = Array.from({ length: REVIVE_BUDGET }, (_, i) => NOW - (i + 1) * 30 * MIN);
    expect(sessionWatchdogDecision(facts({ priorRestarts: spent }))).toMatchObject({ restart: false, reason: "budget-spent" });
    expect(sessionWatchdogDecision(facts({ status: "idle", rssBytes: 40 * GIB, priorRestarts: spent })).restart).toBe(false);
    expect(sessionWatchdogDecision(facts({ priorRestarts: spent.slice(1) })).restart).toBe(true);
  });
});

describe("the revive message", () => {
  test("is a mid-work revive the web reads its cause from", () => {
    const msg = watchdogReviveMessage("it hung: working for 47 min with no activity for 31 min");
    expect(isMidWorkReviveNotice(msg)).toBe(true);
    expect(watchdogRestartReason(msg)).toBe("it hung: working for 47 min with no activity for 31 min");
  });
});

describe("describeOwnWork", () => {
  test("names what the session waits on", () => {
    expect(describeOwnWork(0, [], "working")).toBeNull();
    expect(describeOwnWork(2, ["wf_a"], "working")).toBe("workflow wf_a and 2 background task(s)");
    expect(describeOwnWork(0, [], "waiting")).toBe("background work (status waiting)");
  });
});

describe("activity on disk", () => {
  function session() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-watchdog-"));
    const transcript = path.join(dir, "s1.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    const old = new Date(NOW - 60 * MIN);
    fs.utimesSync(transcript, old, old);
    return { dir, transcript, host: path.join(dir, "s1") };
  }

  test("counts a workflow agent's write deep under the session folder", async () => {
    const { transcript, host } = session();
    const runDir = path.join(host, "subagents", "workflows", "wf_1");
    fs.mkdirSync(runDir, { recursive: true });
    const agent = path.join(runDir, "agent-a1.jsonl");
    fs.writeFileSync(agent, "{}\n");
    const recent = new Date(NOW - 2 * MIN);
    fs.utimesSync(agent, recent, recent);
    expect(await sessionLastActivityMs(transcript)).toBe(recent.getTime());
  });

  test("a workflow with a started agent and no result is live; a finished or older one is not", async () => {
    const { transcript, host } = session();
    const runDir = path.join(host, "subagents", "workflows", "wf_live");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "journal.jsonl"), JSON.stringify({ type: "started", agentId: "a1", key: "k" }) + "\n");
    expect(await liveWorkflowRuns(transcript)).toEqual(["wf_live"]);
    // Older than the current process: the run died with an earlier one.
    expect(await liveWorkflowRuns(transcript, Date.now() + 60_000)).toEqual([]);
    fs.appendFileSync(path.join(runDir, "journal.jsonl"), JSON.stringify({ type: "result", agentId: "a1" }) + "\n");
    expect(await liveWorkflowRuns(transcript)).toEqual([]);
  });
});
