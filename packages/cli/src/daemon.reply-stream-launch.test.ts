// Live replies ride a `--settings <file>` on the claude sessions the daemon
// launches in tmux and resumes (replyStream.ts). Only while the team feature
// is on, and only for claude.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { buildClaudeResumeCommand, daemonHookIngressDeps, mirrorReplyStreaming, replyStreamFragment, replyStreamLaunchForTests } from "./daemon.js";
import type { MessageDisplayBatch } from "./replyStream.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import { strictStub } from "./test-helpers/strictStub.js";

const dir = mkdtempSync(join(tmpdir(), "reply-stream-launch-"));
const SETTINGS = "/Users/O'Brien Smith/.codecast/reply-stream-settings.json";
const FRAGMENT = ` --settings '/Users/O'\\''Brien Smith/.codecast/reply-stream-settings.json'`;
const realEnsure = replyStreamLaunchForTests.ensure;

function feature(on: boolean, path: string | null = SETTINGS) {
  replyStreamLaunchForTests.on = on;
  replyStreamLaunchForTests.ensure = async () => path;
}

afterEach(() => {
  replyStreamLaunchForTests.on = false;
  replyStreamLaunchForTests.ensure = realEnsure;
  replyStreamLaunchForTests.tracker = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function resumeCmd(config: Record<string, unknown> | null = null) {
  const jsonlPath = join(dir, "t.jsonl");
  writeFileSync(jsonlPath, "");
  const built = await buildClaudeResumeCommand({
    sessionId: "11111111-2222-3333-4444-555555555555", cwd: dir, jsonlPath, jsonlContent: "", config: config as never,
  });
  return built.resumeCmd;
}

describe("the claude resume command", () => {
  test("carries the settings file while the feature is on", async () => {
    feature(true);
    expect((await resumeCmd()).endsWith(FRAGMENT)).toBe(true);
  });

  test("carries nothing while it is off", async () => {
    feature(false);
    expect(await resumeCmd()).not.toContain("--settings");
  });

  test("carries nothing when the file could not be written", async () => {
    feature(true, null);
    expect(await resumeCmd()).not.toContain("--settings");
  });

  test("leaves the person's own --settings alone", async () => {
    feature(true);
    const cmd = await resumeCmd({ claude_args: "--settings /Users/me/mine.json" });
    expect(cmd.match(/--settings/g)).toHaveLength(1);
    expect(cmd).toContain("--settings /Users/me/mine.json");
  });
});

describe("the launch fragment", () => {
  test("claude with the feature on", async () => {
    feature(true);
    expect(await replyStreamFragment("claude", "")).toBe(FRAGMENT);
  });

  test("never another agent, never with the feature off", async () => {
    feature(true);
    for (const agent of ["codex", "gemini", "grok", "cursor"]) expect(await replyStreamFragment(agent, "")).toBe("");
    feature(false);
    expect(await replyStreamFragment("claude", "")).toBe("");
  });

  test("start_session appends it to the tmux launch only: after the SDK host branch, before the prompt", () => {
    const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf-8");
    const start = source.indexOf('case "start_session": {');
    const sdk = source.indexOf("await startClaudeSdkSession({", start);
    const tmuxCheck = source.indexOf('error = "tmux is not installed";', sdk);
    const append = source.indexOf("cmdText += await replyStreamFragment(agentType, getConfiguredAgentArgs(agentType, config));", start);
    const prompt = source.indexOf("const launchPrompt = agentType", start);
    const typed = source.indexOf("await typeIntoPane(tmuxSession, cmdText);", start);
    expect([start, sdk, tmuxCheck, append, prompt, typed].every((i) => i > 0)).toBe(true);
    expect(sdk < tmuxCheck && tmuxCheck < append && append < prompt && prompt < typed).toBe(true);
    // Its definition, start_session, the resume command and the two blank launches.
    expect(source.match(/replyStreamFragment\(/g)).toHaveLength(5);
  });

  test("every blank claude launch carries it, so a session streams whichever path started it", () => {
    const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf-8");
    const blankLaunches = source.split("\n").filter((line) => line.includes("const blankCmdText = "));
    expect(blankLaunches).toHaveLength(2);
    for (const line of blankLaunches) expect(line).toContain("${await replyStreamFragment(");
  });
});

describe("the heartbeat's answer", () => {
  function mirror(data: Record<string, unknown>) {
    const saved: boolean[] = [];
    mirrorReplyStreaming(data, (on) => saved.push(on));
    return saved;
  }

  test("reply_streaming: true turns it on and saves it once", () => {
    expect(mirror({ reply_streaming: true })).toEqual([true]);
    expect(replyStreamLaunchForTests.on).toBe(true);
    expect(mirror({ reply_streaming: true })).toEqual([]);
  });

  test("an answer without the field, from an older server, turns it off", () => {
    replyStreamLaunchForTests.on = true;
    expect(mirror({ claude_backend: null })).toEqual([false]);
    expect(replyStreamLaunchForTests.on).toBe(false);
  });

  test("a failed beat leaves it as it was: the mirror reads only a beat that landed, before its commands", () => {
    const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf-8");
    const beat = functionBlock(source, "sendHeartbeat").text;
    const call = beat.indexOf("mirrorReplyStreaming(data, (on) => patchConfig({ reply_streaming: on }));");
    expect(source.match(/mirrorReplyStreaming\(/g)).toHaveLength(2); // the definition and this call
    expect(call).toBeGreaterThan(beat.indexOf("if (!response.ok) {"));
    expect(call).toBeGreaterThan(beat.indexOf("const data = await response.json();"));
    expect(call).toBeLessThan(beat.indexOf("executeCommandBatch(data.commands"));
    expect(beat.indexOf("} catch")).toBeGreaterThan(call);
  });
});

describe("the hook route's handoff", () => {
  const body = (o: Record<string, unknown>) => JSON.stringify({
    cwd: "/x", delta: "Line.\n", final: false, hook_event_name: "MessageDisplay", index: 0, message_id: "m-1",
    prompt_id: "p", scratchpad_dir: "/tmp", session_id: "s-1", transcript_path: "/x/s-1.jsonl", turn_id: "t", ...o,
  });

  test("a MessageDisplay body reaches the tracker parsed; anything else does not", () => {
    const got: MessageDisplayBatch[] = [];
    replyStreamLaunchForTests.tracker = strictStub("tracker", { receive: (b: MessageDisplayBatch) => void got.push(b) });
    const handoff = daemonHookIngressDeps().messageDisplay!;
    handoff(body({}));
    handoff(body({ hook_event_name: "Stop" }));
    handoff("not json");
    expect(got).toEqual([{ session_id: "s-1", message_id: "m-1", index: 0, final: false, delta: "Line.\n" }]);
  });

  test("before the tracker exists, a body is dropped quietly", () => {
    expect(() => daemonHookIngressDeps().messageDisplay!(body({}))).not.toThrow();
  });

  test("the tracker finds a started session's conversation before discovery links it", () => {
    const source = readFileSync(fileURLToPath(new URL("./daemon.ts", import.meta.url)), "utf-8");
    expect(source).toContain("conversationFor: (sessionId) => conversationCache[sessionId] ?? startedConversationOf(startedSessionTmux, sessionId),");
  });
});
