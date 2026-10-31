import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAccountPrefix } from "./ccAccounts.js";
import { HIBERNATE_SUBAGENT_QUIET_MS } from "./hibernation.js";
import { buildClaudeResumeCommand, herdTakeDeps, herdTakeForTests, hibernationConcurrencyForTests, liveOutsideTmux, resetSubagentActivityForTests, typedLaunchLine } from "./daemon.js";
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
  const dir = mkdtempSync(join(tmpdir(), "herd-take-busy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const entry = (role: "user" | "assistant", content: unknown) => JSON.stringify({ type: role, message: { role, content } });
  const transcript = (...lines: string[]) => {
    const file = join(dir, `${randomUUID()}.jsonl`);
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };
  const hook = (id: string, status: string) => herdTakeForTests.lastHookStatus.set(id, { status, ts: 1 } as never);
  /** A fresh session id whose transcript is `file`. */
  const session = (file: string | undefined, status?: string) => {
    const id = randomUUID();
    if (status) hook(id, status);
    return { id, busy: () => herdTakeDeps(() => file).busy(id) };
  };

  test("without a hook report the agent is busy: the pane reconciler's idle is not evidence", async () => {
    expect(await session(transcript(entry("assistant", [{ type: "text", text: "done" }]))).busy()).toMatchObject({ kind: "turn" });
  });

  test("a hook that says the turn is under way is busy", async () => {
    expect(await session(undefined, "working").busy()).toMatchObject({ kind: "turn", detail: "the turn to finish (working)" });
  });

  test("hook idle with a transcript ending in a user prompt is busy: no reply yet", async () => {
    const s = session(transcript(entry("assistant", [{ type: "text", text: "earlier" }]), entry("user", "do the thing")), "idle");
    expect(await s.busy()).toEqual({ kind: "reply", detail: "the turn to finish (no reply yet)" });
  });

  test("hook idle with a transcript ending in a tool result, or a tool call, is busy", async () => {
    const result = entry("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
    expect(await session(transcript(entry("user", "go"), entry("assistant", [{ type: "tool_use", id: "t1" }]), result), "stopped").busy()).toMatchObject({ kind: "reply" });
    expect(await session(transcript(entry("user", "go"), entry("assistant", [{ type: "tool_use", id: "t1" }])), "idle").busy()).toMatchObject({ kind: "reply" });
  });

  test("hook idle with a transcript ending in a reply is idle", async () => {
    expect(await session(transcript(entry("user", "go"), entry("assistant", [{ type: "text", text: "done" }])), "idle").busy()).toBeNull();
  });

  test("hook idle with no transcript to read is idle", async () => {
    expect(await session(undefined, "idle").busy()).toBeNull();
  });

  test("background work and a recent subagent still count", async () => {
    const s = session(undefined, "idle");
    const seen = hibernationConcurrencyForTests.subagentActivityByParent;
    seen.set(s.id, Date.now() - 1000);
    expect(await s.busy()).toMatchObject({ kind: "subagent" });
    seen.set(s.id, Date.now() - HIBERNATE_SUBAGENT_QUIET_MS - 1000);
    expect(await s.busy()).toBeNull();
  });
});

describe("a take launches on the keychain login", () => {
  const dir = mkdtempSync(join(tmpdir(), "herd-take-cmd-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const build = (keychain?: boolean) => {
    const jsonlPath = join(dir, "t.jsonl");
    writeFileSync(jsonlPath, "");
    return buildClaudeResumeCommand({ sessionId: "11111111-2222-3333-4444-555555555555", cwd: dir, jsonlPath, jsonlContent: "", config: null, keychain });
  };

  test("no account prefix and no account attribution, whatever the launch would have used", async () => {
    const taken = await build(true);
    expect(taken.resumeAccountPrefix).toBe("");
    expect(taken.resumeAccount).toBeUndefined();
    expect(taken.resumeCmd).toContain("--resume 11111111-2222-3333-4444-555555555555");
  });

  test("the tmux resume is unchanged: it keeps the prefix launchAccountPrefix gives", async () => {
    const tmux = await build();
    const expected = launchAccountPrefix(undefined);
    expect(tmux.resumeAccountPrefix).toBe(expected.prefix);
    expect(tmux.resumeAccount).toBe(expected.account);
    expect(functionBlock(source, "autoResumeSessionInner").text).toContain("buildClaudeResumeCommand({ sessionId, cwd, jsonlPath, jsonlContent, config, conversationId })");
    expect(functionBlock(source, "resumeLaunchLine").text).toContain("`${a.resumeAccountPrefix}${providerKeySourcePrefix(a.agentType, CONFIG_DIR)}${disclaimPrefix()}${env} ${a.resumeCmd}`");
  });

  test("the live gate holds the keychain login for the copy, and nothing re-marks it under another account", () => {
    const deps = source.slice(source.indexOf("export function herdTakeDeps"), source.indexOf("function startHookServer"));
    expect(deps.match(/markClaudeSessionLive\(/g)).toHaveLength(1);
    expect(deps).toContain("markClaudeSessionLive(herdrPaneName(sessionId));");
  });
});

describe("killing a tmux session whose server the reap already ended", () => {
  test("is logged as already gone, not as a failed kill", () => {
    const kill = functionBlock(source, "killTmuxSessionAndTree").text;
    expect(kill).toContain("if (isTmuxSessionMissingError(err)) log(`[KILL] tmux=${tmuxSession} already gone");
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
