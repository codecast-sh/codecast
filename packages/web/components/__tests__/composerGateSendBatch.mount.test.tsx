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
import { formatPendingComments } from "../../lib/quoteFormat";
// Entered from the composer, the graph reaches ChatMessage through
// messageMarkdown -> EntityIdPill -> TaskCommentStream, and ChatMessage reads
// MESSAGE_MD_COMPONENTS at its top level while messageMarkdown is still
// evaluating (a TDZ ReferenceError; markdownMapCycles.guard.test.ts names
// the cycle). Entering from ChatMessage closes the cycle on a lazy read.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

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
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: "user_gate_test", name: "Tester" } as any } as any);
});

let lastGateImages: Array<{ storageId?: string; mime: string; uploading: boolean }> = [];

async function submitGated(agentType?: string, gated = true): Promise<string[]> {
  const sent: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={CONV_ID} status="active" agentType={agentType} onGateSend={gated ? (content, images) => { sent.push(content); lastGateImages = images ?? []; } : undefined} />
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

// A note pinned on a picture attached in the composer names it by its place,
// through the gate as on the main send, and the picture goes as its marked
// copy (here the original: the test's blob cannot be read, which is the
// fallback). Before this the gate sent "[image] at 50% from the left…".
test("a note pinned on an attached picture rides the gate send as [Image N] at its marker", async () => {
  const image = { storageId: "st_img_pin", name: "shot.png", type: "image/png", previewUrl: "blob:pin" };
  useInboxStore.setState({ drafts: { [CONV_ID]: { draft_image_storage_ids: [image] } } } as any);
  useInboxStore.getState().addReviewComment(CONV_ID, {
    id: "pin1", messageId: "", blockIndex: 0, quote: "", body: "this is cut off", createdAt: 1,
    image: { src: "blob:pin", storageId: "st_img_pin", point: { x: 0.5, y: 0.5 }, attached: true },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no blob here"); }) as unknown as typeof fetch;
  try {
    expect(await submitGated("claude_code")).toEqual(["> [Image 1] at marker 1\n\nthis is cut off"]);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(lastGateImages).toMatchObject([{ storageId: "st_img_pin", mime: "image/png", uploading: false }]);
});

// A composer with a length limit (team chat: the server refuses a message over
// MAX_CHAT_CONTENT). Past the limit the send is held BEFORE the composer
// clears, so the text is still in the box to trim, send is disabled, and the
// count stands beside it. Before this the box emptied, the message painted as
// sent, and the server's refusal came back as an error toast.
// Each run gets a draft key of its own: the composer restores the text a key
// last held, so a shared key would hand one test the other's message.
let limitedRun = 0;
async function submitLimited(text: string, maxLength: number) {
  const draftKey = `chat-draft:limit-${++limitedRun}`;
  const sent: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={draftKey} bareComposer initialDraft={text} maxLength={maxLength} onGateSend={(content) => { sent.push(content); }} />
      </ConvexProvider>,
    );
  });
  const count = container.querySelector("[data-cc-over-limit]")?.textContent ?? null;
  const sendDisabled = (container.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.disabled ?? null;
  const form = container.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const left = container.querySelector("textarea")?.value ?? null;
  await act(async () => { root.unmount(); });
  container.remove();
  return { sent, count, sendDisabled, left };
}

test("a message over the limit is held: nothing sent, text kept, count beside a disabled send", async () => {
  const text = "x".repeat(1201);
  const r = await submitLimited(text, 1200);
  expect(r.sent).toEqual([]);
  expect(r.left).toBe(text);
  expect(r.count).toBe("1,201 / 1,200");
  expect(r.sendDisabled).toBe(true);
});

test("a message at the limit sends and shows no count", async () => {
  const text = "x".repeat(1200);
  const r = await submitLimited(text, 1200);
  expect(r.sent).toEqual([text]);
  expect(r.left).toBe("");
  expect(r.count).toBeNull();
  expect(r.sendDisabled).toBe(false);
});
