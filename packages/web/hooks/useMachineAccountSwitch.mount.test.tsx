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
const { useMachineAccountSwitch } = await import("./useMachineAccountSwitch");
const { useInboxStore } = await import("../store/inboxStore");
const { flushSyncPublishes } = await import("../store/syncTransaction");
const { toast } = await import("sonner");
const successes = spyOn(toast, "success").mockImplementation(() => 1);
const errors = spyOn(toast, "error").mockImplementation(() => 1);
const messages = spyOn(toast, "message").mockImplementation(() => 1);
const roots: ReturnType<typeof createRoot>[] = [];
const owner = {};
let deviceSequence = 0;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  useInboxStore.getState()._clearDispatch(owner);
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

// A sync write's publish is folded into a short window (syncTransaction):
// flush it, then let React take the update.
const settle = () => { flushSyncPublishes(); return new Promise((resolve) => setTimeout(resolve, 0)); };

// The switch rides the store: dispatch is the transport, the sessionCommands
// echo is the daemon's report, activeEmail is the heartbeat.
async function harness() {
  let deviceId = `account-switch-${++deviceSequence}`;
  useInboxStore.setState({ sessionCommands: {}, pending: {} } as any);
  let activeEmail = "old@example.com";
  let showFirst = true;
  const calls: { requestId: string; args: Record<string, unknown> }[] = [];
  let mutation = async (): Promise<unknown> => ({ command_ids: ["command-one"] });
  useInboxStore.getState()._setDispatch(async (_action: string, [requestId, args]: any[]) => {
    calls.push({ requestId, args });
    return mutation();
  }, { owner } as any);
  const views: ReturnType<typeof useMachineAccountSwitch>[] = [];
  function Probe({ index }: { index: number }) {
    views[index] = useMachineAccountSwitch({ deviceId, activeEmail });
    return <div>{views[index].phase}</div>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () => root.render(<>{showFirst && <Probe index={0} />}<Probe index={1} /></>);
  await act(async () => { render(); await settle(); });
  return {
    calls, views, deviceId: () => deviceId,
    setMutation: (fn: typeof mutation) => { mutation = fn; },
    command: async (value: { executed_at?: number; error?: string } | undefined) => {
      await act(async () => {
        const id = calls.at(-1)!.requestId;
        const row = useInboxStore.getState().sessionCommands[id];
        useInboxStore.getState().syncTable("sessionCommands", [{
          _id: id, command_id: `cmd-${id}`, conversation_id: null, command: "switch_account", device_id: row?.device_id ?? deviceId,
          requested_at: Date.now(), executed_at: value?.executed_at ?? null, result: null, error: value?.error ?? null,
        }]);
        await settle();
      });
    },
    account: async (email: string) => { await act(async () => { activeEmail = email; render(); await settle(); }); },
    device: async (id: string) => { await act(async () => { deviceId = id; render(); await settle(); }); },
    first: async (visible: boolean) => { await act(async () => { showFirst = visible; render(); await settle(); }); },
  };
}

test("two surfaces share one switch, and command completion waits for inventory", async () => {
  const h = await harness();
  await act(async () => {
    await settle();
    await Promise.all([
      h.views[0].switchTo("jordan", "jordan@example.com"),
      h.views[1].switchTo("third", "third@example.com"),
      h.views[0].switchTo("old", "old@example.com"),
    ]);
  });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].args).toEqual({ profile: "jordan", device_id: h.deviceId(), continue_blocked: false });
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
  await act(async () => { request = h.views[0].switchTo("jordan", "jordan@example.com"); await settle(); });
  await h.account("jordan@example.com");
  expect(h.views[0].phase).toBe("succeeded");
  const next = deferred<{ command_ids: string[] }>();
  h.setMutation(() => next.promise);
  let nextRequest!: Promise<void>;
  await act(async () => { nextRequest = h.views[1].switchTo("third", "third@example.com"); await settle(); });
  await act(async () => { reply.reject(new Error("[CONVEX M(dispatch:dispatch)] Uncaught Error: late refusal")); await request; await settle(); });
  expect(h.views[0].switching).toBe("third");
  expect(errors).not.toHaveBeenCalled();
  await act(async () => { next.resolve({ command_ids: ["command-two"] }); await nextRequest; await settle(); });
  await h.account("third@example.com");
  expect(h.views[0].phase).toBe("succeeded");
});

test("daemon failure is shared and permits a retry", async () => {
  const h = await harness();
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); await settle(); });
  await h.command({ executed_at: Date.now(), error: "Account switch failed: login expired" });
  expect(h.views.every(v => v.phase === "failed" && v.switching === null)).toBe(true);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(successes).not.toHaveBeenCalled();
  await act(async () => { await h.views[1].switchTo("third", "third@example.com"); await settle(); });
  expect(h.calls).toHaveLength(2);
  expect(h.views[0].switching).toBe("third");
});

test("an empty queue response fails immediately instead of waiting for timeout", async () => {
  const h = await harness();
  h.setMutation(async () => ({ command_ids: [] }));
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); await settle(); });
  expect(h.views[0].outcome?.message).toBe("No daemon accepted the account switch");
  expect(h.views[0].switching).toBeNull();
});

test("switch tracking survives the initiating surface unmounting and reopening", async () => {
  const h = await harness();
  await act(async () => { await h.views[0].switchTo("jordan", "jordan@example.com"); await settle(); });
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
  await act(async () => { request = h.views[0].switchTo("jordan", "jordan@example.com"); await settle(); });
  const original = h.deviceId();
  await h.device(`${original}-other`);
  expect(h.views[0].switching).toBeNull();
  await act(async () => { reply.resolve({ command_ids: ["old-machine-command"] }); await request; await settle(); });
  expect(h.views[0].phase).toBe("idle");
  await h.device(original);
  expect(h.views[0].switching).toBe("jordan");
  await h.account("jordan@example.com");
  expect(h.views[0].phase).toBe("succeeded");
});
