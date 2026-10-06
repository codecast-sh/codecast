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
import { formatPendingComments } from "../../lib/quoteFormat";
// Entered from the composer, the graph reaches ChatMessage through
// messageMarkdown -> EntityIdPill -> TaskCommentStream, and ChatMessage reads
// MESSAGE_MD_COMPONENTS at its top level while messageMarkdown is still
// evaluating (a TDZ ReferenceError; markdownMapCycles.guard.test.ts names
// the cycle). Entering from ChatMessage closes the cycle on a lazy read.
import "../chat/ChatMessage";

// A gated composer (onGateSend: a comment on a commit, the org page's thread
// column beside a proposal) sends through its host, not the session rail.
// The pending batch (quotes, and a proposal's answers, org-staffing.md S39)
// must ride that send the way it rides the ordinary one: taken on submit,
// leading the body, so a bare Enter over a non-empty batch is a send and the
// host receives words. Before this, the gate branch returned on an empty
// input before looking at the batch, and the tray's answers went nowhere.
// Run: bun test components/__tests__/composerGateSendBatch.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000gatebat"; // 32 chars => isConvexId

function fakeConvex() {
  const client = new ConvexReactClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: "user_gate_test", name: "Tester" } as any } as any);
});

async function submitGated(agentType?: string, gated = true): Promise<string[]> {
  const sent: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" agentType={agentType} onGateSend={gated ? (content) => { sent.push(content); } : undefined} />
      </ConvexProvider>,
    );
  });
  const form = container.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () => { root.unmount(); });
  container.remove();
  return sent;
}

test("a bare submit over a waiting quote sends the quote through the gate and clears the batch", async () => {
  const quote = { id: "q1", messageId: "m1", blockIndex: 0, quote: "the line under review", body: "tighten this", createdAt: 1 };
  useInboxStore.getState().addReviewComment(CONV_ID, quote);
  const sent = await submitGated();
  expect(sent).toEqual([formatPendingComments([quote])]);
  expect(useInboxStore.getState().reviewComments[CONV_ID] ?? []).toEqual([]);
});

test("a bare submit with nothing waiting sends nothing", async () => {
  expect(await submitGated()).toEqual([]);
});

// The hosted assistant reads no images: a send carrying one is refused before
// the composer clears, through the gate or the main path, and the person keeps
// the image and can describe it instead. Before this, an image-only gate send
// emptied the composer and the image was gone with nothing sent.
test("a hosted gate send with an image sends nothing and keeps the draft's image", async () => {
  const image = { storageId: "st_img_1", name: "shot.png", type: "image/png", previewUrl: "blob:x" };
  useInboxStore.setState({ drafts: { [CONV_ID]: { draft_image_storage_ids: [image] } } } as any);
  expect(await submitGated("codecast")).toEqual([]);
  expect((useInboxStore.getState().drafts[CONV_ID] as any)?.draft_image_storage_ids?.[0]?.storageId).toBe("st_img_1");
});

test("a hosted main-path send with a restored image adds no message and keeps the image", async () => {
  const image = { storageId: "st_img_3", name: "shot.png", type: "image/png", previewUrl: "blob:z" };
  useInboxStore.setState({ drafts: { [CONV_ID]: { draft_image_storage_ids: [image] } } } as any);
  await submitGated("codecast", false);
  expect(useInboxStore.getState().pendingMessages[CONV_ID] ?? []).toEqual([]);
  expect((useInboxStore.getState().drafts[CONV_ID] as any)?.draft_image_storage_ids?.[0]?.storageId).toBe("st_img_3");
});

test("for a local agent the same image rides the gate send", async () => {
  const image = { storageId: "st_img_2", name: "shot.png", type: "image/png", previewUrl: "blob:y" };
  useInboxStore.setState({ drafts: { [CONV_ID]: { draft_image_storage_ids: [image] } } } as any);
  expect(await submitGated("claude_code")).toEqual([""]);
});
