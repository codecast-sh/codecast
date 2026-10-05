import { afterAll, describe, expect, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

// The undo card opens sessions through useOpenSession, and the card mounts in
// frames outside the tab shell too (the simple lane, the standalone /r pages).
// There usePathname still reports the active tab's path (/inbox), and opening
// "in place" only writes the store's pointer: the page never moves. Outside
// the shell, opening a session must leave for it.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/r/acme/app", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router");
const { useInboxStore } = await import("../../store/inboxStore");
const { useOpenSession } = await import("../useOpenSession");

const ID = "s".repeat(32);
const prior = useInboxStore.getState();
let open: ((id: string) => void) | null = null;
let at = "";
function Probe() {
  open = useOpenSession();
  at = useLocation().pathname + useLocation().search;
  return null;
}

afterAll(() => {
  // Later files in the same run share this store.
  useInboxStore.setState(prior, true);
  dom.window.close();
  restoreGlobals();
});

describe("useOpenSession outside the tab shell", () => {
  it("leaves for the session even when the store holds an inbox tab", async () => {
    useInboxStore.setState({ tabs: [{ id: "tab_1", path: "/inbox" }], activeTabId: "tab_1", sessions: { [ID]: { _id: ID, title: "Worker" } }, currentSessionId: null } as any);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<MemoryRouter initialEntries={["/r/acme/app"]}><Probe /></MemoryRouter>));
    await act(async () => open!(ID));
    expect(at).toBe(`/inbox?s=${ID}`);
    await act(async () => root.unmount());
  });
});
