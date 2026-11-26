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
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// ct-101510: a session whose machine has not checked in for 7.5 minutes. The
// header chip says "quiet 7 min", but the send box says nothing, so a person
// types, presses Enter, and learns only after waiting that the message cannot
// reach the agent. The composer must say so at the send box, before the send,
// in the header chip's words and duration; a machine seen a minute ago gets
// no notice.

// The daemon-health clock suppresses every verdict for a minute after module
// load (the cold-load grace). Load it as if the page opened two minutes ago so
// the test judges the machine, not the grace.
const realNow = Date.now;
Date.now = () => realNow() - 2 * 60_000;
await import("../../hooks/useDaemonHealth");
Date.now = realNow;

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000quietmc"; // 32 chars => isConvexId
const DEVICE = "dev_quiet_studio";

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
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

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({
    convCommand: async () => undefined,
    sessions: {},
    conversations: { [CONV_ID]: { _id: CONV_ID, owner_device_id: DEVICE, status: "active" } },
    pendingMessages: {},
    pendingMessageStatus: {},
    drafts: {},
    currentSessionId: null,
    currentUser: { _id: "user_quiet_test", name: "Tester" } as any,
  } as any);
});

async function mountFor(quietMs: number): Promise<{ composer: string; chip: string }> {
  useInboxStore.setState({
    machineRoster: [{ device_id: DEVICE, label: "studio", platform: "darwin", last_seen: Date.now() - quietMs }],
  } as any);
  const { MessageInput } = await import("../MessageInput");
  const { SessionDaemonChip } = await import("../DaemonStatusChip");
  const composerHost = w.document.createElement("div");
  const chipHost = w.document.createElement("div");
  w.document.body.append(composerHost, chipHost);
  const composerRoot = createRoot(composerHost);
  const chipRoot = createRoot(chipHost);
  const convex = fakeConvex();
  await act(async () => {
    composerRoot.render(
      <ConvexProvider client={convex}>
        <MessageInput conversationId={CONV_ID} status="active" sessionId="sess_quiet" agentType="claude_code" agentStatus={"idle" as any} isSessionReady />
      </ConvexProvider>,
    );
    chipRoot.render(
      <ConvexProvider client={convex}>
        <SessionDaemonChip conversationId={CONV_ID} />
      </ConvexProvider>,
    );
  });
  // Advance the shared observer clock to now (a visible tab), past the grace.
  await act(async () => { w.document.dispatchEvent(new w.Event("visibilitychange")); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const composer = composerHost.textContent ?? "";
  const chip = [...chipHost.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ") + (chipHost.textContent ?? "");
  await act(async () => { composerRoot.unmount(); chipRoot.unmount(); });
  composerHost.remove();
  chipHost.remove();
  return { composer, chip };
}

test("a machine quiet for 7.5 minutes is named at the send box, not only in the header chip", async () => {
  const { composer, chip } = await mountFor(7.5 * 60_000);
  // Control: the fixture is the quiet machine the header chip already flags.
  expect(chip).toContain("quiet 7 min");
  // The miss: the composer carries no word of it before the person sends.
  expect(composer).toMatch(/quiet 7 min|hasn't checked in for 7 min/);
});

test("a machine seen a minute ago gets no notice at the send box (guard)", async () => {
  const { composer, chip } = await mountFor(60_000);
  expect(chip).not.toContain("quiet");
  expect(composer).not.toMatch(/quiet \d+ min|hasn't checked in/);
});
