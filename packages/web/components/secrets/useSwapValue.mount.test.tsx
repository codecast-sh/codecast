// useSwapValue paints a rotate or restore on the row, Activity and Previous at
// the press, each new line pending until the server answers, puts all three
// back on a refusal, and never lets the value reach the store.
// Run: cd packages/web && bun test components/secrets/useSwapValue.mount.test.tsx
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/vault", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");

const calls: Array<[string, any]> = [];
let answer: (res: unknown) => void = () => {};
// The events query's answer, the same array every render, as a live subscription holds it.
const EVENTS_ANSWER = [{ _id: "e1", kind: "read", at: 40 }];
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useAction: (ref: any) => (args: any) => {
    calls.push([getFunctionName(ref), args]);
    return new Promise((r) => (answer = r));
  },
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, EVENTS_ANSWER])),
}));
const authState = await import("../../hooks/useServerAuthSettled");
mock.module("../../hooks/useServerAuthSettled", () => ({ ...authState, useServerAuthSettled: () => true, useServerIdentityLost: () => false }));

const { useInboxStore } = await import("../../store/inboxStore");
const { useSecretHistory, useSwapValue, useSwapPending } = await import("../../hooks/useSyncSecrets");
const { applyCollectionFeed } = await import("../../hooks/useSyncCollection");

const ROW = { _id: "s1", short_id: "sec-1", name: "zz-key", kind: "key", status: "ready", workspace: "user:u1", fingerprint: "fp-now", version_count: 1, updated_at: 1 } as any;
const KEPT = { _id: "v1", rotated_at: 50, fingerprint: "fp-old", expires_at: 9e15 };
const READ = { _id: "e1", kind: "read", at: 40 };

let root: Root;
const hook: { swap?: ReturnType<typeof useSwapValue>; pending?: boolean } = {};
function Probe() {
  hook.swap = useSwapValue();
  hook.pending = useSwapPending("s1");
  return null;
}
const history = (key: string) => (useInboxStore.getState() as any).secretHistory?.[key]?.rows;
const row = () => (useInboxStore.getState() as any).secrets.s1;

beforeEach(async () => {
  calls.length = 0;
  useInboxStore.setState((s: any) => ({
    currentUser: { ...(s.currentUser ?? {}), _id: "u1", name: "Ada" },
    secrets: { s1: ROW },
    pending: {},
    secretHistory: { "events:s1": { _id: "events:s1", rows: [READ] }, "versions:s1": { _id: "versions:s1", rows: [KEPT] } },
  }));
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

test("a restore shows at the press, pending, and a refusal puts the row, Activity and Previous back", async () => {
  let done!: Promise<string | null>;
  await act(async () => {
    done = hook.swap!(ROW, { kind: "restored", version: KEPT });
  });
  expect(calls).toEqual([["secrets:restore", { ref: "s1", version: "v1" }]]);
  expect(row()).toMatchObject({ fingerprint: "fp-old", version_count: 1 });
  expect(history("events:s1")[0]).toMatchObject({ kind: "restored", actor_name: "Ada", pending: true });
  expect(history("versions:s1")).toEqual([expect.objectContaining({ fingerprint: "fp-now", pending: true })]);
  expect(hook.pending).toBe(true);

  await act(async () => answer({ error: "Ask first holds it" }));
  expect(await done).toBe("Ask first holds it");
  expect(row()).toEqual(ROW);
  expect(history("events:s1")).toEqual([READ]);
  expect(history("versions:s1")).toEqual([KEPT]);
  expect(hook.pending).toBe(false);
});

test("a rotate sends the value only to the action; the store holds its fingerprint and a pending line", async () => {
  const value = "zz-fixture-new-value-123";
  let done!: Promise<string | null>;
  await act(async () => {
    done = hook.swap!(ROW, { kind: "rotated", payload: { value } });
  });
  expect(calls[0]).toEqual(["secrets:rotate", { ref: "s1", payload: { value } }]);
  expect(row().version_count).toBe(2);
  expect(history("events:s1")[0]).toMatchObject({ kind: "rotated", pending: true });
  const s = useInboxStore.getState() as any;
  expect(JSON.stringify([s.secrets, s.secretHistory, s.pending])).not.toContain(value);

  await act(async () => answer({ id: "s1" }));
  expect(await done).toBeNull();
  // The answer settles nothing on its own: the line stays pending until the events query replaces it.
  expect(hook.pending).toBe(true);
});

test("a re-render of the panel keeps the staged line; only a new answer replaces it", async () => {
  // The Activity feeder beside the press, as the detail panel mounts it.
  function Panel() {
    useSecretHistory("events", "s1", true);
    return <Probe />;
  }
  await act(async () => root.render(<Panel />));
  expect(history("events:s1")).toEqual(EVENTS_ANSWER);
  await act(async () => {
    void hook.swap!(ROW, { kind: "restored", version: KEPT });
  });
  await act(async () => root.render(<Panel />));
  await act(async () => root.render(<Panel />));
  expect(history("events:s1")[0]).toMatchObject({ kind: "restored", pending: true });
  expect(hook.pending).toBe(true);
});

test("a list push before the server answers keeps the swap; the server's row retires the hold", async () => {
  await act(async () => {
    void hook.swap!(ROW, { kind: "restored", version: KEPT });
  });
  // Another secret changed (an agent read it), so the list pushes again with this row as it was.
  const OTHER = { ...ROW, _id: "s2", short_id: "sec-2", name: "zz-other", use_count: 3 };
  applyCollectionFeed("secrets", [ROW, OTHER]);
  expect(row().fingerprint).toBe("fp-old");

  await act(async () => answer({ id: "s1" }));
  applyCollectionFeed("secrets", [{ ...ROW, fingerprint: "fp-old", updated_at: 9 }, OTHER]);
  expect((useInboxStore.getState() as any).pending["secrets:s1:fingerprint"]).toBeUndefined();
  applyCollectionFeed("secrets", [{ ...ROW, fingerprint: "fp-later", updated_at: 10 }, OTHER]);
  expect(row().fingerprint).toBe("fp-later");
});

test("a refused swap holds the old value only until the next push", async () => {
  await act(async () => {
    void hook.swap!(ROW, { kind: "restored", version: KEPT });
  });
  await act(async () => answer({ error: "Ask first holds it" }));
  expect(row().fingerprint).toBe("fp-now");
  applyCollectionFeed("secrets", [ROW]);
  expect((useInboxStore.getState() as any).pending["secrets:s1:fingerprint"]).toBeUndefined();
});
