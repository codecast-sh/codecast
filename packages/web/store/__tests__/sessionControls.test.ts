import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { convHasPendingSend, isSessionEffectivelyIdle, useInboxStore } from "../inboxStore";

const ID = "a".repeat(32);
const store = () => useInboxStore.getState();

describe("session controls use the default optimistic store path", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: { [ID]: {
        _id: ID, session_id: "session-a", agent_type: "claude_code", agent_status: "working",
        permission_mode: "default", is_idle: false, has_pending: false, message_count: 2,
        updated_at: Date.now(),
      } },
      conversations: {}, messages: {}, pendingMessages: {}, pending: {}, pagination: {},
    });
    store()._setDispatch(async () => null);
  });

  afterEach(() => store()._clearRuntimeBindings());

  it("stops locally and adds the interruption line before the dispatch resolves", async () => {
    let acknowledge!: () => void;
    store()._setDispatch(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const request = store().convCommand(ID, "sendEscapeToSession");
    expect(store().sessions[ID].agent_status).toBe("idle");
    expect(isSessionEffectivelyIdle(store().sessions[ID])).toBe(true);
    expect(store().pendingMessages[ID]).toHaveLength(1);
    expect(store().pendingMessages[ID][0].content).toBe("[Request interrupted by user]");
    expect(convHasPendingSend(store().pendingMessages[ID])).toBe(false);
    expect(store().pending[`sessions:${ID}:agent_status`]?.value).toBe("idle");
    acknowledge();
    await request;
  });

  it("protects local state from both overlay paths until the daemon echoes it", async () => {
    await store().sendEscape(ID);
    store().applyInboxLivenessPayload("mine", { [ID]: { agent_status: "working", is_idle: false } });
    expect(store().sessions[ID].agent_status).toBe("idle");
    expect(store().sessions[ID].is_idle).toBe(true);
    store().syncOverlay("sessions", { [ID]: { agent_status: "thinking", is_idle: false } });
    expect(store().sessions[ID].agent_status).toBe("idle");
    store().applyInboxLivenessPayload("mine", { [ID]: { agent_status: "idle", is_idle: true } });
    expect(store().pending[`sessions:${ID}:agent_status`]).toBeUndefined();
    store().applyInboxLivenessPayload("mine", { [ID]: { agent_status: "working", is_idle: false } });
    expect(store().sessions[ID].agent_status).toBe("working");
  });

  it("does not create a pending-state write on an unchanged overlay", () => {
    const pending = store().pending;
    store().syncOverlay("sessions", { [ID]: { agent_status: "working" } });
    expect(store().pending).toBe(pending);
    store().applyInboxLivenessPayload("mine", { [ID]: { agent_status: "working", is_idle: false } });
    expect(store().pending).toBe(pending);
  });

  for (const channel of ["snapshot", "tail", "recovery"] as const) {
    for (const content of ["[Request interrupted by user]", "[Request interrupted by user for tool use]", "<turn_aborted>\nThe user interrupted the previous turn."]) {
      it(`reconciles the ${channel} interruption echo without a duplicate: ${content.slice(0, 30)}`, async () => {
        await store().sendEscape(ID);
        const timestamp = store().pendingMessages[ID][0].timestamp + 1;
        const messages = [{ _id: "server-interrupt", role: "user", content, timestamp }];
        if (channel === "snapshot") store().setMessages(ID, messages);
        if (channel === "tail") store().applyTailMessages(ID, timestamp - 10, messages, timestamp);
        if (channel === "recovery") store().mergeMessages(ID, messages, "append");
        expect(store().pendingMessages[ID]).toHaveLength(0);
        expect(store().messages[ID]).toHaveLength(1);
      });
    }
  }

  it("changes permission mode immediately and uses normal echo protection", async () => {
    const command = store().convCommand(ID, "sendKeysToSession", { keys: "BTab" }, { permission_mode: "plan" });
    expect(store().sessions[ID].permission_mode).toBe("plan");
    store().syncOverlay("sessions", { [ID]: { permission_mode: "default" } });
    expect(store().sessions[ID].permission_mode).toBe("plan");
    store().syncOverlay("sessions", { [ID]: { permission_mode: "plan" } });
    expect(store().pending[`sessions:${ID}:permission_mode`]).toBeUndefined();
    await command;
  });

  it("does not mistake an earlier interruption for the new command's echo", async () => {
    const timestamp = store().sessions[ID].updated_at + 1;
    const messages = [{ _id: "older-interrupt", role: "user", content: "[Request interrupted by user]", timestamp }];
    store().setMessages(ID, messages);
    await store().sendEscape(ID);
    store().setMessages(ID, messages);
    expect(store().pendingMessages[ID]).toHaveLength(1);
  });

  it("protects model selection through the standard action decorator", () => {
    store().syncRecord("conversations", ID, { _id: ID, model: "claude-sonnet", effort: "medium" });
    store().setConversationModel(ID, { model: "claude-opus", effort: "high" });
    store().syncRecord("conversations", ID, { _id: ID, model: "claude-sonnet", effort: "medium" });
    expect(store().conversations[ID]).toMatchObject({ model: "claude-opus", effort: "high" });
    store().syncRecord("conversations", ID, { _id: ID, model: "claude-opus", effort: "high" });
    expect(store().pending[`conversations:${ID}:model`]).toBeUndefined();
  });

  it("continues to classify actual pending messages as sends", () => {
    const id = store().addOptimisticMessage(ID, "Keep going");
    expect(convHasPendingSend(store().pendingMessages[ID])).toBe(true);
    store().markOptimisticAsFailed(ID, id);
    expect(convHasPendingSend(store().pendingMessages[ID])).toBe(false);
  });

});
