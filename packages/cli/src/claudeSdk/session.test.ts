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
