import { expect, mock, test } from "bun:test";

// keepPrevious: a windowed query asked again with new args (the next
// presigning window) keeps answering with the last result while the new one
// loads, so what renders it (a playing video) is never unmounted; a different
// question (another call) loads from nothing. Rendered for real in jsdom with
// only the transport faked.
mock.restore();

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { makeFunctionReference } = await import("convex/server");
const QUERY = makeFunctionReference<"query">("callRecordings:webCallRecordings");

// The transport answers by the args it is asked with; absent means loading.
let answers: Record<string, string> = {};
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQueries: (queries: Record<string, any>) => {
    const q = queries.value;
    return q ? { value: answers[`${q.args.call}@${q.args.url_window}`] } : {};
  },
}));
const { useQueryNoThrow } = await import(`${import.meta.dir}/../useQueryNoThrow.ts?keep`);
const React = await import("react");
const { createRoot } = await import("react-dom/client");

function Probe({ call, win }: { call: string; win: number }) {
  const { data } = useQueryNoThrow(QUERY, { call, url_window: win } as any, { keepPrevious: call });
  return <span>{data ?? "loading"}</span>;
}

test("a new window keeps the last answer until its own lands; a new call does not", () => {
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const show = (call: string, win: number) => React.act(() => root.render(<Probe call={call} win={win} />));
  answers = { "cl-1@1": "window 1" };
  show("cl-1", 1);
  expect(host.textContent).toBe("window 1");
  show("cl-1", 2);
  expect(host.textContent).toBe("window 1");
  answers["cl-1@2"] = "window 2";
  show("cl-1", 2);
  expect(host.textContent).toBe("window 2");
  show("cl-2", 2);
  expect(host.textContent).toBe("loading");
  React.act(() => root.unmount());
});
