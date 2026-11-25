// ct-101462: in a diff of one file, marking that file Viewed must not fold it
// away and leave the panel empty. With several files, marking one still folds
// it (the guard), so a reviewer can put finished pages face down.
import { afterAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { FileDiffLayout, type DiffFlow } from "../FileDiffLayout";
import { closeDomWindow } from "../../test-helpers/domGlobals";

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
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const fileA = { filename: "a.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
  patch: "@@ -1,1 +1,1 @@\n-const alpha = 1;\n+const alpha = 2;" };
const fileB = { filename: "b.ts", status: "modified", additions: 1, deletions: 1, changes: 2,
  patch: "@@ -1,1 +1,1 @@\n-const beta = 1;\n+const beta = 2;" };

const flow: DiffFlow = {
  stickyTop: 0,
  fileId: (p) => `file-${p}`,
  fileAnchorHref: (p) => `#${p}`,
  lineHref: (p) => `#${p}`,
  shareUrl: (h) => h,
  selected: null,
  onSelectLines: () => {},
  onJumpFile: () => {},
};

function Harness({ files, layout }: { files: typeof fileA[]; layout: "pane" | "page" }) {
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  return (
    <FileDiffLayout
      files={files}
      flow={layout === "page" ? flow : undefined}
      fileMarks={(p) => ({ viewed: viewed.has(p) })}
      onToggleViewed={(p) => setViewed((prev) => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; })}
    />
  );
}

async function mount(node: React.ReactNode) {
  const initial = useInboxStore.getState().clientState;
  useInboxStore.setState({ clientState: { ...initial, ui: { ...initial.ui, file_diff_view_mode: "unified" } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return {
    container,
    async clickViewed(index: number) {
      const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      await act(async () => { boxes[index].click(); });
    },
    async done() {
      await act(() => root.unmount());
      container.remove();
      useInboxStore.setState({ clientState: initial });
    },
  };
}

for (const layout of ["pane", "page"] as const) {
  test(`${layout}: marking the only file Viewed keeps its diff on screen`, async () => {
    const m = await mount(<Harness files={[fileA]} layout={layout} />);
    try {
      expect(m.container.textContent).toContain("alpha = 2");
      await m.clickViewed(0);
      expect((m.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
      expect(m.container.textContent).toContain("alpha = 2");
    } finally { await m.done(); }
  });

  test(`${layout}: with several files, marking one Viewed still folds it`, async () => {
    const m = await mount(<Harness files={[fileA, fileB]} layout={layout} />);
    try {
      expect(m.container.textContent).toContain("alpha = 2");
      await m.clickViewed(0);
      expect(m.container.textContent).not.toContain("alpha = 2");
      expect(m.container.textContent).toContain("beta = 2");
    } finally { await m.done(); }
  });
}
