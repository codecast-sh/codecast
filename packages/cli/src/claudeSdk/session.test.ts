// ClaudeSdkSession against a scripted message stream, for what the recordings
// cannot replay on cue: a turn Claude starts on its own.

import { expect, test } from "bun:test";
import { ClaudeSdkSession } from "./session.js";
import type { SdkActivity } from "./protocol.js";

function scripted() {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let interrupts = 0;
  const push = (m: any) => { queue.push(m); wake?.(); };
  const query: any = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift();
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  })();
  query.initializationResult = async () => ({ commands: [], account: {}, claude_code_version: "2.1.319" });
  query.interrupt = async () => { interrupts++; };
  query.close = () => {};
  return { push, query, interrupts: () => interrupts };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("a turn Claude starts itself reads as working, can be interrupted, and settles", async () => {
  const s = scripted();
  const session = new ClaudeSdkSession({ sessionId: "s-0000000001" } as any, () => s.query);
  const activity: SdkActivity[] = [];
  session.on("activity", (a) => activity.push(a));
  await session.ready;
  s.push({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s-0000000001" });
  await tick();
  expect(session.running).toBe(true);
  expect(activity.at(-1)?.status).toBe("working");
  const interrupted = session.interrupt();
  await tick();
  expect(s.interrupts()).toBe(1);
  s.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: [], session_id: "s-0000000001", uuid: "r1" });
  s.push({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s-0000000001" });
  await interrupted;
  await tick();
  expect(session.running).toBe(false);
  expect(session.status).toBe("idle");
  expect(activity.at(-1)).toMatchObject({ status: "idle" });
});

test("a message folded into a turn Claude started itself does not end that turn early", async () => {
  const s = scripted();
  const session = new ClaudeSdkSession({ sessionId: "s-0000000002" } as any, () => s.query);
  const activity: SdkActivity[] = [];
  session.on("activity", (a) => activity.push(a));
  await session.ready;
  s.push({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s-0000000002" });
  await tick();
  const uuid = session.send("also do this");
  s.push({ type: "command_lifecycle", command_uuid: uuid, state: "completed", session_id: "s-0000000002" });
  await tick();
  expect(activity.some((a) => a.turnCompletedAt)).toBe(false);
  expect(session.running).toBe(true);
  s.push({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-0000000002", uuid: "r2" });
  s.push({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s-0000000002" });
  await tick();
  expect(activity.filter((a) => a.turnCompletedAt).length).toBe(1);
  expect(session.running).toBe(false);
});

test("a mode set by codecast shows in the next report and in the session's mode, before Claude announces it", async () => {
  const s = scripted();
  const modes: string[] = [];
  s.query.setPermissionMode = async (m: string) => { modes.push(m); };
  const session = new ClaudeSdkSession({ sessionId: "s-0000000003" } as any, () => s.query);
  const activity: SdkActivity[] = [];
  session.on("activity", (a) => activity.push(a));
  await session.ready;
  s.push({ type: "system", subtype: "init", permissionMode: "bypassPermissions", model: "opus", slash_commands: [], session_id: "s-0000000003" });
  s.push({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s-0000000003" });
  await tick();
  expect(activity.at(-1)?.permissionMode).toBe("bypassPermissions");
  await session.setPermissionMode("default");
  expect(modes).toEqual(["default"]);
  expect(session.init?.permissionMode).toBe("default");
  expect(activity.at(-1)).toMatchObject({ status: "working", permissionMode: "default" });
});
