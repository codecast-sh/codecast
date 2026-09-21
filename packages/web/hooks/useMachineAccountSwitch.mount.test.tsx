import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProvider, ConvexReactClient } = await import("convex/react");
const { useMachineAccountSwitch } = await import("./useMachineAccountSwitch");
const { toast } = await import("sonner");
const successes = spyOn(toast, "success").mockImplementation(() => 1);
const errors = spyOn(toast, "error").mockImplementation(() => 1);
const messages = spyOn(toast, "message").mockImplementation(() => 1);
const roots: ReturnType<typeof createRoot>[] = [];
const clients: InstanceType<typeof ConvexReactClient>[] = [];
let deviceSequence = 0;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const client of clients.splice(0)) await client.close();
  document.body.innerHTML = "";
  successes.mockClear(); errors.mockClear(); messages.mockClear();
});
afterAll(() => {
  successes.mockRestore(); errors.mockRestore(); messages.mockRestore();
  closeDomWindow(dom);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function harness() {
  let deviceId = `account-switch-${++deviceSequence}`;
  const client = new ConvexReactClient("https://example.convex.cloud");
  clients.push(client);
  const listeners = new Set<() => void>();
  let command: { executed_at?: number; error?: string } | undefined;
  let activeEmail = "old@example.com";
  let showFirst = true;
  const calls: Record<string, unknown>[] = [];
  let mutation = async () => ({ command_ids: ["command-one"] });
  client.mutation = (async (_ref: unknown, args: Record<string, unknown>) => {
    calls.push(args);
    return mutation();
  }) as any;
  client.watchQuery = (() => ({
    onUpdate: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    localQueryResult: () => command,
    localQueryLogs: () => undefined,
    journal: () => undefined,
  })) as any;
  const views: ReturnType<typeof useMachineAccountSwitch>[] = [];
  function Probe({ index }: { index: number }) {
    views[index] = useMachineAccountSwitch({ deviceId, activeEmail });
    return <div>{views[index].phase}</div>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () => root.render(<ConvexProvider client={client}>{showFirst && <Probe index={0} />}<Probe index={1} /></ConvexProvider>);
  await act(async () => render());
  return {
    calls, views, deviceId,
    setMutation: (fn: typeof mutation) => { mutation = fn; },
    command: async (value: typeof command) => { await act(async () => { command = value; listeners.forEach(fn => fn()); }); },
    account: async (email: string) => { await act(async () => { activeEmail = email; render(); }); },
    device: async (id: string) => { await act(async () => { deviceId = id; render(); }); },
    first: async (visible: boolean) => { await act(async () => { showFirst = visible; render(); }); },
  };
}

test("two surfaces share one switch, and command completion waits for inventory", async () => {
  const h = await harness();
  await act(async () => {
    await Promise.all([
      h.views[0].switchTo("jordan", "jordan@example.com"),
      h.views[1].switchTo("third", "third@example.com"),
      h.views[0].switchTo("old", "old@example.com"),
    ]);
  });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].continue_blocked).toBe(false);
  expect(h.views.map(v => v.switching)).toEqual(["jordan", "jordan"]);
  await h.command({ executed_at: Date.now() });
  expect(h.views.map(v => v.phase)).toEqual(["confirming", "confirming"]);
  expect(successes).not.toHaveBeenCalled();
  expect(h.views.every(v => v.outcome === null)).toBe(true);
  await h.account("jordan@example.com");
  expect(h.views.every(v => v.phase === "succeeded" && v.switching === null)).toBe(true);
  expect(successes).toHaveBeenCalledTimes(1);
  await h.account("third@example.com");
  expect(h.views.every(v => v.outcome === null)).toBe(true);
});

test("a heartbeat can confirm before the command reply, and a stale rejection cannot undo it", async () => {
  const h = await harness();
  const reply = deferred<{ command_ids: string[] }>();
  h.setMutation(() => reply.promise);
  let request!: Promise<void>;
  await act(async () => { request = h.views[0].switchTo("jordan", "jordan@example.com"); });
  await h.account("jordan@example.com");
  expect(h.views[0].phase).toBe("succeeded");
  const next = deferred<{ command_ids: string[] }>();
  h.setMutation(() => next.promise);
  let nextRequest!: Promise<void>;
  await act(async () => { nextRequest = h.views[1].switchTo("third", "third@example.com"); });
  await act(async () => { reply.reject(new Error("late network error")); await request; });
  expect(h.views[0].switching).toBe("third");
  expect(errors).not.toHaveBeenCalled();
  await act(async () => { next.resolve({ command_ids: ["command-two"] }); await nextRequest; });
  await h.account("third@example.com");
  expect(h.views[0].phase).toBe("succeeded");
});

test("daemon failure is shared and permits a retry", async () => {
  const h = await harness();
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); });
  await h.command({ executed_at: Date.now(), error: "Account switch failed: login expired" });
  expect(h.views.every(v => v.phase === "failed" && v.switching === null)).toBe(true);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(successes).not.toHaveBeenCalled();
  await h.command(undefined);
  await act(async () => { await h.views[1].switchTo("third", "third@example.com"); });
  expect(h.calls).toHaveLength(2);
  expect(h.views[0].switching).toBe("third");
});

test("an empty queue response fails immediately instead of waiting for timeout", async () => {
  const h = await harness();
  h.setMutation(async () => ({ command_ids: [] }));
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); });
  expect(h.views[0].outcome?.message).toBe("No daemon accepted the account switch");
  expect(h.views[0].switching).toBeNull();
});

test("switch tracking survives the initiating surface unmounting and reopening", async () => {
  const h = await harness();
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); });
  await h.first(false);
  await h.command({ executed_at: Date.now() });
  expect(h.views[1].phase).toBe("confirming");
  await h.first(true);
  expect(h.views[0].switching).toBe("jordan");
  await h.account("jordan@example.com");
  expect(h.views.every(v => v.phase === "succeeded")).toBe(true);
  expect(successes).toHaveBeenCalledTimes(1);
});

test("changing machines isolates pending commands and their late responses", async () => {
  const h = await harness();
  const reply = deferred<{ command_ids: string[] }>();
  h.setMutation(() => reply.promise);
  let request!: Promise<void>;
  await act(async () => { request = h.views[0].switchTo("jordan", "jordan@example.com"); });
  await h.device(`${h.deviceId}-other`);
  expect(h.views[0].switching).toBeNull();
  await act(async () => { reply.resolve({ command_ids: ["old-machine-command"] }); await request; });
  expect(h.views[0].phase).toBe("idle");
  await h.device(h.deviceId);
  expect(h.views[0].switching).toBe("jordan");
  await h.account("jordan@example.com");
  expect(h.views[0].phase).toBe("succeeded");
});
