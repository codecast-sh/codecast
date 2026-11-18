// A stand-in for `grok agent stdio`: the ACP calls the direct host makes
// (initialize, session/new, session/load, session/prompt, session/cancel), with
// grok's own shapes as recorded live against grok 1.0.89 (2026-11-18). Each
// prompt's text picks what it does:
//   contains PERMISSION: asks session/request_permission first (unless the session is always-approve)
//   contains SLOW: runs until session/cancel, then ends `cancelled`
//   contains FAIL: answers the prompt with a JSON-RPC error
//   anything else: a tool call, then "pong", then end_turn
// Every request it takes is appended to $FAKE_GROK_LOG as one JSON line.

import * as fs from "node:fs";
import * as readline from "node:readline";

const logFile = process.env.FAKE_GROK_LOG;
const record = (entry: unknown) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\n"); };
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const update = (sessionId: string, u: Record<string, unknown>) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

let nextId = 1000;
const asked = new Map<number, (result: any) => void>();
const yolo = new Map<string, boolean>();
const cancels = new Map<string, () => void>();
const queue = new Map<string, Promise<void>>();

async function runPrompt(id: number, params: any): Promise<void> {
  const sessionId = params.sessionId as string;
  const text = (params.prompt as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
  if (text.includes("FAIL")) {
    write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required: sign in with grok login" } });
    return;
  }
  if (text.includes("PERMISSION") && !yolo.get(sessionId)) {
    const askId = nextId++;
    const answer = await new Promise<any>((resolve) => {
      asked.set(askId, resolve);
      write({ jsonrpc: "2.0", id: askId, method: "session/request_permission", params: {
        sessionId,
        toolCall: { toolCallId: "call-perm-1", title: "run_terminal_command", kind: "execute", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      } });
    });
    record({ permissionAnswer: answer });
  }
  if (text.includes("SLOW")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-slow", title: "run_terminal_command", rawInput: { command: "sleep 60" } });
    await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
    cancels.delete(sessionId);
    write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    return;
  }
  update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command", rawInput: { command: "echo pong" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } });
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && !msg.method) {
    asked.get(msg.id)?.(msg.result);
    asked.delete(msg.id);
    return;
  }
  record({ method: msg.method, params: msg.params, argv: process.argv.slice(2), sdkSession: process.env.CODECAST_SDK_SESSION ?? null });
  switch (msg.method) {
    case "initialize":
      return write({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { agentVersion: "1.0.89", modelState: { currentModelId: "grok-4.7" } } } });
    case "session/new": {
      const sessionId = "01a1f000-0000-7000-8000-000000000001";
      yolo.set(sessionId, msg.params?._meta?.yoloMode === true);
      return write({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    }
    case "session/load":
      yolo.set(msg.params.sessionId, msg.params?._meta?.yoloMode === true);
      update(msg.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" } });
      return write({ jsonrpc: "2.0", id: msg.id, result: {} });
    case "session/prompt": {
      // grok runs a prompt sent during a turn as the next turn.
      const sid = msg.params.sessionId as string;
      const run = (queue.get(sid) ?? Promise.resolve()).then(() => runPrompt(msg.id, msg.params));
      queue.set(sid, run.catch(() => {}));
      return;
    }
    case "session/cancel":
      cancels.get(msg.params.sessionId)?.();
      return;
    case "session/set_config_option":
      return write({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    default:
      if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
