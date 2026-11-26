// A card's subagents under it, mounted in jsdom from real rows through the
// shared helper (store subagentRowsOf): Folded is one line of a mark and a count
// per state, most urgent first and no words, each count opening the newest
// subagent in its state; Compact rows is one row each (mark, title, state
// word) in the same order, opening that subagent, the open one highlighted.
//
// Run: bun test components/inbox/CardSubagents.mount.test.tsx
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { InboxSession } from "../../store/inboxStore";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let parts: typeof import("./SessionCardParts");
let rowsOf: typeof import("../../store/inboxStore").subagentRowsOf;
let dom: { window: { close(): void } };

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  dom = d;
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"]) {
    const v = (d.window as any)[key];
    if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  parts = await import("./SessionCardParts");
  ({ subagentRowsOf: rowsOf } = await import("../../store/inboxStore"));
}, 60_000);

afterAll(() => {
  if (root) React.act(() => root!.unmount());
  closeDomWindow(dom);
});

let root: ReturnType<typeof createRoot> | null = null;
const opened: string[] = [];
beforeEach(() => {
  opened.length = 0;
  if (root) React.act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "<div id='root'></div>";
});

const NOW = 1_700_000_000_000;
let seq = 0;
const row = (title: string, ageMin: number, extra: Record<string, unknown> = {}): InboxSession => ({
  _id: `jx7${String(++seq).padStart(29, "0")}`,
  session_id: `s${seq}`,
  agent_type: "claude_code",
  title,
  message_count: 6,
  updated_at: NOW - ageMin * 60_000,
  agent_status_updated_at: NOW - ageMin * 60_000,
  started_at: NOW - 60 * 60_000,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  has_pending: false,
  is_connected: true,
  is_subagent: true,
  ...extra,
}) as InboxSession;

const oldWork = row("Search auth", 9, { is_idle: false, agent_status: "working" });
const newWork = row("Read docs", 2, { is_idle: false, agent_status: "working" });
const ask = row("Deploy worker", 5, { spawned_by_conversation_id: "jx7parent", agent_status: "idle" });
const doneSub = row("Map routes", 4, { status: "completed" });
const kids = [oldWork, doneSub, newWork, ask];

const render = (el: React.ReactElement) => {
  root = createRoot(document.getElementById("root")!);
  React.act(() => root!.render(el));
};
const onOpen = (s: InboxSession) => { opened.push(s.title as string); };
const click = (el: Element) => React.act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); });

test("Folded: a mark and a count per state, most urgent first, no words", () => {
  render(React.createElement(parts.CardSubagentsLine, { rows: rowsOf(kids, NOW, "all"), onOpen }));
  const line = document.querySelector("[data-sv-subagents-line]")!;
  expect(line.getAttribute("data-card-bar")).not.toBeNull();
  const counts = [...line.querySelectorAll<HTMLElement>("[data-sv-subagents-state]")];
  expect(counts.map((b) => [b.dataset.svSubagentsState, b.textContent])).toEqual([["needs_you", "1"], ["working", "2"], ["done", "1"]]);
  for (const b of counts) expect(b.querySelector("[data-status-mark]")?.getAttribute("data-status-mark")).toBe(b.dataset.svSubagentsState!);
  // No words on the line itself: only the counts (the arrow's label is an svg title).
  expect(line.textContent!.replace(/Subagents/, "")).toBe("121");
});

test("Folded: a count opens the newest subagent in its state", () => {
  render(React.createElement(parts.CardSubagentsLine, { rows: rowsOf(kids, NOW, "all"), onOpen }));
  click(document.querySelector("[data-sv-subagents-state=working]")!);
  click(document.querySelector("[data-sv-subagents-state=needs_you]")!);
  expect(opened).toEqual(["Read docs", "Deploy worker"]);
});

test("Folded: no line when the filter keeps nothing", () => {
  render(React.createElement(parts.CardSubagentsLine, { rows: rowsOf([doneSub], NOW, "active"), onOpen }));
  expect(document.querySelector("[data-sv-subagents-line]")).toBeNull();
  expect(document.getElementById("root")!.innerHTML).toBe("");
});

test("Compact rows: one row each, most urgent first, mark, title and state word", () => {
  render(React.createElement(parts.CardSubagentRows, { rows: rowsOf(kids, NOW, "active_done"), activeSessionId: null, onOpen }));
  const rows = [...document.querySelectorAll<HTMLElement>("[data-sv-subagent-row]")];
  expect(rows.map((r) => r.textContent)).toEqual(["Deploy workerNeeds you", "Read docsWorking", "Search authWorking", "Map routesDone"]);
  expect(rows.map((r) => r.querySelector("[data-status-mark]")?.getAttribute("data-status-mark"))).toEqual(["needs_you", "working", "working", "done"]);
});

test("Compact rows: a row opens its subagent, and the open one is highlighted", () => {
  render(React.createElement(parts.CardSubagentRows, { rows: rowsOf(kids, NOW, "active"), activeSessionId: String(newWork._id), onOpen }));
  const rows = [...document.querySelectorAll<HTMLElement>("[data-sv-subagent-row]")];
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.dataset.active).map((r) => r.dataset.svSubagentRow)).toEqual([String(newWork._id)]);
  click(rows[2]);
  expect(opened).toEqual(["Search auth"]);
});
