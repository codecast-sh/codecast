// A hard load of /settings/integrations from an OAuth callback goes through
// SettingsRedirect, which moves the window home; boot restore then puts the
// last conversation in the address bar before the lazily loaded integrations
// panel mounts. The panel must still confirm the connection from the callback
// the redirect held, or every Google connect stays pending forever.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/conversation/jx1", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const confirmed: unknown[] = [];
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvex,
  useAction: () => async (args: unknown) => {
    confirmed.push(args);
    return { ok: true };
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { holdConnectorReturn, useConnectorReturn } = await import("./useConnectorReturn");
const roots: ReturnType<typeof createRoot>[] = [];

function Reader() {
  useConnectorReturn({ quiet: true });
  return null;
}

async function mount() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => root.render(<Reader />));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  confirmed.length = 0;
});
afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

test("the panel confirms a held Google return after the address moved on", async () => {
  holdConnectorReturn("?google=pending", "#installation=inst1&confirm=tok1");
  await mount();
  expect(confirmed).toEqual([{ installation_id: "inst1", confirm_token: "tok1" }]);
});

test("a held return is read once", async () => {
  holdConnectorReturn("?google=pending", "#installation=inst2&confirm=tok2");
  await mount();
  await mount();
  expect(confirmed).toHaveLength(1);
});

test("holding a URL with no callback holds nothing", async () => {
  holdConnectorReturn("?tab=team", "");
  await mount();
  expect(confirmed).toHaveLength(0);
});

test("a second hold on the stripped address keeps the first", async () => {
  holdConnectorReturn("?google=pending", "#installation=inst3&confirm=tok3");
  holdConnectorReturn("", "");
  await mount();
  expect(confirmed).toEqual([{ installation_id: "inst3", confirm_token: "tok3" }]);
});
