import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const toasts: string[] = [];
const record = (kind: string) => (msg: any) => { toasts.push(`${kind}:${String(msg)}`); return 1; };
mock.module("sonner", () => ({
  toast: Object.assign(record("toast"), { error: record("error"), info: record("info"), success: record("success"), warning: record("warning"), dismiss: () => {}, loading: record("loading"), custom: record("custom"), promise: (p: any) => p }),
  Toaster: () => null,
}));
process.on("unhandledRejection", (err) => { console.log("UNHANDLED", err); });
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { pendingImageUploads } from "../../lib/draftImages";

// The compose popup (Ctrl+N) contract: Enter sends the first message and the
// popup unmounts on the same tick. An image still uploading at that moment
// must ride along — the send waits for the upload in the background and then
// dispatches with the storage id, whichever finishes first: the session create
// or the upload.

afterAll(() => {
  dom.window.close();
  restoreGlobals();
});

const REAL_ID = "jx70000000000000000000000compose"; // 32 chars => isConvexId
const STORAGE_ID = "kg2composeupload";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };

// A Convex client whose network is the test's: mutations answer at once,
// queries never (the composer's live queries stay loading), the storage POST
// settles when the test says so.
function fakeConvex(uploadGate: Deferred<void>, failFirst = 0) {
  let failuresLeft = failFirst;
  const client = new ConvexReactClient("https://example.convex.cloud");
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
    if (url === "https://upload.test/storage") {
      await uploadGate.promise;
      if (failuresLeft > 0) { failuresLeft--; return { ok: false, status: 503, json: async () => ({}) } as any; }
      return { ok: true, status: 200, json: async () => ({ storageId: STORAGE_ID }) } as any;
    }
    return realFetch(input, init);
  }) as any;
  return { client, restore: () => { globalThis.fetch = realFetch; } };
}

type DispatchCall = { action: string; args: any[] };
function fakeDispatch(createGate: Deferred<void>) {
  const calls: DispatchCall[] = [];
  (useInboxStore.getState() as any)._setDispatch(async (action: string, args: any[]) => {
    calls.push({ action, args });
    if (action === "createSession") { await createGate.promise; return REAL_ID; }
    return undefined;
  });
  return calls;
}

// Drive the textarea's own React onChange: react-dom's change plugin decides
// at load time whether native input events exist, and under jsdom it can pick
// the legacy polling path where a dispatched `input` never reaches onChange.
function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  const props = propsKey ? (el as any)[propsKey] : null;
  props?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}

beforeEach(() => {
  pendingImageUploads.clear();
  useInboxStore.setState({
    sessions: {},
    conversations: {},
    pendingMessages: {},
    drafts: {},
    pendingSessionCreates: {},
    currentSessionId: null,
    currentUser: { _id: "user_compose_test", name: "Tester" } as any,
  } as any);
});

