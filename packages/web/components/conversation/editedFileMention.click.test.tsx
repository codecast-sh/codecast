import { test, expect, describe, mock, afterAll, beforeEach } from "bun:test";

// ct-98182: one click on an edited file's name in a reply opens the
// conversation's diff panel on that file, at its latest change, so the reader
// sees the current text without asking the agent or searching the page. With
// no panel beside the transcript, the click leaves the diff store alone and
// the link opens the file in Files as before.

import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../../hooks/useQueryNoThrow");
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: () => ({ data: undefined }),
}));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { FilePathContext } = await import("../../lib/filePathLinks");
const { DiffPanelContext } = await import("../../lib/diffPanelLinks");
const { useToolResultMaps } = await import("../../hooks/useToolResultMaps");
const { useDiffViewerStore } = await import("../../store/diffViewerStore");
const { extractFileChanges } = await import("../../lib/fileChangeExtractor");
const { MessageMarkdown } = await import("./markdown");

const CWD = "/Users/samvit/src/codecast";
const EDITED = `${CWD}/docs/prompts/constitution.md`;
const edit = (id: string, file: string, from: string, to: string) => ({
  id,
  name: "Edit",
  input: JSON.stringify({ file_path: file, old_string: from, new_string: to }),
});

// Two edits to constitution.md with another file between them: the click must
// land on the file, at the last of its edits.
const conversation = {
  _id: "conv1",
  project_path: CWD,
  git_root: CWD,
  messages: [
    { _id: "m1", role: "user", content: "tighten the constitution prompt", timestamp: 1 },
    { _id: "m2", role: "assistant", timestamp: 2, tool_calls: [edit("tu1", EDITED, "Be brief.", "Be brief and exact.")] },
    { _id: "m3", role: "assistant", timestamp: 3, tool_calls: [edit("tu2", `${CWD}/lib/a.ts`, "a", "b")] },
    { _id: "m4", role: "assistant", timestamp: 4, tool_calls: [edit("tu3", EDITED, "Be brief and exact.", "Be exact.")] },
  ],
} as any;

function Reply({ text, panel }: { text: string; panel: boolean }) {
  const { filePathCtx } = useToolResultMaps({ conversation, codeRepository: null });
  return (
    <DiffPanelContext.Provider value={panel}>
      <FilePathContext.Provider value={filePathCtx}>
        <MessageMarkdown content={text} />
      </FilePathContext.Provider>
    </DiffPanelContext.Provider>
  );
}

function clickLinkNamed(text: string, name: string, panel: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><Reply text={text} panel={panel} /></MemoryRouter>));
  const link = Array.from(host.querySelectorAll("a")).find((a) => a.textContent?.trim() === name);
  expect(link).toBeDefined();
  const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  act(() => { link!.dispatchEvent(event); });
  act(() => root.unmount());
  host.remove();
  return event;
}

beforeEach(() => {
  const st = useDiffViewerStore.getState();
  st.setChanges("conv1", extractFileChanges(conversation.messages));
  st.selectFile(null);
  st.selectChange(0); // the reader had the timeline on the first change
  useDiffViewerStore.setState({ diffPanelOpen: false });
});

describe("clicking an edited file named in a reply", () => {
  test("a bare name opens the diff panel on that file, at its latest change", () => {
    const event = clickLinkNamed("Copied from the edited constitution.md.", "constitution.md", true);
    const st = useDiffViewerStore.getState();
    expect(st.selectedFile).toBe(EDITED);
    expect(st.diffPanelOpen).toBe(true);
    expect(st.selectedChangeIndex).toBeNull(); // the whole session, so the last edit shows
    expect(event.defaultPrevented).toBe(true); // stays in the conversation
  });

  test("a code span and a path with its directory open it the same way", () => {
    clickLinkNamed("See `constitution.md`.", "constitution.md", true);
    expect(useDiffViewerStore.getState().selectedFile).toBe(EDITED);
    useDiffViewerStore.getState().selectFile(null);
    clickLinkNamed("See docs/prompts/constitution.md.", "docs/prompts/constitution.md", true);
    expect(useDiffViewerStore.getState().selectedFile).toBe(EDITED);
  });

  test("with no diff panel beside the transcript, the link leaves the diff alone", () => {
    clickLinkNamed("Copied from the edited constitution.md.", "constitution.md", false);
    const st = useDiffViewerStore.getState();
    expect(st.selectedFile).toBeNull();
    expect(st.diffPanelOpen).toBe(false);
  });
});
