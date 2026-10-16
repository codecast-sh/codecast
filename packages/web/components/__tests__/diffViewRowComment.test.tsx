import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ConvexProvider } from "convex/react";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { fileDiffRenders } from "../../test-helpers/pierreFileDiff";
import { useInboxStore } from "../../store/inboxStore";
import { DiffView } from "../DiffView";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

// The comment affordance is Pierre's gutter button. What it produces is ours:
// the side and line (or run) a comment anchors to, the code it quotes, and,
// inside a message, a pending comment whose composer opens under that line.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const client = offlineConvexClient("https://example.convex.cloud");
const OLD = "one\ntwo\nthree";
const NEW = "one\n2\nthree";

async function mount(el: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(<ConvexProvider client={client}>{el}</ConvexProvider>));
  return { container, unmount: () => act(() => root.unmount()) };
}
const lastOptions = () => fileDiffRenders.at(-1)!.options!;

beforeEach(() => { fileDiffRenders.length = 0; });

describe("DiffView comment affordance", () => {
  test("a surface that owns the comments gets the anchor and code of the line or run", async () => {
    const onLineComment = mock(() => {});
    const view = await mount(<DiffView oldStr={OLD} newStr={NEW} showLineNumbers onLineComment={onLineComment} />);
    expect(lastOptions().enableGutterUtility).toBe(true);
    await act(() => lastOptions().onGutterUtilityClick!({ start: 2, end: 2, side: "additions" }));
    expect(onLineComment.mock.calls[0]).toEqual([{ side: "RIGHT", lineNumber: 2 }, "2", expect.anything()]);
    await act(() => lastOptions().onGutterUtilityClick!({ start: 2, end: 2, side: "deletions" }));
    expect(onLineComment.mock.calls[1].slice(0, 2)).toEqual([{ side: "LEFT", lineNumber: 2 }, "two"]);
    await act(() => lastOptions().onGutterUtilityClick!({ start: 1, end: 3, side: "additions" }));
    expect(onLineComment.mock.calls[2].slice(0, 2)).toEqual([{ side: "RIGHT", lineNumber: 1, lineEnd: 3 }, "three"]);
    await view.unmount();
  });

  test("a diff inside a message starts a pending comment and opens its composer under the line", async () => {
    const view = await mount(
      <DiffView oldStr={OLD} newStr={NEW} showLineNumbers commentContext={{ conversationId: "c1", anchorKey: "m1", filePath: "a.ts" }} />,
    );
    await act(() => lastOptions().onGutterUtilityClick!({ start: 2, end: 2, side: "additions" }));
    const pending = useInboxStore.getState().reviewComments.c1 ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ messageId: "m1", filePath: "a.ts", fileLine: 2, quote: "a.ts:2\n2" });
    expect(fileDiffRenders.at(-1)!.lineAnnotations).toEqual([{ side: "additions", lineNumber: 2, metadata: expect.anything() }]);
    expect(view.container.querySelector("textarea")?.getAttribute("placeholder")).toBe("Comment on this line…");
    await view.unmount();
    useInboxStore.getState().removeReviewComment("c1", pending[0].id);
  });

  test("an inert diff offers no comment or selection", async () => {
    const view = await mount(<DiffView oldStr={OLD} newStr={NEW} showLineNumbers />);
    expect(lastOptions().enableGutterUtility).toBe(false);
    expect(lastOptions().onGutterUtilityClick).toBeUndefined();
    expect(lastOptions().enableLineSelection).toBe(false);
    await view.unmount();
  });
});
