import { describe, expect, test } from "bun:test";
import { FENCED_RUNTIME_CAPABILITIES } from "@codecast/shared/contracts";
import type { RuntimeAdoptionRequest, RuntimeStartRequest } from "../types.js";
import {
  buildFencedTmuxTags,
  FENCED_TMUX_TAG_NAMES,
  ManagedTmuxRuntimeDriver,
  type ManagedTmuxCandidate,
  type ManagedTmuxIo,
} from "./managedTmux.js";

function request(): RuntimeStartRequest {
  return {
    target: {
      conversationId: "conversation-1",
      epoch: 4,
      requestedAgent: "claude",
      transport: "tmux",
      projectPath: "/tmp/project",
    },
    configuration: { revision: 9, model: "opus" },
    ownerDeviceId: "device-1",
    daemonBootId: "boot-1",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger: "recovery",
    operationId: "operation-1",
  };
}

function fakeIo(candidates: ManagedTmuxCandidate[] = []) {
  const events: string[] = [];
  const options: Record<string, string> = {};
  const io: ManagedTmuxIo = {
    async createSession() { events.push("create"); },
    async setSessionOption({ name, value }) {
      events.push(`tag:${name}`);
      options[name] = value;
    },
    async launchLiteral() { events.push("launch"); },
    async listCandidates() { return candidates; },
    async injectDelivery() { return { state: "delivered" }; },
    async stopSession() {},
    async quarantineSession() {},
  };
  return { io, events, options };
}

describe("ManagedTmuxRuntimeDriver", () => {
  test("writes every fence tag before launching the executable", async () => {
    const { io, events, options } = fakeIo();
    const driver = new ManagedTmuxRuntimeDriver({
      io,
      buildLaunch: () => ({ command: "claude --session-id session-1" }),
      runtimeIdForOperation: () => "runtime-1",
      sessionNameFactory: () => "cc-f1-test",
    });

    const result = await driver.start(request());
    expect(result.state).toBe("started");
    expect(events[0]).toBe("create");
    expect(events.at(-1)).toBe("launch");
    expect(events.slice(1, -1)).toHaveLength(Object.keys(FENCED_TMUX_TAG_NAMES).length);
    expect(options[FENCED_TMUX_TAG_NAMES.operationId]).toBe("operation-1");
    expect(options[FENCED_TMUX_TAG_NAMES.executionEpoch]).toBe("4");
    expect(options[FENCED_TMUX_TAG_NAMES.agent]).toBe("claude");
    expect(options[FENCED_TMUX_TAG_NAMES.configurationRevision]).toBe("9");
  });

  test("adopts only one live candidate with every exact tag", async () => {
    const adoption = request() as RuntimeAdoptionRequest;
    const exactTags = buildFencedTmuxTags(adoption, "runtime-1");
    const exact: ManagedTmuxCandidate = {
      tmuxSession: "cc-f1-exact",
      tmuxTarget: "cc-f1-exact:0.0",
      alive: true,
      tags: exactTags,
    };
    const { io } = fakeIo([exact]);
    const driver = new ManagedTmuxRuntimeDriver({ io, buildLaunch: () => ({ command: "claude" }) });

    const result = await driver.adopt(adoption);
    expect(result).toMatchObject({
      state: "adopted",
      handle: {
        runtimeId: "runtime-1",
        handle: "cc-f1-exact:0.0",
        actualAgent: "claude",
      },
    });
  });

  test("wrong epoch or agent tags conflict instead of being adopted or treated as missing", async () => {
    const adoption = request() as RuntimeAdoptionRequest;
    const wrongEpoch = {
      ...buildFencedTmuxTags(adoption, "runtime-old"),
      executionEpoch: "3",
    };
    const wrongAgent = {
      ...buildFencedTmuxTags(adoption, "runtime-wrong-agent"),
      agent: "codex",
    };
    const { io } = fakeIo([
      { tmuxSession: "old", tmuxTarget: "old:0.0", alive: true, tags: wrongEpoch },
      { tmuxSession: "wrong", tmuxTarget: "wrong:0.0", alive: true, tags: wrongAgent },
    ]);
    const driver = new ManagedTmuxRuntimeDriver({ io, buildLaunch: () => ({ command: "claude" }) });

    const result = await driver.adopt(adoption);
    expect(result.state).toBe("conflict");
    if (result.state === "conflict") {
      expect(result.conflictingHandles).toEqual(["old:0.0", "wrong:0.0"]);
    }
  });

  test("absence of any live tagged candidate is the only safe missing result", async () => {
    const dead: ManagedTmuxCandidate = {
      tmuxSession: "dead",
      tmuxTarget: "dead:0.0",
      alive: false,
      tags: buildFencedTmuxTags(request(), "runtime-dead"),
    };
    const { io } = fakeIo([dead]);
    const driver = new ManagedTmuxRuntimeDriver({ io, buildLaunch: () => ({ command: "claude" }) });
    expect(await driver.adopt(request())).toEqual({ state: "missing" });
  });

  test("candidate lookup failure is unknown and can never authorize a new start", async () => {
    const { io } = fakeIo();
    io.listCandidates = async () => { throw new Error("tmux server unavailable"); };
    const driver = new ManagedTmuxRuntimeDriver({ io, buildLaunch: () => ({ command: "claude" }) });
    expect(await driver.adopt(request())).toMatchObject({
      state: "unknown",
      failure: { code: "TMUX_INSPECTION_FAILED" },
    });
  });

  test("an untagged deterministic operation session blocks recovery instead of looking missing", async () => {
    const untagged: ManagedTmuxCandidate = {
      tmuxSession: "cc-f1-claude-suspect",
      tmuxTarget: "cc-f1-claude-suspect:0.0",
      alive: true,
      tags: {},
    };
    const { io } = fakeIo([untagged]);
    let lookup: Parameters<ManagedTmuxIo["listCandidates"]>[0] | undefined;
    io.listCandidates = async (input) => {
      lookup = input;
      return [untagged];
    };
    const driver = new ManagedTmuxRuntimeDriver({ io, buildLaunch: () => ({ command: "claude" }) });

    const result = await driver.adopt(request());
    expect(result.state).toBe("conflict");
    expect(lookup).toMatchObject({
      conversationId: "conversation-1",
      operationId: "operation-1",
    });
    expect(lookup?.expectedTmuxSession).toContain("operation-1");
  });
});
