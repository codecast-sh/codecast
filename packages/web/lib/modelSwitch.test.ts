import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { commitModelChange, modelSwitchMessages } from "./modelSwitch";

// A live-session model/effort switch is an ordinary message send: the agent's
// own `/model <alias>` / `/effort <level>` commands ride the composer's
// optimistic bubble + outbox pair. No daemon command, no pending-command
// watcher — delivery, retry, revive-on-dead-session and failure honesty are
// all inherited from the message rail.
const CONV = "conv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("modelSwitchMessages", () => {
  it("maps a claude selection onto the in-session slash commands", () => {
    expect(modelSwitchMessages("claude_code", { model: "opus" })).toEqual(["/model opus"]);
    expect(modelSwitchMessages("claude_code", { effort: "high" })).toEqual(["/effort high"]);
    expect(modelSwitchMessages("claude_code", { model: "haiku", effort: "low" })).toEqual(["/model haiku", "/effort low"]);
    expect(modelSwitchMessages("claude_code", { model: "default" })).toEqual(["/model default"]);
  });

  it("yields nothing for a model the agent can't name", () => {
    expect(modelSwitchMessages("claude_code", { model: "menu:Opus (1M context)" })).toEqual([]);
  });
});

describe("commitModelChange on a live session", () => {
  const sent: Array<{ convId: string; content: string; clientId?: string }> = [];
  beforeEach(() => {
    sent.length = 0;
    useInboxStore.setState({
      sessions: { [CONV]: { _id: CONV, session_id: CONV, model: "claude-fable-5", effort: "high", message_count: 4 } } as any,
      conversations: {},
      pendingMessages: {},
      sendMessage: ((convId: string, content: string, _images?: string[], clientId?: string) => {
        sent.push({ convId, content, clientId });
      }) as any,
    });
  });

  it("stamps the row locally and sends the switch as a message", async () => {
    await commitModelChange({
      conversationId: CONV,
      agentType: "claude_code",
      current: { model: "claude-fable-5", effort: "high" },
      sel: { model: "opus" },
      blank: false,
      notify: () => {},
    });
    const s = useInboxStore.getState();
    expect((s.sessions[CONV] as any).model).toBe("claude-opus");
    const bubbles = s.pendingMessages[CONV] ?? [];
    expect(bubbles.map((m) => m.content)).toEqual(["/model opus"]);
    expect(bubbles[0]._isOptimistic).toBe(true);
    expect(sent).toEqual([{ convId: CONV, content: "/model opus", clientId: bubbles[0]._clientId }]);
  });

  it("sends the effort command on its own message", async () => {
    await commitModelChange({
      conversationId: CONV,
      agentType: "claude_code",
      current: { model: "claude-fable-5", effort: "high" },
      sel: { effort: "low" },
      blank: false,
      notify: () => {},
    });
    expect((useInboxStore.getState().sessions[CONV] as any).effort).toBe("low");
    expect(sent.map((m) => m.content)).toEqual(["/effort low"]);
  });

  it("reverts the stamp and notifies when no command exists for the choice", async () => {
    const notes: string[] = [];
    await commitModelChange({
      conversationId: CONV,
      agentType: "claude_code",
      current: { model: "claude-fable-5", effort: "high" },
      sel: { model: "menu:Opus (1M context)" },
      blank: false,
      notify: (m) => notes.push(m),
    });
    expect((useInboxStore.getState().sessions[CONV] as any).model).toBe("claude-fable-5");
    expect(sent).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});
