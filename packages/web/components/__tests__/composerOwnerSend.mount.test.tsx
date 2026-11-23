import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { setComposerTell } from "../../lib/composerOwnership";
import { closeDomWindow } from "../../test-helpers/domGlobals";
// See composerGateSendBatch.mount.test.tsx: entering from ChatMessage closes a module cycle.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// The session composer's owner line decides where every way out of the box
// goes (lib/composerOwnership composerSendRoute): Enter, ⌘↵ queue and ⇧Esc
// Stop & send take the wheel on Take over and only then; on Tell <role> they
// go to the role's own session (Stop & send has nothing to stop there), and
// the words stay in the box until the server has them. A composer without
// the line (an inline thread) never takes over.
// Run: bun test components/__tests__/composerOwnerSend.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000ownsend"; // 32 chars => isConvexId
const ME = "user_owner_send";
let dispatched: Array<{ action: string; args: any[] }> = [];
let refuseTell = false;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  dispatched = [];
  refuseTell = false;
  setComposerTell(CONV_ID, false);
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => {
    dispatched.push({ action, args });
    if (action === "tellSessionRole" && refuseTell) throw new Error("This role has no standing session yet");
    return undefined;
  });
  useInboxStore.setState({
    sessions: { [CONV_ID]: { _id: CONV_ID, session_id: "s-ownsend", user_id: ME, agent_type: "claude_code", status: "active", org_role_id: "role_send", updated_at: Date.now(), message_count: 3 } },
    conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: ME, name: "Owner" } as any,
  } as any);
});

async function press(text: string, ownerStrip: boolean, how: (container: HTMLElement) => void): Promise<string> {
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  const populate: { current: ((text: string) => void) | null } = { current: null };
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" agentType="claude_code" isThinking isConversationLive onPopulateInput={populate as any}
          onSendEscape={() => {}} ownerStrip={ownerStrip} />
      </ConvexProvider>,
    );
  });
  await act(async () => { populate.current!(text); });
  await act(async () => { how(container); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  const left = (container.querySelector("[data-composer-field]") as HTMLTextAreaElement).value;
  await act(async () => { root.unmount(); });
  container.remove();
  return left;
}

const key = (c: HTMLElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => {
  const ta = c.querySelector("[data-composer-field]") as any;
  const props = ta[Object.keys(ta).find((k) => k.startsWith("__reactProps$"))!];
  props.onKeyDown({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...init, preventDefault() {}, stopPropagation() {}, nativeEvent: { isComposing: false }, currentTarget: ta, target: ta });
};
const enter = (c: HTMLElement) => key(c, { key: "Enter" });
const queue = (c: HTMLElement) => key(c, { key: "Enter", metaKey: true, ctrlKey: true });
const stopAndSend = (c: HTMLElement) => key(c, { key: "Escape", shiftKey: true });
const driver = () => (useInboxStore.getState() as any).sessions[CONV_ID].driver_user_id ?? null;
const sent = (action: string) => dispatched.filter((d) => d.action === action);

test("Take over: Enter sends asking for the wheel, and the row shows the new driver at once", async () => {
  await press("I'll take it from here", true, enter);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(sent("sendMessage")).toHaveLength(1);
  expect(sent("sendMessage")[0].args[5]).toEqual({ take_over: true });
  expect(driver()).toBe(ME);
});

test("Take over: ⌘↵ queues asking for the wheel", async () => {
  await press("after this turn", true, queue);
  expect(sent("queueMessage")[0]?.args[3]).toEqual({ take_over: true });
  expect(driver()).toBe(ME);
});

test("Take over: ⇧Esc stops and sends asking for the wheel", async () => {
  await press("stop, do this", true, stopAndSend);
  const stop = sent("convCommand").find((d) => d.args[1] === "stopAndSendToSession");
  expect(stop?.args[2]).toMatchObject({ content: "stop, do this", take_over: true });
  expect(driver()).toBe(ME);
});

test("Tell: Enter and ⌘↵ go to the role's own session; nothing goes in here and the role keeps driving", async () => {
  setComposerTell(CONV_ID, true);
  expect(await press("try the other fixture", true, enter)).toBe("");
  setComposerTell(CONV_ID, true);
  await press("and the third one", true, queue);
  expect(sent("tellSessionRole").map((d) => d.args[1])).toEqual(["try the other fixture", "and the third one"]);
  expect(sent("sendMessage")).toEqual([]);
  expect(sent("queueMessage")).toEqual([]);
  expect(driver()).toBeNull();
});

test("Tell: ⇧Esc stops nothing, since the words do not go here", async () => {
  setComposerTell(CONV_ID, true);
  expect(await press("stop and tell", true, stopAndSend)).toBe("stop and tell");
  expect(dispatched.filter((d) => d.action !== "upsertDraft")).toEqual([]);
});

test("Tell: a refusal keeps the words in the box", async () => {
  setComposerTell(CONV_ID, true);
  refuseTell = true;
  expect(await press("try the other fixture", true, enter)).toBe("try the other fixture");
  expect(sent("tellSessionRole")).toHaveLength(1);
});

test("a composer without the owner line (an inline thread) never takes over", async () => {
  await press("a reply from the task page", false, enter);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(sent("sendMessage")).toHaveLength(1);
  expect(sent("sendMessage")[0].args[5] ?? null).toBeNull();
  expect(driver()).toBeNull();
});
