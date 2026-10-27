// The role page's Settings tab after S23 (docs/architecture/org-staffing.md
// S23.1, S23.2): one switch, Starts work on its own, that writes the stored
// field through the one update path; the root's switch is off and locked; the
// three limits sit behind a closed Limits disclosure with the defaults filled
// in; and no stage, cap or budget word reaches the person.
// Run: cd packages/web && bun test components/org/scope/ScopeSettings.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgRole, OrgTree } from "../orgTypes";

async function verify() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLDetailsElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  const { ORG_FIXTURE } = await import("../orgFixture");
  const tree = ORG_FIXTURE as OrgTree;
  const calls: string[] = [];
  const state: any = { currentUser: { _id: "fixture-user-me" }, clientState: { ui: {} }, projects: {}, orgTree: tree, chatChannels: {}, orgIntents: [], setRoleLine: () => {}, dropOrgIntent: () => {} };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined }) }));
  const realSyncWorkflows = { ...(await import("../../../hooks/useSyncWorkflows")) };
  mock.module("../../../hooks/useSyncWorkflows", () => ({ ...realSyncWorkflows, useWorkflows: () => ({ workflows: [] }) }));
  mock.module("../../../hooks/useCoarseNow", () => ({ useCoarseNow: () => Date.now(), useNowWhen: () => Date.now() }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  // Keep the module's other exports: mock.module is process wide in a bun run.
  const realCommentStream = { ...(await import("../../tasks/TaskCommentStream")) };
  mock.module("../../tasks/TaskCommentStream", () => ({ ...realCommentStream, Avatar: ({ name }: any) => React.createElement("span", { "data-avatar": name }) }));
  const realScopeEditors = { ...(await import("./ScopeEditors")) };
  mock.module("./ScopeEditors", () => ({ ...realScopeEditors, GatedScopeEditor: () => React.createElement("div", { "data-scope-editor": true }), InlineEdit: () => null }));
  mock.module("../RetireRoleConfirm", () => ({ RetireRoleConfirm: () => null }));
  // The faces section redraws icons through a Convex action; no client here.
  mock.module("../../../hooks/useRedrawRoleIcon", () => ({ useRedrawRoleIcon: () => ({ pending: null, rationale: null, run: () => {} }) }));
  mock.module("../../anchor/SlackConnect", () => ({ SlackConnect: () => null }));
  mock.module("../../ui/select-box", () => ({ SelectBox: ({ children, ...rest }: any) => React.createElement("select", rest, children) }));
  // The merge switch, the handoff banner and the split (RoleHandoffSections)
  // call their mutations through convex/react; no client stands here.
  const realConvexReact = { ...(await import("convex/react")) };
  mock.module("convex/react", () => ({ ...realConvexReact, useMutation: () => async () => ({}), useQuery: () => undefined }));

  const { createRoot } = await import("react-dom/client");
  const { ScopeSettings } = await import("./ScopeSettings");
  const root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const text = () => document.body.textContent ?? "";
  const render = async (role: OrgRole, canEdit = true) => {
    await act(async () => {
      root.render(React.createElement(ScopeSettings, {
        tree, role, canEdit, overlaps: [], hostName: "Ashot", model: null, standingId: null, counters: { day: "2026-09-23", hands: 1, wakes: 2, tokens: 3 },
        onUpdate: (fields: any) => calls.push(`update:${JSON.stringify(fields)}`), onReparent: () => {}, onRetire: () => {},
      } as any));
    });
  };

  const growth = tree.roles.find((r) => r.handle !== "head-of-people" && r.status === "active")!;
  const root_ = tree.roles.find((r) => r.handle === "head-of-people");

  // ── leeway to hire: off by default; a press opens the review and only its confirm turns it on; on, one press turns it off ──
  await render({ ...growth, trust: "direct" } as OrgRole);
  const hires = () => q<HTMLButtonElement>("[data-hire-leeway-switch]")!;
  assert.equal(hires().getAttribute("data-hire-leeway-switch"), "off");
  const hiresBefore = calls.length;
  await act(async () => { hires().click(); });
  assert.equal(calls.length, hiresBefore, "the switch alone lets it hire nothing");
  assert.equal(q("[data-switch-review]")!.getAttribute("data-switch-review"), "Hires without approval");
  assert.ok(document.querySelector('[data-switch-figure="approvals a hire"]'));
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-switch-confirm]")!.click(); });
  assert.equal(calls.pop(), 'update:{"hires_freely":true}');
  await render({ ...growth, trust: "direct", hires_freely: true } as OrgRole);
  assert.equal(hires().getAttribute("data-hire-leeway-switch"), "on");
  await act(async () => { hires().click(); });
  assert.equal(calls.pop(), 'update:{"hires_freely":false}');
  await render({ ...growth, trust: "direct" } as OrgRole, false);
  assert.ok(hires().disabled, "a viewer who cannot edit reads it");

  // ── containment: off by default, flips with one press, shown only on a role with an area ──
  const scoped = { ...growth, trust: "direct", scope: { project_ids: ["pz"], plan_ids: [] } } as OrgRole;
  await render(scoped);
  const keeps = () => q<HTMLButtonElement>("[data-keeps-reports-inside-switch]");
  assert.equal(keeps()!.getAttribute("data-keeps-reports-inside-switch"), "off");
  assert.equal(keeps()!.getAttribute("aria-haspopup"), null, "it flips at once, with no review");
  await act(async () => { keeps()!.click(); });
  assert.equal(calls.pop(), 'update:{"keeps_reports_inside":true}');
  await render({ ...scoped, keeps_reports_inside: true } as OrgRole);
  assert.equal(keeps()!.getAttribute("data-keeps-reports-inside-switch"), "on");
  await act(async () => { keeps()!.click(); });
  assert.equal(calls.pop(), 'update:{"keeps_reports_inside":false}');
  await render({ ...growth, trust: "direct", scope: { project_ids: [], plan_ids: [] } } as OrgRole);
  assert.equal(keeps(), null, "a role with no area holds nothing");

  // ── a hired role: the switch is on, and one click turns it off through the stored field ──
  await render({ ...growth, trust: "direct" } as OrgRole);
  const sw = q<HTMLButtonElement>("[data-autonomy-switch]")!;
  assert.equal(sw.getAttribute("data-autonomy-switch"), "on");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  assert.equal(sw.getAttribute("aria-label"), "Starts work on its own");
  assert.ok(!sw.disabled);
  await act(async () => { sw.click(); });
  assert.equal(calls.pop(), 'update:{"trust":"understand"}');
  // decide reads as on (S23.1).
  await render({ ...growth, trust: "decide" } as OrgRole);
  assert.equal(q("[data-autonomy-switch]")!.getAttribute("data-autonomy-switch"), "on");
  // Off: the hint says the person starts the work; a click opens the review of what the role may then do, and the review's own button turns it on.
  await render({ ...growth, trust: "understand" } as OrgRole);
  assert.equal(q("[data-autonomy-switch]")!.getAttribute("data-autonomy-switch"), "off");
  assert.match(text(), /you start the work, or turn this on/);
  const before = calls.length;
  await act(async () => { q<HTMLButtonElement>("[data-autonomy-switch]")!.click(); });
  assert.equal(calls.length, before, "the switch alone turns nothing on");
  // A role with no daily limit of its own has none, and the review says so.
  assert.ok(document.querySelector('[data-switch-figure="a day, no limit"]'), "the review leads with the role's daily sessions");
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-switch-confirm]")!.click(); });
  assert.equal(calls.pop(), 'update:{"trust":"direct"}');

  // ── the limits: a closed disclosure holding the three limits (none unless set) and today's use ──
  const limits = q<HTMLDetailsElement>("[data-role-limits]")!;
  assert.ok(limits, "the Limits disclosure exists");
  assert.equal(limits.open, false, "closed by default: the role page shows no numbers");
  const inputs = [...limits.querySelectorAll<HTMLInputElement>("input[type=number]")].map((i) => i.value);
  assert.deepEqual(inputs, ["", "", ""], "a role with none of its own has no limit");
  assert.ok([...limits.querySelectorAll<HTMLInputElement>("input[type=number]")].every((i) => i.placeholder === "no limit"));
  assert.match(limits.textContent!, /today 1/);
  assert.match(text(), /none unless you set one/);

  // ── the words: no stage, cap or budget reaches the person ──
  assert.doesNotMatch(text(), /trust|stage|\bcaps?\b|budget|allowance|understand|decide|direct/i);

  // ── the root: its switch works like any role's ──
  if (root_) {
    await render({ ...root_, trust: "understand" } as OrgRole);
    const rs = q<HTMLButtonElement>("[data-autonomy-switch]")!;
    assert.equal(rs.getAttribute("data-autonomy-switch"), "off");
    assert.ok(!rs.disabled, "the root's switch can be turned on");
  }

  // ── the line (plan pl-838): "Edit this line" goes to its stations; a customized copy says whose ──
  await render({ ...growth, trust: "direct" } as OrgRole);
  const edit = q<HTMLAnchorElement>("a[data-line-edit-link]")!;
  assert.ok(edit, "the Workflow section links to line settings");
  assert.match(edit.getAttribute("href")!, /^\/flows\/settings\?(project=[^&]+&)?section=stations$/);
  assert.equal(q("[data-line-customized-note]"), null, "the shipped line is not called customized");
  state.projects = { pz: { _id: "pz", short_id: "pr-9", title: "Atlas", workspace: "user:fixture-user-me" } };
  await render({ ...growth, trust: "direct", line_workflow_slug: "line-pr-9" } as OrgRole);
  assert.equal(q("[data-line-customized-note]")?.textContent, "Atlas's customized steps");
  assert.equal(q<HTMLAnchorElement>("a[data-line-edit-link]")!.getAttribute("href"), "/flows/settings?project=pr-9&section=stations");
  state.projects = {};

  // ── a viewer who cannot edit: the switch is there to read, not to press ──
  await render({ ...growth, trust: "direct" } as OrgRole, false);
  assert.ok(q<HTMLButtonElement>("[data-autonomy-switch]")!.disabled);

  await act(async () => { root.unmount(); });
  mock.module("convex/react", () => realConvexReact);
}

test("the settings tab: one switch, limits behind a disclosure, no operating words (S23)", verify, 60_000);
