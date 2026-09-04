import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useHibernationCommands } from "../useHibernationCommands";
import { useEnsureDispatch } from "../useEnsureDispatch";
import { recordHibernationDispatchError } from "../../lib/hibernation";
import { useInboxStore } from "../../store/inboxStore";
import { hibernate } from "../../../convex/convex/sessionCommands";
import { makeFakeDb } from "../../../convex/convex/testDb";
import { DispatchNotWiredError, isParkedDispatchError, isPermanentDispatchError, MAX_OUTBOX_BOOT_ATTEMPTS, OUTBOX_MAX_REPLAY_AGE_MS, outboxFailureDisposition } from "../../store/mutativeMiddleware";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
const previous = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let hook: ReturnType<typeof useHibernationCommands>;
let outbox: Map<string, any>;
let activeRequests: Set<string>;
let client: any;
function DispatchBinding() { useEnsureDispatch(); return null; }
function Probe() { hook = useHibernationCommands(); return null; }
const view = (visible = true) => <ConvexProvider client={client}><DispatchBinding />{visible && <Probe />}</ConvexProvider>;
const store = () => useInboxStore.getState();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
  outbox = new Map();
  activeRequests = new Set();
  store()._clearRuntimeBindings();
  useInboxStore.setState({ sessionCommands: {}, sessions: {}, pending: {} });
  store()._setOutbox(async entry => { outbox.set(entry.id, structuredClone(entry)); }, async id => { outbox.delete(id); }, async () => [...outbox.values()]);
  client = {
    mutation() { throw new Error("Install the synthetic dispatch transport before sending"); },
    watchQuery(_query: unknown, args: { request_ids?: string[] }) {
      return {
        onUpdate() { const ids = args.request_ids ?? []; ids.forEach(id => activeRequests.add(id)); return () => ids.forEach(id => activeRequests.delete(id)); },
        localQueryResult() { return undefined; },
        journal() { return undefined; },
      };
    },
  };
  root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(view()); });
  store()._setDispatch(null);
});
afterEach(async () => { await act(async () => { root.unmount(); }); store()._clearRuntimeBindings(); store()._setDispatchError(() => {}); });
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function request() {
  let id = "";
  await act(async () => {
    id = hook.request("conv", "session", "device");
    expect(store().sessionCommands[id].executed_at).toBeNull();
    await tick();
  });
  return id;
}

for (const reason of ["unauthenticated", "foreign", "bulk-owner", "device", "managed", "request-reuse", "invalid-request"]) {
  test(`actual hibernate ${reason} rejection completes the UI row and retires its outbox`, async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conv", user_id: "owner", session_id: "session", owner_device_id: "device" }],
      managed_sessions: [{ _id: "managed", conversation_id: "conv", user_id: "owner", session_id: "session" }],
      daemon_commands: [],
    });
    const ctx = { db, auth: { getUserIdentity: async (): Promise<any> => ({ subject: "owner|login" }) } };
    if (reason === "unauthenticated") ctx.auth.getUserIdentity = async () => null;
    if (reason === "foreign") ctx.auth.getUserIdentity = async () => ({ subject: "stranger|login" });
    if (reason === "bulk-owner") await db.patch("conv", { user_id: "runner", owner_user_id: "owner" });
    if (reason === "device") await db.patch("conv", { owner_device_id: "moved" });
    if (reason === "managed") await db.delete("managed");
    let attempts = 0;
    store()._setDispatch(async (_action, [requestId, conversationId, sessionId, ownerDeviceId]) => {
      attempts++;
      const args = { request_id: requestId, conversation_id: conversationId, session_id: sessionId, owner_device_id: ownerDeviceId };
      if (reason === "request-reuse") {
        await (hibernate as any)._handler(ctx, args);
        await db.patch("conv", { owner_device_id: "moved" });
        args.owner_device_id = "moved";
      }
      if (reason === "invalid-request") args.request_id = "";
      return (hibernate as any)._handler(ctx, args).then(
        () => { throw new Error("Expected the real handler to reject"); },
        (error: Error) => { throw new Error(`[CONVEX M(sessionCommands:hibernate)] Uncaught Error: ${error.message}`); },
      );
    });
    const id = await request();
    expect(attempts).toBe(1);
    expect(store().sessionCommands[id].executed_at).toBeGreaterThan(0);
    expect(store().sessionCommands[id].error).toContain("Uncaught Error:");
    expect(outbox.size).toBe(0);
    expect(activeRequests.has(id)).toBe(false);
  });
}

