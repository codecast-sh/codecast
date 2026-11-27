import { afterAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// A ```cast-diff fence in a message: each file card carries an Edit that opens
// the file in the session's checkout at its first changed line. A git diff
// names files from the checkout's root, so the path resolves there, not in the
// session's working directory. With no conversation around it (a doc, a share
// page) nothing resolves the path and the card carries no Edit.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const opened: Array<Record<string, unknown>> = [];
const realPane = { ...(await import("../../lib/filesPane")) };
mock.module("../../lib/filesPane", () => ({
  ...realPane,
  openConversationPath: (target: Record<string, unknown>) => opened.push(target),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { InlineDiff } = await import("../InlineDiff");
const { FilePathContext } = await import("../../lib/filePathLinks");
const { editorTargetPath } = realPane;

const RAW = "diff --git a/packages/web/lib/x.ts b/packages/web/lib/x.ts\n--- a/packages/web/lib/x.ts\n+++ b/packages/web/lib/x.ts\n@@ -10,2 +10,3 @@\n a\n+b\n c\n";

async function mount(ctx: Record<string, unknown> | null) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <FilePathContext.Provider value={ctx}>
          <InlineDiff raw={RAW} />
        </FilePathContext.Provider>
      </MemoryRouter>,
    );
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

describe("cast-diff file card Edit", () => {
  test("opens the file from the checkout root at its first changed line", async () => {
    opened.length = 0;
    const { host, unmount } = await mount({ base: "/Users/ada/src/app/packages/web", gitRoot: "/Users/ada/src/app", home: "/Users/ada" });
    const button = host.querySelector<HTMLButtonElement>("[data-open-in-editor]");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toHaveLength(1);
    expect(opened[0].line).toBe(11);
    expect(editorTargetPath(opened[0] as never)).toBe("/Users/ada/src/app/packages/web/lib/x.ts");
    await unmount();
  });

  test("no conversation, no Edit", async () => {
    const { host, unmount } = await mount(null);
    expect(host.querySelector("[data-open-in-editor]")).toBeNull();
    expect(host.textContent).toContain("packages/web/lib/x.ts");
    await unmount();
  });
});
