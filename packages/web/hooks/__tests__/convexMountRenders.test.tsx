import { afterAll, expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { ConvexProvider, useQuery } = await import("convex/react");
const { makeFunctionReference } = await import("convex/server");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const listQuery = makeFunctionReference<"query">("tests:list");

// A client that answers from a local cache and pushes only when told to.
function fakeClient(initial: unknown) {
  let local = initial;
  const listeners = new Set<() => void>();
  return {
    client: {
      watchQuery: () => ({
        onUpdate: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        localQueryResult: () => local,
        localQueryLogs: () => undefined,
        journal: () => undefined,
      }),
    } as any,
    push(next: unknown) { local = next; for (const cb of listeners) cb(); },
  };
}

function mountProbe(args: Record<string, unknown> | "skip", initial: unknown) {
  const fake = fakeClient(initial);
  const seen = { renders: 0, commits: 0, value: undefined as unknown };
  const Probe = () => {
    seen.renders++;
    seen.value = useQuery(listQuery, args);
    useLayoutEffect(() => { seen.commits++; });
    return null;
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ConvexProvider client={fake.client}><Probe /></ConvexProvider>));
  return { seen, fake, unmount: () => act(() => root.unmount()) };
}

// convex's useSubscription re-reads the query in its mount effect, and
// QueriesObserver.getLocalResults built a new object on every read, so every
// useQuery / useQueryNoThrow component committed twice on mount
// (patches/convex@1.36.1.patch).
test("a skipped query renders once on mount", () => {
  const { seen, unmount } = mountProbe("skip", undefined);
  expect(seen.renders).toBe(1);
  unmount();
});

test("a query still loading renders once on mount", () => {
  const { seen, unmount } = mountProbe({}, undefined);
  expect(seen.renders).toBe(1);
  expect(seen.value).toBeUndefined();
  unmount();
});

test("a query answered from the cache renders once on mount", () => {
  const rows = [{ _id: "a" }];
  const { seen, unmount } = mountProbe({}, rows);
  expect(seen.renders).toBe(1);
  expect(seen.value).toBe(rows);
  unmount();
});

// A push whose answer is unchanged may still call the component once (React
// does that before bailing out of a same-state update) but commits nothing.
test("a pushed answer commits, and a push that changes nothing does not", () => {
  const { seen, fake, unmount } = mountProbe({}, undefined);
  expect(seen.commits).toBe(1);
  const rows = [{ _id: "b" }];
  act(() => fake.push(rows));
  expect(seen.value).toBe(rows);
  expect(seen.commits).toBe(2);
  act(() => fake.push(rows));
  expect(seen.commits).toBe(2);
  unmount();
});
