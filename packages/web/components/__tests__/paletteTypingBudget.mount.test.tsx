// The command palette's typing budget, held with a realistic cache (7,000
// sessions). Typing a query into ⌘K froze the page for seconds per key on a
// large account (ct-101297): the root <Command> kept cmdk's own filtering on,
// so on every key cmdk re-scored every mounted row, re-appended each one to
// the DOM in its sorted order, and scrolled the selection into view (a forced
// layout of the whole page). On a page carrying a long transcript, each moved
// node re-styles the page. The app already ranks the rows itself, against a
// deferred copy of the query.
// This test types a key that changes nothing about the results ("sess" →
// "sessi" → "sessio" → "session" match the same rows) and pins what such a
// key may do to the palette: no node added, moved or removed, no scroll into
// view, no read of layout. The rows still match the final query, in order.
import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNav,
  useRouter: () => ({ push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

let scrolls: string[] = [];
w.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolls.push(this.textContent?.slice(0, 40) ?? "");
};
// Every read that makes the browser lay out the page when it is dirty.
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").slice(2).find((l) => !l.includes("__tests__") && !l.includes("jsdom"))?.trim() ?? "?"}`;
let layoutReads: string[] = [];
for (const [proto, name] of [
  [w.HTMLElement.prototype, "offsetWidth"], [w.HTMLElement.prototype, "offsetHeight"], [w.HTMLElement.prototype, "offsetTop"],
  [w.HTMLElement.prototype, "offsetParent"], [w.Element.prototype, "clientWidth"], [w.Element.prototype, "clientHeight"],
  [w.Element.prototype, "scrollWidth"], [w.Element.prototype, "scrollHeight"],
] as Array<[any, string]>) {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!;
  Object.defineProperty(proto, name, { ...desc, get() { layoutReads.push(readSite(name)); return desc.get!.call(this); } });
}
for (const [owner, name] of [[w.Element.prototype, "getBoundingClientRect"], [w, "getComputedStyle"], [globalThis, "getComputedStyle"]] as Array<[any, string]>) {
  const real = owner[name];
  owner[name] = function (this: unknown, ...args: unknown[]) { layoutReads.push(readSite(name)); return real.apply(this, args); };
}

import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

const SESSIONS = 7000;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let input: HTMLInputElement;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function syntheticSessions(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `jx7${String(i).padStart(29, "0")}`;
    out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i} fixing the auth race`, user_id: "user_palette_budget", agent_type: "claude_code", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, message_count: 20 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, project_path: `/src/p${i % 40}` };
  }
  return out;
}

beforeAll(async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), currentUser: { _id: "user_palette_budget", name: "Typist" } } as any);
  const { CommandPalette } = await import("../CommandPalette");
  container = w.document.createElement("div");
  w.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConvexProvider client={fakeConvex()}><CommandPalette standalone /></ConvexProvider>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  input = container.querySelector("input[cmdk-input]") as HTMLInputElement;
});

afterAll(async () => {
  await act(async () => root.unmount());
  closeDomWindow(dom);
  restoreGlobals();
});

// The input's own handler, called as React would for a typed key (native
// event dispatch does not reach React in this jsdom setup).
function typeChar(ch: string) {
  const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"))!;
  Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input, input.value + ch);
  (input as any)[propsKey].onChange?.({ target: input, currentTarget: input, nativeEvent: new w.Event("input") });
}

const rowTexts = () => Array.from(container.querySelectorAll<HTMLElement>("[cmdk-item]")).map((row) => row.textContent ?? "");

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

test("a key that changes no result leaves the palette's DOM alone, scrolls nothing and reads no layout (7,000 sessions)", async () => {
  expect(input).toBeTruthy();
  for (const ch of "sess") { await act(async () => typeChar(ch)); }
  await settle();
  const before = rowTexts();
  expect(before.filter((t) => t.includes("fixing the auth race")).length).toBeGreaterThan(10);

  const domChanges: string[] = [];
  const mo = new w.MutationObserver((records: MutationRecord[]) => {
    for (const r of records) {
      if (r.type !== "childList") continue;
      for (const n of [...r.addedNodes, ...r.removedNodes]) domChanges.push(`${r.addedNodes.length ? "+" : "-"} ${(n.textContent ?? "").slice(0, 40)}`);
    }
  });
  mo.observe(container, { subtree: true, childList: true });
  scrolls = [];
  layoutReads = [];
  for (const ch of "ion") {
    await act(async () => typeChar(ch));
    await settle();
  }
  mo.takeRecords();
  mo.disconnect();
  const reads = [...new Set(layoutReads)];

  expect(input.value).toBe("session");
  // Same rows, same order: the query narrowed nothing.
  expect(rowTexts()).toEqual(before);
  expect({ nodesAddedOrRemovedWhileTyping: domChanges.length, sample: domChanges.slice(0, 3) }).toEqual({ nodesAddedOrRemovedWhileTyping: 0, sample: [] });
  expect({ scrollsIntoViewWhileTyping: scrolls.length }).toEqual({ scrollsIntoViewWhileTyping: 0 });
  expect({ layoutReadsWhileTyping: reads }).toEqual({ layoutReadsWhileTyping: [] });
}, 120_000);
