import { afterAll, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import Prism from "prismjs";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { FileDiffLayout } from "../FileDiffLayout";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
(dom.window as any).ResizeObserver = TestResizeObserver;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: TestResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { dom.window.close(); restoreGlobals(); });

for (const mode of ["unified", "split"] as const) {
  test(`${mode} diff keeps highlighting until patch or language changes`, async () => {
    const initial = useInboxStore.getState().clientState;
    useInboxStore.setState({ clientState: { ...initial, ui: { ...initial.ui, file_diff_view_mode: mode } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const highlight = spyOn(Prism, "highlight");
    const file = { filename: "sample.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
      patch: "@@ -1,1 +1,1 @@\n-const value = 1;\n+const value = 2;" };
    try {
      await act(() => root.render(<FileDiffLayout files={[]} />));
      await act(() => root.render(<FileDiffLayout files={[file]} />));
      const first = highlight.mock.calls.length;
      expect(first > 0).toBe(true);
      await act(() => root.render(<FileDiffLayout files={[{ ...file }]} renderFileExtra={() => <span>Changed caption</span>} />));
      expect(highlight.mock.calls.length).toBe(first);
      expect(container.textContent).toContain("Changed caption");
      await act(() => root.render(<FileDiffLayout files={[{ ...file }]} lineThreads={{
        threadsFor: () => new Map([["RIGHT:1", ["review"]]]),
        render: () => <span>New review comment</span>,
      }} />));
      expect(container.textContent).toContain("New review comment");
      expect(highlight.mock.calls.length).toBe(first);
      const changed = { ...file, patch: file.patch.replace("value = 2", "value = 3") };
      await act(() => root.render(<FileDiffLayout files={[changed]} />));
      expect(highlight.mock.calls.length > first).toBe(true);
      expect(container.textContent).toContain("value = 3");
      const beforeLanguage = highlight.mock.calls.length;
      await act(() => root.render(<FileDiffLayout files={[{ ...changed, filename: "sample.py" }]} focusFile="sample.py" />));
      expect(highlight.mock.calls.length > beforeLanguage).toBe(true);
      expect(highlight.mock.calls.at(-1)?.[2]).toBe("python");
      await act(() => root.render(<FileDiffLayout files={[{ ...file, filename: "sample.py", patch: undefined }]} focusFile="sample.py" />));
      expect(container.textContent).toContain("No changes to display");
    } finally {
      await act(() => root.unmount());
      highlight.mockRestore();
      container.remove();
      useInboxStore.setState({ clientState: initial });
    }
  });
}
