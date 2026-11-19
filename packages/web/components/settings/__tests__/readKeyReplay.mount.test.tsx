// A new read-only key is on screen once and in no session recording: the
// panel that shows it sits inside what codecast's recorder blocks
// ([data-private], platform analytics replayDom.ts) and what PostHog's blocks
// (.ph-no-capture), the error replay's page outline skips it, and no
// attribute anywhere carries it. Mounts the panel and reads what the
// recorders would.
// Run: cd packages/web && bun test components/settings/__tests__/readKeyReplay.mount.test.tsx
import { beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const KEY = "cc_trk_" + "4f".repeat(24);

let dom: import("jsdom").JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let MintedKey: typeof import("../TeamReadKeys").MintedKey;
let visibleOutline: typeof import("@platform/analytics/replay").visibleOutline;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MintedKey } = await import("../TeamReadKeys"));
  ({ visibleOutline } = await import("@platform/analytics/replay"));
}, 60_000);

test("the new key is on screen but in no recording", async () => {
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(MintedKey, { minted: { key_id: "k1", key: KEY, name: "Status board" }, onHide: () => {} })));

  expect(document.body.textContent).toContain(KEY);
  const holder = [...document.querySelectorAll("code")].find((el) => el.textContent === KEY)!;
  expect(holder.closest("[data-private]")?.classList.contains("ph-no-capture")).toBe(true);
  const attributes = [...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.value));
  expect(attributes.some((v) => v.includes(KEY))).toBe(false);
  const outline = visibleOutline(document.body);
  expect(outline).not.toContain(KEY);

  React.act(() => root.unmount());
  closeDomWindow(dom);
});
