import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// getConversationPendingMessage reports the newest SETTLED row when nothing is
// in flight, so a lagging transcript keeps its bubble. The composer's stuck
// tracker must read that row as nothing pending: treating it as in flight
// showed "Disconnected · Cancel" (and fired an auto-resume) for ten minutes
// after every delivered message on an idle, healthy session.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000settled"; // 32 chars => isConvexId

function fakeConvex() {
  const client = new ConvexReactClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({
    onUpdate: () => () => {},
    localQueryResult: () => undefined,
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  return client;
}

const commands: string[] = [];

beforeEach(() => {
  commands.length = 0;
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    convCommand: async (_id: string, command: string) => { commands.push(command); return undefined; },
    sessions: {},
    conversations: {},
    pendingMessages: {},
    drafts: {},
    currentSessionId: null,
    currentUser: { _id: "user_settled_test", name: "Tester" } as any,
  } as any);
});

async function composerStatusFor(status: string): Promise<string> {
  // Past every stuck threshold (30-120s) and inside the 10 minute window.
  const createdAt = Date.now() - 3 * 60_000;
  useInboxStore.setState({
    pendingMessageStatus: {
      [CONV_ID]: { _id: CONV_ID, conversation_id: CONV_ID, message_id: "pm_settled_1", client_id: "c1", created_at: createdAt, retry_count: 0, status, content: "hi" },
    },
  } as any);
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" sessionId="sess_settled" agentType="claude_code" agentStatus={"idle" as any} isSessionReady />
      </ConvexProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const text = container.querySelector("[data-cc-composer-meta]")?.textContent ?? "";
  await act(async () => { root.unmount(); });
  container.remove();
  return text;
}

test("an in-flight row past the threshold raises the stuck banner and resumes (control)", async () => {
  expect(await composerStatusFor("pending")).toContain("Cancel");
  expect(commands).toContain("resumeSession");
});

for (const status of ["delivered", "cancelled"]) {
  test(`a ${status} row is not a stuck message`, async () => {
    const text = await composerStatusFor(status);
    expect(text).not.toContain("Disconnected");
    expect(text).not.toContain("Cancel");
    expect(text).toContain("Ready");
    expect(commands).toEqual([]);
  });
}
