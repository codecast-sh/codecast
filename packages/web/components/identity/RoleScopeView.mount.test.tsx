// The role's hover card (cohesive build spec §5.4, D14), mounted in jsdom
// against the REAL store: with the org tree it is the role's summary and
// says exactly what the role sheet's head says (whom it reports to, its
// state, what it carries, the goals it serves); it follows an optimistic
// edit in the same tick; a click opens the role's sheet inside the Org
// screen and its address anywhere else, while a goal it serves opens that
// goal instead; and without the tree it says what the enrichment knows, and
// without either a face and a name, never an error.
// Run: bun test components/identity/RoleScopeView.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { OrgTree } from "../org/orgTypes";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;

// The enrichment is the one thing not in the store: the test switches it.
const env = { card: undefined as any };
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: (_q: unknown, args: unknown) => ({ data: args === "skip" ? undefined : env.card }) }));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => h("a", { href, ...rest }, children) }));
const pushed: string[] = [];
const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push: (u: string) => pushed.push(u), replace: () => {} }), usePathname: () => "/inbox", useSearchParams: () => new URLSearchParams() }));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../store/inboxStore");
const { ORG_FIXTURE } = await import("../org/orgFixture");
const { RoleHoverContent } = await import("./RoleHoverCard");
const { useRoleHead } = await import("../org/lines/useHeads");
const { SheetFrame } = await import("../org/company/SheetFrame");
const { OrgOpenContext } = await import("../org/company/orgOpenContext");

const TEAM = "fixture-team";
const WS = `team:${TEAM}`;
const growth = ORG_FIXTURE.roles[0];
const snapshot = { short_id: "or-1", name: "Head of Growth", handle: "growth", avatar: "fox" } as const;
const row = (r: any) => ({ workspace: WS, team_id: TEAM, updated_at: 1, ...r });
const project = row({ _id: "fixture-project-growth", title: "Growth", short_id: "pj-4g", status: "active", owner_role_id: growth._id, task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, active_plan_count: 0, created_at: 1 });
const goal = row({ _id: "g1", short_id: "in-7", title: "Organic search is the first channel", status: "active", owner: { kind: "role", role_id: growth._id }, project_ids: ["fixture-project-growth"], health: "on_track", health_at: 1, user_id: "fixture-user-me", created_at: 1 });

const q = (sel: string, root: ParentNode = document) => root.querySelector(sel) as HTMLElement | null;
const qa = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const texts = (root: ParentNode) => ({
  reportsTo: q("[data-role-reports-to]", root)?.textContent?.replace(/\s+/g, " ").trim(),
  state: q("[data-role-state]", root)?.textContent,
  carries: q("[data-role-carries]", root)?.textContent,
  serves: qa("[data-summary-serves-item], [data-sheet-link]", root).filter((a) => a.closest("[data-summary-serves], [data-sheet-serves]")).map((a) => a.textContent),
});

async function mountNode(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}
const seed = (patch: Record<string, unknown>) => act(async () => { useInboxStore.setState(patch as never); });

/** The role sheet's head, built the way RoleSheet builds it. */
function SheetHead() {
  const head = useRoleHead(useInboxStore.getState().orgTree!.roles[0]);
  return h(SheetFrame, { kind: "role", idRef: "or-1", glyph: null, title: "Head of Growth", crumbs: [], facts: head.facts, serves: head.serves });
}

test("with the tree, the card is the role's summary and says what its sheet's head says", async () => {
  await seed({
    currentUser: { _id: "fixture-user-me" },
    clientState: { ...(useInboxStore.getState().clientState as object), ui: { active_team_id: TEAM } },
    orgTree: ORG_FIXTURE as OrgTree,
    projects: { [project._id]: project },
    initiatives: { g1: goal },
  });
  const card = await mountNode(h(RoleHoverContent, { role: snapshot }));
  expect(q("[data-role-scope]", card.el)!.getAttribute("data-role-scope")).toBe("tree");
  expect(q("[data-summary-title]", card.el)!.textContent).toBe("Head of Growth");
  const said = texts(card.el);
  expect(said).toEqual({ reportsTo: "↳ Ashot Petrosian", state: said.state, carries: "leads Growth", serves: ["Organic search is the first channel"] });
  expect(said.state).toBeTruthy();
  expect(q("[data-summary-carried]", card.el)!.textContent).toContain("1 project");

  const sheet = await mountNode(h(SheetHead));
  expect(texts(sheet.el)).toEqual(said);

  // Local first: renaming the project it leads moves the card in the same tick.
  await seed({ projects: { [project._id]: { ...project, title: "Growth engine", updated_at: 2 } } });
  expect(q("[data-role-carries]", card.el)!.textContent).toBe("leads Growth engine");
  await seed({ projects: { [project._id]: project } });
  await sheet.unmount();
  await card.unmount();
});

test("a click opens the role: its sheet inside the Org screen, its address elsewhere; a goal it serves opens that goal", async () => {
  pushed.length = 0;
  const outside = await mountNode(h(RoleHoverContent, { role: snapshot }));
  await act(async () => { q("[data-role-card]", outside.el)!.click(); });
  expect(pushed).toEqual(["/org/or-1"]);
  await outside.unmount();

  const opened: string[] = [];
  const inside = await mountNode(h(OrgOpenContext.Provider, { value: { open: (k: string, r: string) => opened.push(`${k}:${r}`) } }, h(RoleHoverContent, { role: snapshot })));
  await act(async () => { q("[data-role-card]", inside.el)!.click(); });
  expect(opened).toEqual(["role:or-1"]);
  await act(async () => { q("[data-summary-serves-item]", inside.el)!.click(); });
  expect(opened).toEqual(["role:or-1", "initiative:in-7"]);
  expect(pushed).toEqual(["/org/or-1"]);
  await inside.unmount();
});

test("without the tree the enrichment says what it knows; without either, a face and a name", async () => {
  await seed({ orgTree: null });
  env.card = {
    _id: growth._id, short_id: "or-1", name: "Head of Growth", handle: "growth", avatar: "fox", status: "active", trust: "decide",
    charter: "Owns organic search.\n\nNever touches billing.", reports_to: { kind: "user", name: "Ashot Petrosian" },
    scope: { projects: [{ id: "fixture-project-growth", title: "Growth", short_id: "pj-4g" }], plans: [] }, caps: null, counters: null,
  };
  const card = await mountNode(h(RoleHoverContent, { role: snapshot }));
  expect(q("[data-role-scope]", card.el)!.getAttribute("data-role-scope")).toBe("card");
  expect(q("[data-role-reports-to]", card.el)!.textContent).toBe("↳ Ashot Petrosian");
  expect(q("[data-role-carries]", card.el)!.textContent).toBe("Owns organic search.");
  expect(q("[data-summary-carried]", card.el)!.textContent).toContain("1 project");
  await card.unmount();

  env.card = undefined;
  const bare = await mountNode(h(RoleHoverContent, { role: snapshot }));
  expect(q("[data-role-scope]", bare.el)!.getAttribute("data-role-scope")).toBe("face");
  expect(q("[data-summary-title]", bare.el)!.textContent).toBe("Head of Growth");
  expect(q("[data-role-card] img", bare.el)).not.toBeNull();
  await bare.unmount();
});
