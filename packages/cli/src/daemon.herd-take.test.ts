import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { HIBERNATE_SUBAGENT_QUIET_MS } from "./hibernation.js";
import { herdTakeDeps, hibernationConcurrencyForTests, liveOutsideTmux, resetSubagentActivityForTests, typedLaunchLine } from "./daemon.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

afterEach(() => resetSubagentActivityForTests());

describe("a live agent outside tmux is never given a second copy", () => {
  const live = (tmuxTarget: string | null, proc: { pid: number } | null) => ({ tmuxTarget, source: null, proc, cachedStillValid: false }) as Parameters<typeof liveOutsideTmux>[0];

  test("a live process with no tmux target is outside tmux; a tmux target or nothing is not", () => {
    expect(liveOutsideTmux(live(null, { pid: 7 }))).toBe(true);
    expect(liveOutsideTmux(live("cc-x:0.0", { pid: 7 }))).toBe(false);
    expect(liveOutsideTmux(live(null, null))).toBe(false);
  });

  test("both live probes in the shared resume path stop before anything starts a tmux", () => {
    const inner = functionBlock(source, "autoResumeSessionInner").text;
    const fast = inner.indexOf("if (refuseSecondCopy(fastLive)) return false;");
    const full = inner.indexOf("if (refuseSecondCopy(live)) return false;");
    expect(fast).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(fast);
    expect(fast).toBeLessThan(inner.indexOf("awaitRecentSessionFile"));
    expect(full).toBeLessThan(inner.indexOf('"kill-session"'));
    expect(full).toBeLessThan(inner.indexOf('"new-session"'));
  });

  test("a delivery holds its message with a reason instead of failing into the retry ladder", () => {
    const inner = functionBlock(source, "autoResumeSessionInner").text;
    const refuse = inner.slice(inner.indexOf("const refuseSecondCopy"), inner.indexOf("// FAST PATH"));
    expect(refuse).toContain("if (opts?.delivery) throw new SwapHeldError(");
  });
});

describe("the swap hold", () => {
  test("holds a delivery with a reason, without spending its retries, before it can resolve a live target or resume", () => {
    const deliver = functionBlock(source, "deliverMessageIntoSession").text;
    const hold = deliver.indexOf("swapHeld(sessionId)");
    expect(hold).toBeGreaterThan(deliver.indexOf("let sessionId = reverseCache[conversationId]"));
    expect(hold).toBeLessThan(deliver.indexOf("resolveLiveTmuxTarget("));
    expect(hold).toBeLessThan(deliver.indexOf("autoResumeSession("));
    expect(deliver.slice(hold, hold + 400)).toContain("throw new SwapHeldError(");
    expect(source).toContain("err instanceof CloudAgentHoldError || err instanceof SwapHeldError");
  });

  test("is checked first in autoResumeSession", () => {
    const resume = functionBlock(source, "autoResumeSession").text;
    expect(resume.indexOf("swapHeld(sessionId)")).toBeGreaterThan(0);
    expect(resume.indexOf("swapHeld(sessionId)")).toBeLessThan(resume.indexOf("resumeInFlight.get(sessionId)"));
  });

  test("keeps the health check from declaring a swapped session crashed", () => {
    expect(functionBlock(source, "heartbeatHealthCheck").text.indexOf("if (swapHeld(sessionId)) return;")).toBeGreaterThan(0);
    const dead = functionBlock(source, "handleDeadSession").text;
    expect(dead.indexOf("if (swapHeld(sessionId)) return;")).toBeLessThan(dead.indexOf('"kill-session"'));
  });

  test("the take forgets the tmux placement before it kills", () => {
    const kill = source.slice(source.indexOf("    kill: async (tmuxSession, sessionId) => {"));
    const cached = kill.indexOf("resumeSessionCache.delete(sessionId)");
    expect(cached).toBeGreaterThan(0);
    expect(kill.indexOf("registeredTmuxBySession.delete(sessionId)")).toBeGreaterThan(0);
    expect(cached).toBeLessThan(kill.indexOf("killTmuxSessionAndTree("));
  });
});

describe("the take route", () => {
  test("takes the loopback bearer, not the hook token", () => {
    const at = source.indexOf("req.url === HERD_TAKE_PATH");
    const route = source.slice(at, at + 400);
    expect(route).toContain("hookTokenMatches(hookBearerToken(req.headers), terminalToken())");
    expect(route).not.toContain("admitHookIngress");
  });

  test("accepts only a herdr socket of this machine", () => {
    expect(functionBlock(source, "handleHerdTake").text).toContain("(await herdrSocketPaths()).includes(req.socketPath)");
  });
});

describe("the take's busy check (the real dependency)", () => {
  const busy = (id: string) => herdTakeDeps().busy(id);

  test("a session that never ran a subagent is idle", () => {
    expect(busy("never-had-one")).toBeNull();
  });

  test("a subagent active inside the quiet window is busy; once it has been quiet that long the session is idle", () => {
    const id = "had-a-subagent";
    const seen = hibernationConcurrencyForTests.subagentActivityByParent;
    seen.set(id, Date.now() - 1000);
    expect(busy(id)).toMatchObject({ kind: "subagent" });
    seen.set(id, Date.now() - HIBERNATE_SUBAGENT_QUIET_MS - 1000);
    expect(busy(id)).toBeNull();
  });
});

describe("a long launch line", () => {
  test("a short line is typed as it is", () => {
    expect(typedLaunchLine("claude --resume x")).toBe("claude --resume x");
  });

  test("a long one becomes a short line sourcing a private script that holds all of it", () => {
    const long = `echo ${"x".repeat(1500)}`;
    const typed = typedLaunchLine(long);
    expect(typed.length).toBeLessThan(200);
    const file = typed.replace(/^\. '/, "").replace(/'$/, "");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(long);
    unlinkSync(file);
  });
});
