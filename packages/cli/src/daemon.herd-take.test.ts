import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { liveOutsideTmux } from "./daemon.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

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
});

describe("the swap hold", () => {
  test("keeps a delivery pending before it can resolve a live target or resume", () => {
    const deliver = functionBlock(source, "deliverMessageIntoSession").text;
    const hold = deliver.indexOf("swapHeld(sessionId)");
    expect(hold).toBeGreaterThan(deliver.indexOf("let sessionId = reverseCache[conversationId]"));
    expect(hold).toBeLessThan(deliver.indexOf("resolveLiveTmuxTarget("));
    expect(hold).toBeLessThan(deliver.indexOf("autoResumeSession("));
    expect(deliver.slice(hold, hold + 400)).toContain("return false;");
  });

  test("is checked first in autoResumeSession", () => {
    const resume = functionBlock(source, "autoResumeSession").text;
    expect(resume.indexOf("swapHeld(sessionId)")).toBeGreaterThan(0);
    expect(resume.indexOf("swapHeld(sessionId)")).toBeLessThan(resume.indexOf("resumeInFlight.get(sessionId)"));
  });
});

describe("the take route", () => {
  test("refuses a tokenless post even while the legacy hook grace is open", () => {
    const at = source.indexOf("req.url === HERD_TAKE_PATH");
    expect(source.slice(at, at + 400)).toContain("!admitted.ok || admitted.legacy");
  });
});