test("an unwired but durable request remains pending and subscribed", async () => {
  const id = await request();
  expect(outbox.size).toBe(1);
  expect(store().sessionCommands[id].executed_at).toBeNull();
  expect(store().sessionCommands[id].error).toBeNull();
  expect(activeRequests.has(id)).toBe(true);
});

test("an explicitly dropped unwired request fails instead of waiting forever", async () => {
  store()._setOutbox(null, null, null);
  const id = await request();
  expect(outbox.size).toBe(0);
  expect(store().sessionCommands[id].executed_at).toBeGreaterThan(0);
  expect(store().sessionCommands[id].error).toContain("dropped (no outbox)");
  expect(activeRequests.has(id)).toBe(false);
});

test("retryable server responses override terminal text and hibernation keeps the existing bounded replay policy", () => {
  expect(isPermanentDispatchError(new TypeError("Failed to fetch"))).toBe(false);
  expect(isPermanentDispatchError(new Error("Your request timed out"))).toBe(false);
  expect(isPermanentDispatchError(Object.assign(new Error("Uncaught Error: retry later"), { data: { retryable: true } }))).toBe(false);
  expect(isParkedDispatchError(new DispatchNotWiredError("hibernateSession", true))).toBe(true);
  expect(isParkedDispatchError(new DispatchNotWiredError("hibernateSession", false))).toBe(false);
  const entry = { id: "outbox", action: "hibernateSession", args: ["request", "conv", "session", "device"], ts: Date.now() };
  expect(outboxFailureDisposition(entry).keep).toBe(true);
  expect(outboxFailureDisposition({ ...entry, attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 1 }).keep).toBe(false);
  expect(OUTBOX_MAX_REPLAY_AGE_MS).toBe(7 * 86400_000);
});


test("terminal replay rejects every durable request even after its view unmounts", async () => {
  const first = await request();
  let second = "";
  await act(async () => { second = hook.request("other-conv", "other-session", "device"); await tick(); });
  expect(outbox.size).toBe(2);
  expect(activeRequests.size).toBe(2);
  await act(async () => { root.render(view(false)); });
  const db = makeFakeDb({ conversations: [{ _id: "conv", user_id: "owner", session_id: "session", owner_device_id: "changed" }] });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|login" }) } };
  const error = await (hibernate as any)._handler(ctx, { request_id: first, conversation_id: "conv", session_id: "session", owner_device_id: "device" }).then(
    () => { throw new Error("Expected actual handler rejection"); },
    (e: Error) => new Error(`[CONVEX M(sessionCommands:hibernate)] Uncaught Error: ${e.message}`),
  );
  let attempts = 0;
  await act(async () => { store()._setDispatch(async () => { attempts++; throw error; }); await tick(); });
  expect(attempts).toBe(2);
  expect(outbox.size).toBe(0);
  for (const id of [first, second]) {
    expect(store().sessionCommands[id].executed_at).toBeGreaterThan(0);
    expect(store().sessionCommands[id].error).toContain("owning device changed");
  }
});

test("a late dispatch error cannot overwrite an acknowledged daemon outcome", async () => {
  const id = await request();
  await act(async () => {
    store().syncRecord("sessionCommands", id, { ...store().sessionCommands[id], executed_at: 123, result: "hibernated" });
    recordHibernationDispatchError(id, new Error("Uncaught Error: late rejection"));
  });
  expect(store().sessionCommands[id]).toMatchObject({ executed_at: 123, result: "hibernated", error: null });
});

test("exhausted network, timeout and retryable-server retries stay durable, pending and subscribed", async () => {
  const failures = [
    new TypeError("Failed to fetch"),
    new Error("Your request timed out"),
    Object.assign(new Error("Uncaught Error: retry later"), { data: { retryable: true } }),
  ];
  let attempts = 0;
  store()._setDispatch(async (_action, args) => { attempts++; throw failures[Number(args[1])]; });
  let ids: string[] = [];
  await act(async () => {
    ids = failures.map((_, i) => hook.request(String(i), "session", "device"));
    await tick();
  });
  expect(outbox.size).toBe(3);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 7500)); });
  expect(attempts).toBe(12);
  expect(outbox.size).toBe(3);
  for (const id of ids) {
    expect(store().sessionCommands[id]).toMatchObject({ executed_at: null, error: null, result: null });
    expect(activeRequests.has(id)).toBe(true);
  }
}, 15_000);
