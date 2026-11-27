// Settings > Daemon's Update waits for the latest release, so a press always
// names a version: the hook says "still reading" apart from "the read failed".
// Run: cd packages/web && bun test lib/latestCliRelease.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";

let answer: () => Promise<Response> = async () => new Response("{}", { status: 500 });
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.sh/settings/daemon" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: () => answer(),
});
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useLatestCliRelease } = await import("./latestCliRelease");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function mount() {
  const seen: Array<string | null | undefined> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const inner = answer;
  answer = async () => { await gate; return inner(); };
  function Probe() {
    seen.push(useLatestCliRelease());
    return null;
  }
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(Probe)); });
  const before = seen.at(-1);
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
  answer = inner;
  await act(async () => { root.unmount(); });
  return { before, after: seen.at(-1) };
}

test("reading: undefined; failed: null; read: the version", async () => {
  answer = async () => new Response("{}", { status: 500 });
  expect(await mount()).toEqual({ before: undefined, after: null });
  answer = async () => new Response(JSON.stringify({ version: "1.1.310" }), { status: 200 });
  expect(await mount()).toEqual({ before: undefined, after: "1.1.310" });
});
