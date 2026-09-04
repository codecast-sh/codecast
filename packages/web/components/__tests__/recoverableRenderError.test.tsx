import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// React does not report the error a render threw. When a concurrent render
// throws and the synchronous retry succeeds, React builds a NEW Error whose
// message is only its error code — "Minified React error #520" in a production
// build — and hides the real throw in `cause`. Its default handler rethrows
// that wrapper at window.onerror, which is exactly how an unreadable
// "Uncaught: Minified React error #520" reached a user with nothing in it.
//
// This drives the real React path (a component that throws on its first
// concurrent render and renders on the sync retry) and asserts the report
// names the throw, not the code.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://app.test/inbox",
  pretendToBeVisual: true,
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  self: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});



// posthog-js (imported by lib/analytics) touches these at module scope.




const toasts: Array<{ title: string; trace: string }> = [];
mock.module("../../lib/errorToast", () => ({
  showErrorToast: (title: string, trace: string) => toasts.push({ title, trace }),
}));

const THROWN = "Cannot read properties of undefined (reading 'title')";

describe("recoverable render errors report the throw, not the React code", () => {
  let React: typeof import("react");
  let createRoot: typeof import("react-dom/client").createRoot;
  let root: import("react-dom/client").Root | undefined;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = undefined;
  });
  let act: typeof import("react").act;
  let reportRecoverableRenderError: (e: unknown, i?: { componentStack?: string | null }) => void;

  beforeAll(async () => {
    React = await import("react");
    act = React.act;
    ({ createRoot } = await import("react-dom/client"));
    ({ reportRecoverableRenderError } = await import("../../lib/analytics"));
  });

  test("a concurrent render that throws once is reported by its cause", async () => {
    const recovered: unknown[] = [];
    let attempts = 0;
    let bump: (n: number) => void = () => {};

    function Flaky() {
      const [n, setN] = React.useState(0);
      bump = setN;
      if (n > 0) {
        attempts++;
        // Throw on the time-sliced attempt; render on the sync retry.
        if (attempts === 1) throw new TypeError(THROWN);
      }
      return React.createElement("div", null, `n=${n}`);
    }

    const container = dom.window.document.getElementById("root")!;
    root = createRoot(container, {
      onRecoverableError: (error: unknown, info: { componentStack?: string | null }) => {
        recovered.push(error);
        reportRecoverableRenderError(error, info);
      },
    });

    await act(async () => { root!.render(React.createElement(Flaky)); });
    // A transition renders in slices, which is the path that produces the
    // wrapper — a default-lane update renders synchronously and would not.
    await act(async () => { React.startTransition(() => bump(1)); });

    // React recovered: the UI shows the post-throw render.
    expect(container.textContent).toBe("n=1");
    expect(recovered.length).toBe(1);

    // The wrapper React handed us carries the code, not the failure...
    const wrapper = recovered[0] as Error;
    expect((wrapper as { cause?: unknown }).cause).toBeInstanceOf(TypeError);

    // ...and our report names the failure anyway.
    expect(toasts.length).toBe(1);
    expect(toasts[0].title).toBe(`Recovered render error: ${THROWN}`);
    expect(toasts[0].trace).toContain(THROWN);
    expect(toasts[0].trace).toContain("Component:");
  });
});
