// An agent's tab sees a sample Vault: the Vault hooks read the sample, reveal
// and every write change only the sample, and no Convex action, mutation or
// query runs; the store (and so IndexedDB) never changes. A person's tab is
// unwrapped and its reveal reaches the server.
// Run: cd packages/web && bun test components/secrets/VaultSource.mount.test.tsx
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost:3200/vault", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

const calls: string[] = [];
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useAction: (ref: any) => async () => (calls.push(getFunctionName(ref)), { payload: { value: "zz-real-value" } }),
  useMutation: (ref: any) => async () => (calls.push(getFunctionName(ref)), {}),
  useQueries: (queries: Record<string, { query: any }>) => {
    for (const q of Object.values(queries)) calls.push(getFunctionName(q.query));
    return Object.fromEntries(Object.keys(queries).map((k) => [k, undefined]));
  },
}));
const authState = await import("../../hooks/useServerAuthSettled");
mock.module("../../hooks/useServerAuthSettled", () => ({ ...authState, useServerAuthSettled: () => true, useServerIdentityLost: () => false }));

const { useInboxStore } = await import("../../store/inboxStore");
const { useSecretHistory, useSecrets, useSecretsLoaded, useSwapValue, useFillRequest, useVaultActions, useVaultScope } = await import("../../hooks/useSyncSecrets");
const { useReveal } = await import("../../hooks/useReveal");
const { useCreate } = await import("../../hooks/useCreateSecret");
const { useSampleVault } = await import("./sampleVault");
const { VaultSource } = await import("./VaultSource");
const { AGENT_TAB_KEY } = await import("../../lib/desktopHandoff");

type Hooks = {
  sample: boolean;
  rows: ReturnType<typeof useSecrets>;
  loaded: boolean;
  events?: unknown[];
  reveal: ReturnType<typeof useReveal>;
  actions: ReturnType<typeof useVaultActions>;
  swap: ReturnType<typeof useSwapValue>;
  fill: ReturnType<typeof useFillRequest>;
  create: ReturnType<typeof useCreate>;
};
const hook = {} as Hooks;
// The first key in whichever Vault the tree shows; a person's tab has none, so the probe names one.
let revealId = "sec-real";
function Probe() {
  hook.sample = !!useSampleVault();
  hook.rows = useSecrets();
  hook.loaded = useSecretsLoaded();
  hook.events = useSecretHistory("events", revealId, true).rows;
  hook.reveal = useReveal(revealId);
  hook.actions = useVaultActions();
  hook.swap = useSwapValue();
  hook.fill = useFillRequest();
  hook.create = useCreate(useVaultScope());
  return null;
}

let root: Root;
const mount = async (stamped: boolean) => {
  if (stamped) sessionStorage.setItem(AGENT_TAB_KEY, "1");
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<VaultSource><Probe /></VaultSource>));
};
const byName = (name: string) => hook.rows.find((r) => r.name === name)!;
const storeSnapshot = () => JSON.stringify({ secrets: (useInboxStore.getState() as any).secrets, history: (useInboxStore.getState() as any).secretHistory, pending: useInboxStore.getState().pending });

beforeEach(() => {
  calls.length = 0;
  sessionStorage.clear();
  revealId = "sec-real";
  useInboxStore.setState({ secrets: {}, pending: {} } as any);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

test("a person's tab shows the real Vault, and a reveal reaches the server", async () => {
  await mount(false);
  expect(hook.sample).toBe(false);
  expect(hook.rows).toEqual([]);
  expect(calls).toContain("secrets:events");
  let value: unknown;
  await act(async () => {
    value = await hook.reveal.load();
  });
  expect(value).toEqual({ value: "zz-real-value" });
  expect(calls).toContain("secrets:reveal");
});

test("an agent's tab shows the sample: every kind, health and scope, answered at once", async () => {
  await mount(true);
  expect(hook.sample).toBe(true);
  expect(hook.loaded).toBe(true);
  expect(new Set(hook.rows.map((r) => r.kind))).toEqual(new Set(["key", "login", "file", "signin"]));
  expect(hook.rows.some((r) => r.status === "requested")).toBe(true);
  expect(hook.rows.some((r) => r.ask_first) && hook.rows.some((r) => !r.ask_first)).toBe(true);
  expect(new Set(hook.rows.map((r) => r.workspace))).toEqual(new Set(["team:sample", "user:sample"]));
  expect(byName("github-bot").has_otp).toBe(true);
  expect(calls).toEqual([]);
});

test("in an agent's tab reveal reads the sample and every write stays in the sample, with no server call and no store write", async () => {
  await mount(true);
  revealId = byName("stripe-test")._id;
  await act(async () => root.render(<VaultSource><Probe /></VaultSource>));
  const before = storeSnapshot();

  let value: any;
  await act(async () => {
    value = await hook.reveal.load();
  });
  expect(value.value).toMatch(/^sample-/);
  expect((hook.events as any[])[0]).toMatchObject({ kind: "revealed" });

  await act(async () => {
    expect(await hook.create("personal", { name: "zz-new", kind: "key", payload: { value: "zz-sample-new-value" } })).toBeNull();
  });
  expect(byName("zz-new")).toMatchObject({ workspace: "user:sample", status: "ready" });

  const key = byName("stripe-test");
  await act(async () => {
    expect(await hook.swap(key, { kind: "rotated", payload: { value: "zz-sample-rotated-value" } })).toBeNull();
  });
  expect(byName("stripe-test").version_count).toBe((key.version_count ?? 0) + 1);

  const request = hook.rows.find((r) => r.status === "requested")!;
  await act(async () => {
    expect(await hook.fill(request, { value: "zz-sample-filled-value" })).toEqual({ delivered: true });
  });
  expect(byName(request.name).status).toBe("ready");

  await act(async () => {
    hook.actions.setAskFirst(key._id, true);
    hook.actions.setAskFirst(key._id, false);
    hook.actions.updateMeta(key._id, { note: "zz note" });
    hook.actions.remove(byName("zz-new")._id);
  });
  expect(byName("stripe-test")).toMatchObject({ note: "zz note" });
  expect(byName("stripe-test").ask_first).toBeFalsy();
  expect(hook.rows.find((r) => r.name === "zz-new")).toBeUndefined();

  expect(calls).toEqual([]);
  expect(storeSnapshot()).toBe(before);
});
