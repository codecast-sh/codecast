import "./test-helpers/isolatedTmuxServer.js";
import http from "node:http";
import WebSocket from "ws";
import { attachTerminalServer } from "./terminal/terminalServer.js";
import { hasTmux, tmuxRun } from "./tmux.js";
import { writePane } from "./terminal/paneStream.js";
import { expect, test } from "bun:test";
import fs from "node:fs";
import * as inference from "./keystrokeInference.js";
import { isSafeStatusSessionId } from "./statusSpool.js";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion.js";
import { decideEscape, turnLooksActive } from "./escapeInterrupt.js";

const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const compile = (text: string, deps: Record<string, unknown>) => new Function(...Object.keys(deps), new Bun.Transpiler({ loader: "ts" }).transformSync(text))(...Object.values(deps));

function fixture(writeSucceeded = true) {
  const now = Date.now();
  const writes: any[][] = [];
  const statuses = new Map([["sid", "working"]]);
  const statusAt = new Map([["sid", now]]);
  const awaiting = new Set<string>();
  const before = new Map<string, string>();
  const timers: Array<() => void> = [];
  const stampReads: string[] = [];
  const deps = {
    ...inference,
    createKeystrokeInference: (opts: inference.KeystrokeInferenceDeps) => inference.createKeystrokeInference({ ...opts, setTimer: fn => { timers.push(fn); return { unref() {} } as any; }, clearTimer: () => {} }),
    readAskInputSidecar: async () => ({ questions: [{ options: [{ label: "yes" }, { label: "no" }] }] }),
    ASK_INPUT_DIR: "/fixture", lastSentAgentStatus: statuses, lastAgentStatusSentAt: statusAt,
    turnStartedAt: new Map([["sid", now - 1000]]), detectSessionAgentType: () => "claude",
    awaitingAskUserQuestion: awaiting, preAskUserQuestionStatus: before, conversationCacheRef: { sid: "conv" },
    syncServiceRef: { updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; } },
    log: () => {}, sessionProcessCache: new Map([["sid", { tmuxTarget: "ct-claude-test:0.0" }]]),
    getTmuxSessionOption: async (name: string) => { stampReads.push(name); return "sid"; },
    isManagedTmuxName: (name: string) => name.startsWith("ct-"), isSafeStatusSessionId,
    terminalToken: () => "token", isSupersededAppServerSession: () => false,
    hibernationInFlight: new Map(), lastWorkingStatusSent: new Map(), WORKING_STATUS_THROTTLE_MS: 10_000,
    statusFlipStartsTurn: () => false, markTurnStarted: () => {}, pendingOpenTaskReports: new Map(),
    SETTLE_STATUSES_WITH_TASKS: new Set(["idle"]), SETTLE_VERDICT_STATUSES: new Set(),
    turnCompletedAtBySession: new Map(), serializeSessionStatus: (_sid: string, write: () => unknown) => write(),
    hibernatedSessions: new Set(), lastOpenTasksSentAt: new Map(), lastOpenTasksSentJson: new Map(),
    writePane: () => writeSucceeded,
    ACTIVE_AGENT_STATUSES: new Set(["working", "thinking", "tool_use"]),
    isPhantomBypassPermissionBlock: () => false,
  };
  const functions = ["classifyBypassBlock", "sendAgentStatus", "sessionIdForTmuxTarget", "observePaneInput", "observeSessionInput", "terminalServerOptions"];
  const code = [blockAt(source, source.indexOf("const keystrokeInference =")).text, ...functions.map(name => functionBlock(source, name).text.replace(/^export /, ""))].join("\n");
  const hookAt = source.indexOf("      const inheritedMode = data.permission_mode || prev?.permission_mode;");
  const hookState = source.slice(hookAt, source.indexOf("      if (classifyBypassBlock", hookAt));
  const hook = `function receiveHook(data) { const prev = undefined; const sessionId = "sid"; ${hookState} classifyBypassBlock(awaitingAskUserQuestion, sessionId, data.status, data.permission_mode, data.message); sendAgentStatus(syncServiceRef, "conv", sessionId, data.status); }`;

  const streamAt = source.indexOf("startPaneStream(target, {");
  const write = blockAt(source, source.indexOf("write: (pane, bytes)", streamAt)).text.trim().replace(/^write: /, "").replace(/,$/, "");
  const api = compile(code + hook + `\nreturn { receiveHook, keystrokeInference, terminalServerOptions, observePaneInput, observeSessionInput, remoteWrite: ${write}, realStatus: status => sendAgentStatus(syncServiceRef, "conv", "sid", status) };`, deps);
  return { ...api, statuses, statusAt, awaiting, before, writes, timers, stampReads };
}
const drain = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("integrated-terminal onInput produces the interrupted status after the fallback interval", async () => {
  const f = fixture();
  f.terminalServerOptions().onInput("ct-claude-test:0.0", Buffer.from([3]));
  await drain();
  expect(f.writes).toEqual([]);
  expect(f.timers).toHaveLength(1);
  expect(f.keystrokeInference.flushPending("sid")).toBe("interrupted");
  expect(f.writes[0]).toMatchObject({ 0: "conv", 1: "idle", 5: true });
});

