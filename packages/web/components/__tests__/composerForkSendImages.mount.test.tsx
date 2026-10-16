import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const toasts: string[] = [];
const record = (kind: string) => (msg: any) => { toasts.push(`${kind}:${String(msg)}`); return 1; };
mock.module("sonner", () => ({
  toast: Object.assign(record("toast"), { error: record("error"), info: record("info"), success: record("success"), warning: record("warning"), dismiss: () => {}, loading: record("loading"), custom: record("custom"), promise: (p: any) => p }),
  Toaster: () => null,
}));
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { pendingImageUploads } from "../../lib/draftImages";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// Fork and send (the fork button, Cmd+Shift+Enter, or Enter with a message
// selected) delivers the composer into a new branch. The images attached in
// the composer go with the text into the fork; none stay behind in the parent.

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const PARENT_ID = "jx70000000000000000000000parent0"; // 32 chars => isConvexId
const FORK_REAL_ID = "jx70000000000000000000000forkrea";
const FORK_STUB = "fork_stub_images";
const STORAGE_ID = "kg2forkupload";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };
const flushUntil = async (ready: () => boolean, budgetMs = 3_000) => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await flush(20);
  return ready();
};

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => "https://upload.test/storage";
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({
    onUpdate: () => () => {},
    localQueryResult: () => undefined,
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url === "https://upload.test/storage") return { ok: true, status: 200, json: async () => ({ storageId: STORAGE_ID }) } as any;
    return realFetch(input, init);
  }) as any;
  return { client, restore: () => { globalThis.fetch = realFetch; } };
}

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  const props = propsKey ? (el as any)[propsKey] : null;
  props?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}

beforeEach(() => {
  pendingImageUploads.clear();
  toasts.length = 0;
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    pendingMessages: {},
    drafts: {},
    pendingSessionCreates: {},
    currentSessionId: null,
    currentUser: { _id: "user_fork_test", name: "Tester" } as any,
  } as any);
});

// The fork stub resolves to its real id once the server copy lands, the way
// beginLocalFork registers it.
function openStubFork() {
  let resolve!: (id: string) => void;
  const ready = new Promise<string>((r) => { resolve = r; });
  useInboxStore.getState().trackSessionCreate(FORK_STUB, ready);
  setTimeout(() => resolve(FORK_REAL_ID), 30);
}

async function forkSendWithImage(via: "tail" | "selection") {
  const calls: Array<{ action: string; args: any[] }> = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => { calls.push({ action, args }); return undefined; });
  const { client, restore } = fakeConvex();
  const { MessageInput } = await import("../MessageInput");
  const dropFilesRef: { current: ((files: File[]) => void) | null } = { current: null };
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = (selected: boolean) => root.render(
    <ConvexProvider client={client}>
      <MessageInput
        conversationId={PARENT_ID}
        status="active"
        agentType="claude_code"
        agentStatus={"idle" as any}
        isSessionReady
        onDropFiles={dropFilesRef as any}
        onForkTail={async () => { openStubFork(); return FORK_STUB; }}
        onForkFromMessage={async () => { openStubFork(); useInboxStore.getState().injectSession({ _id: FORK_STUB, session_id: FORK_STUB, title: "Fork", updated_at: Date.now() } as any); }}
        selectedMessageUuid={selected ? "msg_selected" : null}
        selectedMessageContent={selected ? "earlier prompt" : null}
        onClearSelection={() => render(false)}
      />
    </ConvexProvider>,
  );
  await act(() => render(via === "selection"));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(() => { dropFilesRef.current!([new File([new Uint8Array(64)], "shot.png", { type: "image/png" })]); });
  await flushUntil(() => !pendingImageUploads.size);
  await act(() => { setNativeValue(textarea, textarea.value.replace("earlier prompt", "") + "look at this"); });
  await flush();
  await act(() => {
    if (via === "tail") (container.querySelector('button[title^="Fork and send"]') as HTMLButtonElement).click();
    else textarea.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flushUntil(() => calls.some((c) => c.action === "sendMessage"));

  const sends = calls.filter((c) => c.action === "sendMessage");
  expect(toasts.filter((t) => t.startsWith("error:"))).toEqual([]);
  expect(sends).toHaveLength(1);
  expect(sends[0].args[0]).toBe(FORK_REAL_ID);
  expect(sends[0].args[1]).toBe("[Image 1] look at this");
  expect(sends[0].args[2]).toEqual([STORAGE_ID]);
  // Nothing stays behind in the parent: no message, no draft, no thumbnail.
  expect(useInboxStore.getState().pendingMessages[PARENT_ID] ?? []).toHaveLength(0);
  expect(useInboxStore.getState().drafts[PARENT_ID]?.draft_image_storage_ids ?? []).toHaveLength(0);
  expect(container.querySelectorAll('img[alt="Pasted"]').length).toBe(0);

  await act(() => root.unmount());
  restore();
  container.remove();
}

test("fork and send carries the composer's images into the fork", async () => {
  await forkSendWithImage("tail");
}, 30_000);

test("sending with a message selected carries the composer's images into the fork", async () => {
  await forkSendWithImage("selection");
}, 30_000);
