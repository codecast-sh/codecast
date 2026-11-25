import { afterAll, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// A tool card's "Open in editor": the header carries one compact button, and
// pressing it opens the file at the range the tool touched, the edited lines
// flashed for an Edit, without toggling the row.

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

const opened: Array<{ target: Record<string, unknown>; opts: Record<string, unknown> }> = [];
const realPane = { ...(await import("../../../lib/filesPane")) };
mock.module("../../../lib/filesPane", () => ({
  ...realPane,
  openInEditor: (target: Record<string, unknown>, opts: Record<string, unknown> = {}) => opened.push({ target, opts }),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const { ToolBlock } = await import("../blocks/toolBlocks");
const { FilePathContext } = await import("../../../lib/filePathLinks");

const client = offlineConvexClient();

async function mount(tool: { id: string; name: string; input: string }, result?: { tool_use_id: string; content: string }) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ConvexProvider client={client}>
        <MemoryRouter>
          <FilePathContext.Provider value={{ base: "/Users/ada/src/app", home: "/Users/ada" }}>
            <ToolBlock tool={tool as never} result={result as never} />
          </FilePathContext.Provider>
        </MemoryRouter>
      </ConvexProvider>,
    );
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

async function press(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>("[data-open-in-editor]");
  expect(button).not.toBeNull();
  await act(async () => {
    button!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

describe("tool card Open in editor", () => {
  test("an Edit opens at the edited lines and flashes them", async () => {
    opened.length = 0;
    const input = JSON.stringify({ file_path: "/Users/ada/src/app/lib/x.ts", old_string: "a", new_string: "const b = 2;\nconst c = 3;" });
    const snippet = "The file has been updated. Here's the result:\n    40→// head\n    41→const b = 2;\n    42→const c = 3;\n    43→// tail";
    const { host, unmount } = await mount({ id: "t1", name: "Edit", input }, { tool_use_id: "t1", content: snippet });
    await press(host);
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toMatchObject({ path: "/Users/ada/src/app/lib/x.ts", line: 41, endLine: 42 });
    expect((opened[0].target.ctx as { base?: string }).base).toBe("/Users/ada/src/app");
    // The press is the button's: the row did not expand or collapse under it.
    expect(host.querySelector("[data-cc-row-head]")?.getAttribute("aria-expanded")).toBe("true");
    await unmount();
  });

  test("a Read opens at its offset, without a flash", async () => {
    opened.length = 0;
    const input = JSON.stringify({ file_path: "lib/y.ts", offset: 120, limit: 40 });
    const { host, unmount } = await mount({ id: "t2", name: "Read", input }, { tool_use_id: "t2", content: "   120\tx" });
    await press(host);
    expect(opened[0].target).toMatchObject({ path: "lib/y.ts", line: 120 });
    expect(opened[0].target.endLine).toBeUndefined();
    await unmount();
  });

  test("a Write opens at the top; a tool with no file has no button", async () => {
    opened.length = 0;
    const write = await mount({ id: "t3", name: "Write", input: JSON.stringify({ file_path: "/tmp/z.md", content: "# z" }) });
    await press(write.host);
    expect(opened[0].target).toMatchObject({ path: "/tmp/z.md", line: 1 });
    await write.unmount();
    const bash = await mount({ id: "t4", name: "Bash", input: JSON.stringify({ command: "ls" }) });
    expect(bash.host.querySelector("[data-open-in-editor]")).toBeNull();
    await bash.unmount();
  });
});