test("a real status cancels the fallback, including a throttled same-status hook", async () => {
  const f = fixture();
  f.realStatus("working");
  f.observeSessionInput("sid", { kind: "ctrl-c" });
  await drain();
  f.realStatus("working");
  expect(f.keystrokeInference.flushPending("sid")).toBe("ignored");
  expect(f.writes.map((w: any[]) => w[1])).toEqual(["working"]);
});

test("remote input clears a single-select question and restores the prior active status", async () => {
  const f = fixture();
  f.statuses.set("sid", "thinking");
  f.receiveHook({ status: "permission_blocked", message: "AskUserQuestion" });
  expect(f.before.get("sid")).toBe("thinking");
  f.receiveHook({ status: "permission_blocked", message: "Notification" });
  f.writes.length = 0;
  f.remoteWrite("ct-claude-test:0.0", [49]);
  await drain(); await drain();
  expect(f.writes[0][1]).toBe("thinking");
  expect(f.awaiting.has("sid")).toBe(false);
  expect(f.before.has("sid")).toBe(false);
});

test("unrelated panes and pasted bytes never infer a turn end", async () => {
  const f = fixture();
  f.observePaneInput("human-shell:0.0", [3]);
  f.observePaneInput("ct-claude-test:0.1", [3]);
  f.observePaneInput("ct-claude-test:0.0", [3, 13]);
  await drain();
  expect(f.timers).toEqual([]);
  expect(f.stampReads).toEqual([]);
});

test("guarded Escape observes only a successful send or signal", async () => {
  const start = source.indexOf('      case "escape": {');
  const body = source.slice(start, source.indexOf('      case "rewind":', start));
  const sent: string[] = [], observed: unknown[] = [];
  let pane: string | null = "ct-claude-test:0.0", fail = false;
  const clock = 1_800_000_000_000;
  const deps = {
    Date: { now: () => clock },
    appServerConversations: new Map(), persistedAppServerThreads: new Map(), latestInjectionTsFor: () => null,
    log: () => {}, resolveCommandSessionId: async () => "sid", detectSessionAgentType: () => "claude",
    resolveSessionCommandPane: async () => ({ tmuxTarget: pane, proc: { pid: 42 } }),
    lastHookStatus: new Map([["sid", { status: "working" }]]), captureTmuxLiveState: async () => ({ state: "busy" }),
    glyphlessPromptPattern: () => null, decideEscape, turnLooksActive,
    tmuxExec: async () => { if (fail) throw Error("send failed"); sent.push("escape"); },
    process: { kill: () => { if (fail) throw Error("signal failed"); sent.push("ctrl-c"); } },
    observeSessionInput: (_id: string, intent: unknown) => observed.push(intent),
  };
  const run = compile(`return async (pressedAt = Date.now()) => { let result, error; const commandArgs = JSON.stringify({ conversation_id: "conv", pressed_at: pressedAt }); switch ("escape") { ${body} } return {result, error}; };`, deps);
  await run(clock - 60_001);
  expect(observed).toEqual([]);
  await run();
  expect(observed).toEqual([{ kind: "escape" }]);
  fail = true;
  await expect(run()).rejects.toThrow("send failed");
  expect(observed).toHaveLength(1);
  pane = null;
  await run();
  expect(observed).toHaveLength(1);
  fail = false;
  await run();
  expect(observed).toEqual([{ kind: "escape" }, { kind: "ctrl-c" }]);
  expect(sent).toEqual(["escape", "ctrl-c"]);
});

test("a failed remote write never arms inference", async () => {
  const f = fixture(false);
  f.remoteWrite("ct-claude-test:0.0", [3]);
  await drain();
  expect(f.timers).toEqual([]);
});

test.skipIf(!hasTmux())("terminal WebSocket delivers observed input through the daemon options on a private tmux server", async () => {
  const f = fixture();
  const target = "ct-claude-test";
  expect(tmuxRun(["new-session", "-d", "-s", target, "-x", "80", "-y", "24", "cat"]).status).toBe(0);
  const server = http.createServer();
  const terminal = attachTerminalServer(server, f.terminalServerOptions());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/term/ws`, { headers: { Origin: "http://localhost:3000" } });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", (raw, binary) => {
        if (binary) return;
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ready") resolve();
        if (msg.type === "error") reject(Error(msg.message));
      });
      socket.once("open", () => socket.send(JSON.stringify({ type: "hello", token: "token", mode: "attach", target: `${target}:0.0`, interactive: true, cols: 80, rows: 24 })));
    });
    expect(writePane(`${target}:0.0`, [...Buffer.from("recorded input\r")])).toBe(true);
    expect(writePane("ct-claude-missing:0.0", [3])).toBe(false);
    socket.send(Buffer.from([3]));
    for (let i = 0; i < 100 && f.timers.length === 0; i++) await Bun.sleep(20);
    expect(f.timers).toHaveLength(1);
    expect(f.keystrokeInference.flushPending("sid")).toBe("interrupted");
    expect(f.writes[0][1]).toBe("idle");
  } finally {
    socket.terminate();
    terminal.close();
    server.closeAllConnections();
    server.close();
    tmuxRun(["kill-session", "-t", target]);
  }
}, 20_000);