async function runScenario(order: "create-first" | "upload-first", opts: { failUploadsFirst?: number } = {}) {
  const uploadGate = deferred<void>();
  const createGate = deferred<void>();
  const { client, restore } = fakeConvex(uploadGate, opts.failUploadsFirst ?? 0);
  const calls = fakeDispatch(createGate);
  const { MessageInput } = await import("../ConversationView");

  // Exactly what ComposeView does on mount: a deferred local stub, created
  // server-side only when the first send fires materialize().
  const store = useInboxStore.getState();
  const { stubId, materialize } = store.beginOptimisticSession({
    agentType: "claude_code",
    projectPath: "/Users/me/proj",
    gitRoot: "/Users/me/proj",
    deferCreate: true,
    create: (id) => store.createSessionFromStub(id, { agentType: "claude_code", projectPath: "/Users/me/proj", gitRoot: "/Users/me/proj" }),
  });

  const dropFilesRef: { current: ((files: File[]) => void) | null } = { current: null };
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  let submitted: boolean | null = null;
  const onSubmitWithIntent = (navigate: boolean) => {
    // ComposeView.handleSubmit: mark sent, fire the create, dismiss the popup.
    submitted = navigate;
    void materialize();
    root.unmount();
  };
  await act(() => root.render(
    <ConvexProvider client={client}>
      <MessageInput
        conversationId={stubId}
        status="active"
        embedded
        autoFocusInput
        onDropFiles={dropFilesRef as any}
        onSubmitWithIntent={onSubmitWithIntent}
      />
    </ConvexProvider>,
  ));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  expect(dropFilesRef.current).toBeTruthy();

  // Paste an image (the drop zone hands files to the same uploadImage), type,
  // and hit Enter while the storage POST is still in flight.
  const file = new File([new Uint8Array(64)], "shot.png", { type: "image/png" });
  await act(() => { dropFilesRef.current!([file]); });
  await flush();
  await act(() => { setNativeValue(textarea, textarea.value + "look at this"); });
  await flush();
  await act(() => {
    textarea.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(submitted).toBe(false);

  // The optimistic first message exists under the stub with its uploading image.
  const pendingRows = useInboxStore.getState().pendingMessages[stubId] ?? [];
  if (pendingRows.length !== 1) {
    const st = useInboxStore.getState();
    console.log("DEBUG pendingMessages", JSON.stringify(st.pendingMessages));
    console.log("DEBUG calls", JSON.stringify(calls.map((c) => [c.action, c.args?.[0]])));
    console.log("DEBUG drafts", JSON.stringify(st.drafts));
    console.log("DEBUG textarea", JSON.stringify(textarea.value), "pendingUploads", [...pendingImageUploads.keys()]);
    console.log("DEBUG sessions", Object.keys(st.sessions));
    console.log("DEBUG toasts", JSON.stringify(toasts));
  }
  expect(pendingRows).toHaveLength(1);
  expect(pendingRows[0].content).toBe("[Image 1] look at this");
  expect(pendingRows[0].images?.[0]).toMatchObject({ uploading: true });
  const clientId = pendingRows[0]._clientId || pendingRows[0]._id;
  // Nothing sent yet — the upload owns the send.
  expect(calls.filter((c) => c.action === "sendMessage")).toHaveLength(0);
  expect(calls.filter((c) => c.action === "createSession")).toHaveLength(1);

  if (order === "create-first") {
    createGate.resolve();
    await flush(50);
    // Rekeyed to the real id, still unsent (image still uploading).
    expect(useInboxStore.getState().pendingMessages[REAL_ID]?.[0]?.images?.[0]).toMatchObject({ uploading: true });
    expect(calls.filter((c) => c.action === "sendMessage")).toHaveLength(0);
    uploadGate.resolve();
    await flush(opts.failUploadsFirst ? 1500 * opts.failUploadsFirst + 200 : 100);
  } else {
    uploadGate.resolve();
    await flush(50);
    // Upload landed on the row, but the create is still in flight: no send yet.
    expect(useInboxStore.getState().pendingMessages[stubId]?.[0]?.images).toEqual([{ media_type: "image/png", storage_id: STORAGE_ID }]);
    expect(calls.filter((c) => c.action === "sendMessage")).toHaveLength(0);
    createGate.resolve();
    await flush(100);
  }

  const sends = calls.filter((c) => c.action === "sendMessage");
  expect(sends.length).toBeGreaterThanOrEqual(1);
  for (const s of sends) {
    expect(s.args).toEqual([REAL_ID, "[Image 1] look at this", [STORAGE_ID], clientId]);
  }
  const row = useInboxStore.getState().pendingMessages[REAL_ID]?.[0] as any;
  expect(row?.images).toEqual([{ media_type: "image/png", storage_id: STORAGE_ID }]);
  expect(row?._isFailed).toBeFalsy();

  restore();
  container.remove();
}

test("compose Enter mid-upload: create resolves first, the settled upload sends with the image", async () => {
  await runScenario("create-first");
}, 30_000);

test("compose Enter mid-upload: upload resolves first, the create's rekey sends with the image", async () => {
  await runScenario("upload-first");
}, 30_000);

test("a storage POST that fails once is retried; the message still sends with the image", async () => {
  await runScenario("create-first", { failUploadsFirst: 1 });
}, 30_000);

// The popup dismisses on the same tick as Enter. When the send's commit is
// refused (here: no signed-in owner, so the durable pending-input save throws)
// the popup must stay open with the text intact — dismissing would close over
// the error toast and drop the message.
test("a refused commit keeps the popup open with the text instead of dismissing", async () => {
  useInboxStore.setState({ currentUser: null } as any);
  const uploadGate = deferred<void>();
  const createGate = deferred<void>();
  const { client, restore } = fakeConvex(uploadGate);
  const calls = fakeDispatch(createGate);
  const { MessageInput } = await import("../ConversationView");
  const store = useInboxStore.getState();
  const { stubId, materialize } = store.beginOptimisticSession({
    agentType: "claude_code",
    projectPath: "/Users/me/proj",
    gitRoot: "/Users/me/proj",
    deferCreate: true,
    create: (id) => store.createSessionFromStub(id, { agentType: "claude_code", projectPath: "/Users/me/proj", gitRoot: "/Users/me/proj" }),
  });
  const dropFilesRef: { current: ((files: File[]) => void) | null } = { current: null };
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root: Root = createRoot(container);
  let dismissed = 0;
  const onSubmitWithIntent = () => { dismissed++; void materialize(); root.unmount(); };
  await act(() => root.render(
    <ConvexProvider client={client}>
      <MessageInput conversationId={stubId} status="active" embedded autoFocusInput onDropFiles={dropFilesRef as any} onSubmitWithIntent={onSubmitWithIntent} />
    </ConvexProvider>,
  ));
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(() => { dropFilesRef.current!([new File([new Uint8Array(64)], "shot.png", { type: "image/png" })]); });
  await flush();
  await act(() => { setNativeValue(textarea, textarea.value + "look at this"); });
  await flush();
  toasts.length = 0;
  await act(() => {
    textarea.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await flush();
  expect(dismissed).toBe(0);
  expect(container.querySelector("textarea")).toBeTruthy();
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("[Image 1] look at this");
  expect(toasts.some((t) => t.startsWith("error:"))).toBe(true);
  expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
  expect(useInboxStore.getState().pendingMessages[stubId] ?? []).toHaveLength(0);
  await act(() => root.unmount());
  restore();
  container.remove();
}, 30_000);
