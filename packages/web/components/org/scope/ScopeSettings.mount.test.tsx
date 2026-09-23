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
  const state: any = { currentUser: { _id: "fixture-user-me" }, orgTree: tree, chatChannels: {}, orgIntents: [], setRoleLine: () => {}, dropOrgIntent: () => {} };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined }) }));
  mock.module("../../../hooks/useSyncWorkflows", () => ({ useWorkflows: () => ({ workflows: [] }) }));
  mock.module("../../../hooks/useCoarseNow", () => ({ useCoarseNow: () => Date.now() }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("../../tasks/TaskCommentStream", () => ({ Avatar: ({ name }: any) => React.createElement("span", { "data-avatar": name }) }));
  mock.module("../OrgScopePanel", () => ({ GatedScopeEditor: () => React.createElement("div", { "data-scope-editor": true }), InlineEdit: () => null }));
  mock.module("../RetireRoleConfirm", () => ({ RetireRoleConfirm: () => null }));
  mock.module("../../anchor/SlackConnect", () => ({ SlackConnect: () => null }));
  mock.module("../../ui/select-box", () => ({ SelectBox: ({ children, ...rest }: any) => React.createElement("select", rest, children) }));

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

  const growth = tree.roles.find((r) => r.handle !== "chief-of-staff" && r.status === "active")!;
  const root_ = tree.roles.find((r) => r.handle === "chief-of-staff");

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
  // Off: the hint says the person starts the work; a click turns it on.
  await render({ ...growth, trust: "understand" } as OrgRole);
  assert.equal(q("[data-autonomy-switch]")!.getAttribute("data-autonomy-switch"), "off");
  assert.match(text(), /you start the work, or turn this on/);
  await act(async () => { q<HTMLButtonElement>("[data-autonomy-switch]")!.click(); });
  assert.equal(calls.pop(), 'update:{"trust":"direct"}');

  // ── the limits: a closed disclosure holding the three defaults and today's use ──
  const limits = q<HTMLDetailsElement>("[data-role-limits]")!;
  assert.ok(limits, "the Limits disclosure exists");
  assert.equal(limits.open, false, "closed by default: the role page shows no numbers");
  const inputs = [...limits.querySelectorAll<HTMLInputElement>("input[type=number]")].map((i) => i.value);
  assert.deepEqual(inputs, ["6", "40", "400000"], "the defaults are filled in when the role has none of its own");
  assert.match(limits.textContent!, /today 1/);
  assert.match(text(), /A safety net with the defaults filled in/);

  // ── the words: no stage, cap or budget reaches the person ──
  assert.doesNotMatch(text(), /trust|stage|\bcaps?\b|budget|allowance|understand|decide|direct/i);

  // ── the root: off, locked, and it says why ──
  if (root_) {
    await render({ ...root_, trust: "understand" } as OrgRole);
    const rs = q<HTMLButtonElement>("[data-autonomy-switch]")!;
    assert.equal(rs.getAttribute("data-autonomy-switch"), "off");
    assert.ok(rs.disabled, "the root's switch cannot be turned on");
    assert.match(text(), /root role proposes and you apply/);
  }

  // ── a viewer who cannot edit: the switch is there to read, not to press ──
  await render({ ...growth, trust: "direct" } as OrgRole, false);
  assert.ok(q<HTMLButtonElement>("[data-autonomy-switch]")!.disabled);

  await act(async () => { root.unmount(); });
}

test("the settings tab: one switch, limits behind a disclosure, no operating words (S23)", verify, 60_000);
