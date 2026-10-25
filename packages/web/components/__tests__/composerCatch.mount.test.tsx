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
// Same entry as composerGateSendBatch: closes the messageMarkdown cycle lazily.
import "../chat/ChatMessage";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// A send whose text holds a credential is held at submit for ComposerCatch
// (Save to Vault and send / Send as is / Cancel); ordinary text goes out at
// once with no bar. Run: bun test components/__tests__/composerCatch.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// A fresh conversation per test: the composer keeps typed text per conversation across mounts.
let run = 0;
const KEY = `sk_test_${"a1B2c3D4e5".repeat(3)}`;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).action = async () => ({ short_id: "sec-1" });
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

beforeEach(() => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, reviewComments: {}, currentSessionId: null, currentUser: { _id: "user_catch_test", name: "Tester" } as any } as any);
});

type Ctx = { container: HTMLElement; convId: string; textarea: () => HTMLTextAreaElement; stored: () => unknown };

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  const propsKey = Object.keys(el).find((k) => k.startsWith("__reactProps"));
  (el as any)[propsKey!]?.onChange?.({ target: el, currentTarget: el, nativeEvent: new w.Event("input") });
}

/** Mounts a composer seeded with `text` (or a draft already in the store), submits, then runs `then`. */
async function submit(text: string, then?: (ctx: Ctx) => Promise<void>, opts: { stored?: string; before?: (ctx: Ctx) => Promise<void> } = {}) {
  const convId = `jx70000000000000000000000catch${run++}`.padEnd(32, "x"); // 32 chars => isConvexId
  if (opts.stored) useInboxStore.setState({ drafts: { [convId]: { draft_message: opts.stored } } } as any);
  const sent: string[] = [];
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <MessageInput conversationId={convId} status="active" agentType="claude_code" initialDraft={text || undefined} onGateSend={(content) => { sent.push(content); }} />
      </ConvexProvider>,
    );
  });
  const ctx: Ctx = {
    container,
    convId,
    textarea: () => container.querySelector("textarea")!,
    stored: () => useInboxStore.getState().drafts[convId]?.draft_message,
  };
  if (opts.before) await opts.before(ctx);
  const form = container.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  const barShown = !!container.querySelector("[data-composer-catch]");
  const label = container.querySelector("[data-composer-catch]")?.textContent ?? "";
  const name = (container.querySelector("[data-composer-catch-name]") as HTMLInputElement | null)?.value ?? null;
  const sentBefore = [...sent];
  if (then) await then(ctx);
  await act(async () => { root.unmount(); });
  container.remove();
  return { sentBefore, sent, barShown, label, name };
}

test("ordinary text sends at once with no bar", async () => {
  const r = await submit("Fix the password field on the login page");
  expect(r.barShown).toBe(false);
  expect(r.sent).toEqual(["Fix the password field on the login page"]);
});

test("a Stripe test key holds the send and offers it as stripe-test", async () => {
  const r = await submit(`use ${KEY} for checkout`);
  expect(r.barShown).toBe(true);
  expect(r.sentBefore).toEqual([]);
  expect(r.label).toContain("Stripe secret key");
  expect(r.name).toBe("stripe-test");
});

test("Send as is sends the text unchanged", async () => {
  const r = await submit(`use ${KEY} for checkout`, async ({ container: c }) => {
    await act(async () => { (c.querySelector("[data-composer-catch-as-is]") as HTMLButtonElement).click(); });
    await settle();
  });
  expect(r.sent).toEqual([`use ${KEY} for checkout`]);
});

test("Escape cancels: nothing sent, the bar goes", async () => {
  let gone = false;
  const r = await submit(`use ${KEY} for checkout`, async ({ container: c }) => {
    const input = c.querySelector("[data-composer-catch-name]")!;
    await act(async () => { input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    gone = !c.querySelector("[data-composer-catch]");
  });
  expect(gone).toBe(true);
  expect(r.sent).toEqual([]);
});

// The durable draft (IndexedDB, client_state on the server, teammates'
// presence) never holds the value; the box keeps it until the catch settles.
test("a typed key never reaches the stored draft, and Cancel keeps it in the box", async () => {
  let afterTyping: unknown;
  let boxAfterCancel = "";
  let storedAfterCancel: unknown;
  const r = await submit("", async ({ container: c, textarea, stored }) => {
    await act(async () => { (Array.from(c.querySelectorAll("[data-composer-catch] button")).find((b) => b.textContent?.startsWith("Cancel")) as HTMLButtonElement).click(); });
    await settle(400);
    boxAfterCancel = textarea().value;
    storedAfterCancel = stored();
  }, {
    before: async ({ textarea, stored }) => {
      await act(async () => { typeInto(textarea(), `use ${KEY} for checkout`); });
      await settle(400); // past the draft write's debounce
      afterTyping = stored();
    },
  });
  expect(r.barShown).toBe(true);
  expect(afterTyping).toBe("use [redacted:stripe-secret-key] for checkout");
  expect(boxAfterCancel).toBe(`use ${KEY} for checkout`);
  expect(storedAfterCancel).toBe("use [redacted:stripe-secret-key] for checkout");
  expect(r.sent).toEqual([]);
});

test("the catch scrubs a draft stored with the value before", async () => {
  let stored: unknown;
  const r = await submit("", async (ctx) => { stored = ctx.stored(); }, { stored: `use ${KEY} for checkout` });
  expect(r.barShown).toBe(true);
  expect(stored).toBe("use [redacted:stripe-secret-key] for checkout");
});

test("Save to Vault and send sends a reference in place of the value", async () => {
  const r = await submit("", async ({ container: c }) => {
    await act(async () => { (c.querySelector("[data-composer-catch-save]") as HTMLButtonElement).click(); });
    await settle(100);
  }, {
    before: async ({ textarea }) => {
      await act(async () => { typeInto(textarea(), `use ${KEY} for checkout`); });
      await settle(400);
    },
  });
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]).toContain("[vault secret stripe-test");
  expect(r.sent[0]).not.toContain(KEY);
});
