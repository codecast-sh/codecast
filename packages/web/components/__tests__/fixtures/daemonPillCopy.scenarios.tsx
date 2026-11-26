import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// ct-102050: the header daemon pill copies its fix command when clicked. A
// person must be able to see that the click did something: on success a
// visible confirmation naming the command, on a refused clipboard the command
// itself to copy by hand, never a silent no-op or a false "Copied".
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { DaemonHealthHarness, daemonHealthClient, seedDaemonHealth, healthRows, healthProbe } = await import("./daemonHealth");
const { useInboxStore } = await import("../../../store/inboxStore");
const realNow = Date.now;
const realFetch = globalThis.fetch;
const now = realNow();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const client = daemonHealthClient();
const settle = (ms = 0) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const pill = () => host.querySelector<HTMLElement>('[data-global] [data-daemon-pill="pill"]')!;
const bodyText = () => document.body.textContent ?? "";
const count = (s: string, sub: string) => s.split(sub).length - 1;
const clipboard: { written: string[]; refuse: boolean } = { written: [], refuse: false };

const mountOffline = async () => {
  sessionStorage.setItem("cast_term_endpoint", JSON.stringify({ port: 45123, token: "laptop", deviceId: "laptop", tmux: true }));
  await act(() => root.render(<DaemonHealthHarness client={client} />));
  await act(() => { Date.now = () => now + 61_000; document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  await settle();
  const rows = healthRows(Date.now());
  await act(() => useInboxStore.getState().setMachineRoster(rows.map(d => d.device_id === "laptop" ? { ...d, last_seen: Date.now() - 12 * 3_600_000, online: false } : d)));
  await settle();
};
const click = async (el: HTMLElement) => {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle(10);
};

beforeEach(() => {
  seedDaemonHealth(); localStorage.clear(); sessionStorage.clear();
  clipboard.written = []; clipboard.refuse = false;
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: {
    writeText: async (t: string) => { if (clipboard.refuse) throw new Error("NotAllowedError"); clipboard.written.push(t); },
  } });
  (document as any).execCommand = () => !clipboard.refuse;
  globalThis.fetch = healthProbe as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = realFetch; });
afterAll(() => { Date.now = realNow; dom.window.close(); restore(); });

test("clicking the offline pill copies its command and visibly says so, naming the command", async () => {
  await mountOffline();
  expect(pill().getAttribute("aria-label")).toContain("daemon offline");
  const before = bodyText();
  expect(before).not.toMatch(/copied/i);
  const commandShownBefore = count(before, "cast restart");
  await click(pill());
  expect(clipboard.written).toEqual(["cast restart"]);
  const after = bodyText();
  // A visible word, not only a 10px glyph swap: the confirmation says it copied
  // and names what it copied.
  expect(after).toMatch(/copied/i);
  expect(count(after, "cast restart")).toBeGreaterThan(commandShownBefore);
});

test("the pill says it copies, and names the command, before anyone clicks it", async () => {
  await mountOffline();
  const p = pill();
  const name = `${p.getAttribute("aria-label") ?? ""} ${p.getAttribute("title") ?? ""}`;
  expect(name).toMatch(/copy/i);
  expect(name).toContain("cast restart");
});

test("a refused clipboard shows the command to copy by hand, never a silent no-op", async () => {
  await mountOffline();
  clipboard.refuse = true;
  const before = bodyText();
  const commandShownBefore = count(before, "cast restart");
  await click(pill());
  const after = bodyText();
  expect(after).not.toMatch(/copied/i);
  expect(count(after, "cast restart")).toBeGreaterThan(commandShownBefore);
});
