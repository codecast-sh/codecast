// The People chart's role and session cards mounted at the middle zoom level:
// each card draws every block in the box the layout booked for it, so the
// blocks add up to exactly the card's height (orgCardModel); its toggle opens
// it in place, and an open card lists what it was handed.
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/org", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "DOMMatrixReadOnly"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/org" }));
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useQuery: () => undefined, useQueries: () => ({}) }));

const { createRoot } = await import("react-dom/client");
const { ReactFlowProvider } = await import("@xyflow/react");
const { ORG_FIXTURE } = await import("./orgFixture");
const { RoleCard, SessionCard } = await import("./OrgNodeCards");
const { CARD, roleCardRows, sessionCardRows } = await import("./orgCardModel");

/** The card's own blocks: every direct child of the frame that books a height. */
const blocks = (frame: HTMLElement) => [...frame.children].filter((c) => !c.classList.contains("react-flow__handle")).map((c) => parseFloat((c as HTMLElement).style.height)).filter((x) => !Number.isNaN(x));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(h(ReactFlowProvider, null, el)); });
  return { host, done: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("a role card fills exactly its booked height, closed and opened, and its toggle opens it in place", async () => {
  const role = { ...ORG_FIXTURE.roles[0], charter: "# Growth\nOwns organic search, paid search and the weekly growth review.\n\nSecond paragraph about the review cadence and who reads it." };
  const open = { leads: [{ id: "p1", title: "Growth", short_id: "pr-4" }], tasks: [{ id: "t1", short_id: "ct-1", title: "Draft the weekly review", status: "in_progress" }, { id: "t2", short_id: "ct-2", title: "Fix the SEO report", status: "open" }] };
  const toggles: string[] = [];
  const props = (opened: boolean) => ({ id: `role:${role._id}`, data: { role, collapsed: false, hidden: 0, overflow: 0, opened, open, onToggleOpen: (id: string) => toggles.push(id) } } as any);
  const closed = await mount(h(RoleCard, props(false)));
  const frame = closed.host.querySelector("[data-org-node]") as HTMLElement;
  const rows = roleCardRows(role, { open: null });
  expect(sum(blocks(frame))).toBe(rows.h - CARD.rolePad);
  // The first paragraph of the charter, whole; no open sections.
  expect(frame.querySelector("[data-role-charter]")!.textContent).toBe("Growth Owns organic search, paid search and the weekly growth review.");
  expect(frame.querySelector("[data-role-leads]")).toBeNull();
  (frame.querySelector("[data-card-open='off']") as HTMLButtonElement).click();
  expect(toggles).toEqual([`role:${role._id}`]);
  await closed.done();

  const opened = await mount(h(RoleCard, props(true)));
  const f2 = opened.host.querySelector("[data-org-node]") as HTMLElement;
  const rows2 = roleCardRows(role, { open });
  expect(sum(blocks(f2))).toBe(rows2.h - CARD.rolePad);
  expect(rows2.h).toBeGreaterThan(rows.h);
  expect(f2.querySelector("[data-role-charter]")!.textContent).toContain("Second paragraph");
  expect(f2.querySelector("[data-role-leads='1']")!.textContent).toContain("pr-4");
  expect(f2.querySelector("[data-role-tasks='2']")!.textContent).toContain("ct-2");
  expect(f2.querySelector("[data-role-sessions]")).not.toBeNull();
  expect(f2.querySelector("[data-card-open='on']")).not.toBeNull();
  await opened.done();
});

test("a session card wraps its title, says where it stands and its task, and, opened, its latest messages, within its booked height", async () => {
  const s = { ...ORG_FIXTURE.people[0].sessions[0], title: "Rewrite the sync applier so a follower never re-pushes a whole collection" };
  const detail = { line: "Waiting on review of the applier change before measuring on desktop", task: { short_id: "ct-12", title: "Fix the applier" }, messages: [{ who: "you", text: "Is the tail fixed?" }, { who: "agent", text: "Yes, one frame now." }] };
  const toggles: string[] = [];
  const props = (opened: boolean) => ({ id: `session:${s._id}`, data: { session: s, parent: { kind: "user", user_id: "fixture-user-me" }, detail, opened, onToggleOpen: (id: string) => toggles.push(id) } } as any);
  const closed = await mount(h(SessionCard, props(false)));
  const frame = closed.host.querySelector("[data-org-node='session']") as HTMLElement;
  const rows = sessionCardRows(s, detail, false);
  expect(sum(blocks(frame))).toBe(rows.h - CARD.sessionPad);
  expect(rows.titleLines).toBe(2);
  expect(frame.querySelector("[data-session-title]")!.textContent).toContain("whole collection");
  expect(frame.querySelector("[data-session-task='ct-12']")).not.toBeNull();
  expect(frame.querySelectorAll("[data-session-message]").length).toBe(0);
  (frame.querySelector("[data-card-open]") as HTMLButtonElement).click();
  expect(toggles).toEqual([`session:${s._id}`]);
  await closed.done();

  const opened = await mount(h(SessionCard, props(true)));
  const f2 = opened.host.querySelector("[data-org-node='session']") as HTMLElement;
  expect(sum(blocks(f2))).toBe(sessionCardRows(s, detail, true).h - CARD.sessionPad);
  const msgs = [...f2.querySelectorAll("[data-session-message]")].map((m) => m.textContent);
  expect(msgs).toEqual(["you: Is the tail fixed?", "agent: Yes, one frame now."]);
  await opened.done();
});
