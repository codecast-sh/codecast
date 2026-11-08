// The daemon wiring of the Claude backend switch (claudeSdk/switchBackend.ts):
// while a switch moves a session, nothing else may start it. The order is
// tested with the module; these guard that every way the daemon resumes a
// session asks the hold first.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf8");
const block = (start: string) => {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf("\n}\n", i));
};

describe("backend switch hold in the daemon", () => {
  test("autoResumeSession refuses a held session before either backend's resume, except the switch's own", () => {
    const fn = block("async function autoResumeSession(");
    const hold = fn.indexOf("backendSwitchHeld(sessionId, conversationId)");
    expect(hold).toBeGreaterThan(-1);
    expect(fn.slice(hold - 60, hold)).toContain("!opts?.duringBackendSwitch");
    expect(hold).toBeLessThan(fn.indexOf("claudeSdkBackend.ensure("));
    expect(hold).toBeLessThan(fn.indexOf("resumeInFlight.get(sessionId)"));
  });

  test("the SDK backend's own resume asks the hold", () => {
    expect(src).toMatch(/mayResume: async \(convId, sessionId, userInitiated\) => !backendSwitchHeld\(convId, sessionId\) && resumeAllowed/);
  });

  test("the switch holds both the conversation and the session, and resumes tmux past its own hold", () => {
    const fn = block("async function switchConversationBackend(");
    expect(fn).toContain("holdKeys: [conversationId, sessionId]");
    expect(fn).toContain("duringBackendSwitch: true");
    // Messages go back to pending through the requeue step, never from stop.
    const stop = fn.slice(fn.indexOf("stop: async"), fn.indexOf("startSdk:"));
    expect(stop).not.toContain("clearConversationDeliveryAndResumeState");
    expect(fn).toContain('requeue: () => clearConversationDeliveryAndResumeState(conversationId, sessionId, "BACKEND-SWITCH")');
  });

  test("delivery defers and repair stands down while a switch holds the conversation", () => {
    expect(block("async function deliverMessageIntoSession(")).toContain("if (backendSwitchHeld(conversationId)) throw new BackendSwitchHoldError();");
    // Held, not failed: retried at its own pace without spending the retry budget.
    expect(src).toMatch(/err instanceof TerminalHoldError \|\| err instanceof BackendSwitchHoldError\) \{/);
    const repair = block("async function repairAndResumeSession(");
    expect(repair.indexOf("backendSwitchHeld(sessionId, conversationId)")).toBeLessThan(repair.indexOf("repairInFlight.get(sessionId)"));
  });

  test("a kill cancels a switch in progress and waits for it to let go; a park is refused during one", () => {
    const kill = src.slice(src.indexOf('case "kill_session": {'), src.indexOf('case "hibernate_session": {'));
    expect(kill).toContain("await cancelBackendSwitch(conversationId, sessionIdHint)");
    const park = src.slice(src.indexOf('case "hibernate_session": {'), src.indexOf("hibernateSessionNow(sessionId, conversationId)"));
    expect(park).toContain("if (backendSwitchHeld(sessionId, conversationId)) {");
    expect(park).not.toContain("cancelBackendSwitch");
  });

  test("a Restart or agent switch is refused while a switch holds the session, and the switch runs off the command queue", () => {
    const resume = src.slice(src.indexOf('case "resume_session": {'));
    const hold = resume.indexOf("if (backendSwitchHeld(sessionId, conversationId)) {");
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(resume.indexOf("claudeSdkBackend?.owns(conversationId) && !parsed.fork"));
    expect(hold).toBeLessThan(resume.indexOf("force_reconstitute"));
    expect(src).toMatch(/DETACHED_COMMANDS: ReadonlySet<string> = new Set\(\[[^\]]*"switch_claude_backend"/);
  });
});
