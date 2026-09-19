// ProjectLeadChip (docs/architecture/org-roles-run-work.md R4) mounted in
// jsdom against the REAL store: the chip reads the project and the roles from
// the store, says who leads by the one shared rule, and a pick on the project
// page paints the owner AND the role's wider scope in the same tick.
// Run: bun test components/charter/ProjectLeadChip.mount.test.tsx
import assert from "node:assert/strict";
import { afterAll, describe, it, mock } from "bun:test";
import type { OrgRole, OrgTree } from "../org/orgTypes";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"];
const priorGlobals = new Map(DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of DOM_GLOBALS) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  for (const [key, desc] of priorGlobals) {
    if (desc) Object.defineProperty(globalThis, key, desc); else delete (globalThis as any)[key];
  }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

const React = await import("react");
const { act } = React;
// The hover card's enrichment and the hire form are not under test.
mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("sonner", () => ({ toast: { success: () => {}, message: () => {}, error: () => {} } }));

const { ORG_FIXTURE } = await import("../org/orgFixture");
const { useInboxStore } = await import("../../store/inboxStore");
const { createRoot } = await import("react-dom/client");
const { ProjectLeadChip } = await import("./ProjectLeadChip");

const TEAM = "fixture-team";
const WS = `team:${TEAM}`;
const GROWTH = "fixture-project-growth";
const SITE = "fixture-project-site";
const LONE = "fixture-project-lone";
const growth = ORG_FIXTURE.roles[0];
const billing: OrgRole = { ...growth, _id: "fixture-role-billing", short_id: "or-2", name: "Billing lead", handle: "billing", scope: { project_ids: [SITE], plan_ids: [] }, scope_names: { projects: [], plans: [] } };
const tree: OrgTree = { ...ORG_FIXTURE, roles: [growth, billing] };
const row = (r: Record<string, unknown>) => ({ workspace: WS, team_id: TEAM, updated_at: 1, status: "active", task_counts: { total: 0, done: 0, in_progress: 0 }, plan_count: 0, doc_count: 0, ...r });

const seed = async (patch: Record<string, unknown>) => act(async () => { useInboxStore.setState(patch as never); });
await seed({
  currentUser: { _id: "fixture-user-me" },
  clientState: { ...(useInboxStore.getState().clientState as object), ui: { active_team_id: TEAM } },
  orgTree: tree,
  projects: {
    [GROWTH]: row({ _id: GROWTH, title: "Growth", short_id: "pr-4" }),
    [SITE]: row({ _id: SITE, title: "Site", short_id: "pr-5" }),
    [LONE]: row({ _id: LONE, title: "Lone", short_id: "pr-6" }),
  },
});

let root = createRoot(document.getElementById("root")!);
const mount = async (node: React.ReactNode) => {
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(node as never));
};
const text = () => document.body.textContent ?? "";
const chip = () => document.querySelector<HTMLElement>("[data-owner]");

describe("ProjectLeadChip", () => {
  it("the one role whose scope lists the project leads it: face, name, a link to the role", async () => {
    await mount(<ProjectLeadChip projectId={GROWTH} />);
    const el = chip()!;
    assert.equal(el.dataset.owner, growth.short_id);
    assert.match(el.textContent!, /Head of Growth/);
    assert.equal(el.getAttribute("href"), `/org/${growth.short_id}`);
    assert.ok(el.querySelector("img[data-avatar]"), "the role's face");
    assert.equal(document.querySelector("[data-project-lead]")?.getAttribute("data-project-lead"), "lead");
  });

  it("two roles on separate lines list it and it names neither: both faces and the words", async () => {
    await seed({ orgTree: { ...tree, roles: [growth, { ...billing, scope: { project_ids: [SITE, GROWTH], plan_ids: [] } }] } });
    await mount(<ProjectLeadChip projectId={GROWTH} />);
    const el = chip()!;
    assert.equal(el.dataset.owner, "watchers");
    assert.match(el.textContent!, /two roles watch this/);
    assert.equal(el.querySelectorAll("img[data-avatar]").length, 2);
    await seed({ orgTree: tree });
  });

  it("nobody lists it: No lead, and Add a lead beside it", async () => {
    await mount(<ProjectLeadChip projectId={LONE} size="xs" />);
    assert.match(text(), /No lead/);
    assert.ok(document.querySelector("[data-add-lead]"), "the Add a lead gesture");
  });

  it("naming a lead from the project page paints the owner and the role's scope in the same tick", async () => {
    await mount(<ProjectLeadChip projectId={LONE} editable />);
    await act(async () => chip()!.click());
    const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((b) => /Billing lead/.test(b.textContent ?? ""));
    assert.ok(item, `Billing lead in the menu. Body: ${text()}`);
    await act(async () => item!.click());
    const s = useInboxStore.getState();
    assert.equal((s.projects as any)[LONE].owner_role_id, billing._id);
    assert.deepEqual(s.orgTree!.roles.find((r) => r._id === billing._id)!.scope.project_ids, [SITE, LONE]);
    // The chip now reads the store it wrote: the lead is named, not watched.
    assert.equal(chip()!.dataset.owner, billing.short_id);
    assert.match(chip()!.textContent!, /Billing lead/);
    assert.equal(document.querySelector("[data-add-lead]"), null, "no Add a lead once someone leads");
  });

  it("a whole workspace role picked as lead is not narrowed to the project", async () => {
    const chief: OrgRole = { ...billing, _id: "fixture-role-ops", short_id: "or-3", name: "Operations", handle: "ops", scope: { project_ids: [], plan_ids: [] } };
    await seed({ orgTree: { ...tree, roles: [growth, billing, chief] }, projects: { ...useInboxStore.getState().projects, [SITE]: row({ _id: SITE, title: "Site", short_id: "pr-5" }) } });
    await mount(<ProjectLeadChip projectId={SITE} editable />);
    await act(async () => chip()!.click());
    const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((b) => /Operations/.test(b.textContent ?? ""));
    await act(async () => item!.click());
    const s = useInboxStore.getState();
    assert.equal((s.projects as any)[SITE].owner_role_id, chief._id);
    assert.deepEqual(s.orgTree!.roles.find((r) => r._id === chief._id)!.scope.project_ids, []);
  });

  it("another workspace's tree offers nothing and says why", async () => {
    await seed({ orgTree: { ...tree, workspace: { kind: "team", id: "other-team", name: "Other" } } });
    await mount(<ProjectLeadChip projectId={LONE} editable />);
    const el = chip()!;
    assert.ok(el.hasAttribute("data-owner-blocked"));
    assert.match(el.title, /Switch to the project's workspace/);
    assert.equal(document.querySelector("[data-add-lead]"), null);
    await seed({ orgTree: tree });
  });
});
