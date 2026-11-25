// ct-101376: with a teammate's chat open above the session composer, a person
// typed 42 characters into the agent's box ("Send a message...") and then sent
// the same 42 characters to the teammate: the two boxes look alike and only the
// teammate's says who it sends to. With the chat open, each box names its
// recipient, so a glance tells them apart.
// Run: bun test components/__tests__/composerTeammateChatRecipient.mount.test.tsx
import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
// See composerGateSendBatch.mount.test.tsx: entering from ChatMessage closes a module cycle.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const CONV_ID = "jx70000000000000000000000chatrcp"; // 32 chars => isConvexId
const TEAM = "t".repeat(32);
const ME = "u".repeat(32);
const PEER = { _id: "p".repeat(32), name: "Ashot Petrosian" } as any;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

const nameOf = (el: HTMLTextAreaElement) => el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";

test("with a teammate's chat open, the agent composer and the chat box each name who they send to", async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null,
    currentUser: { _id: ME, name: "Me" },
    teams: [{ _id: TEAM, name: "Union", features: { chat: true } }],
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: TEAM } },
    chatChannels: {}, chatRail: [],
    dispatchOpenDm: () => Promise.resolve(undefined),
  } as any);

  const { MessageInput } = await import("../MessageInput");
  const { ConversationChat } = await import("../conversation/ConversationChat");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ConvexProvider client={fakeConvex()}>
          <MemoryRouter>
            <MessageInput conversationId={CONV_ID} status="active" agentType="claude_code" agentStatus="idle"
              composerNode={<ConversationChat conversationId={CONV_ID} people={[PEER]} />} />
          </MemoryRouter>
        </ConvexProvider>,
      );
    });
    const chip = w.document.querySelector(".cc-chat-chip");
    expect(chip).not.toBeNull();
    await act(async () => { chip.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const boxes = [...w.document.querySelectorAll("textarea")] as HTMLTextAreaElement[];
    const chatBox = boxes.find((b) => w.document.querySelector(".cc-chat-panel")?.contains(b));
    const agentBox = boxes.find((b) => container.contains(b) && b !== chatBox);
    expect(chatBox).toBeDefined();
    expect(agentBox).toBeDefined();
    // The teammate's box already names its recipient.
    expect(nameOf(chatBox!)).toContain("Ashot Petrosian");
    // The agent's box must too: "Send a message..." names nobody, and beside
    // "Message Ashot Petrosian" it reads as the same kind of box.
    expect(nameOf(agentBox!)).toMatch(/claude|agent/i);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
}, 60_000);
