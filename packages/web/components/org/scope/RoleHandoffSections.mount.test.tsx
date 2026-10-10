// The role page's merge step (the-line.md L12), handoff banner, succession
// list and split dialog (org-staffing.md S32, S34) on the org fixture.
// Run: cd packages/web && bun test components/org/scope/RoleHandoffSections.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { OrgRole, OrgTree } from "../orgTypes";

async function verify() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  const calls: Array<{ fn: string; args: any }> = [];
  mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  mock.module("../../../hooks/useCoarseNow", () => ({ useCoarseNow: () => Date.now() }));
  mock.module("../../ui/dialog", () => ({
    Dialog: ({ open, children }: any) => (open ? React.createElement("div", { "data-dialog": true }, children) : null),
    DialogContent: ({ children, ...rest }: any) => React.createElement("div", rest, children),
    DialogHeader: ({ children }: any) => React.createElement("div", null, children),
    DialogTitle: ({ children }: any) => React.createElement("h2", null, children),
    DialogDescription: ({ children }: any) => React.createElement("p", null, children),
  }));

  const { ORG_FIXTURE } = await import("../orgFixture");
  const base = ORG_FIXTURE as OrgTree;
  // The fixture holds one role; a second lead stands in as the other side of
  // a handoff and a succession.
  const second = { ...base.roles[0], _id: "org_roles_ads", short_id: "or-99", handle: "ads", name: "Ads lead", scope_names: { projects: [{ id: "projects_ads", title: "Ads" }], plans: [] } } as OrgRole;
  const tree = { ...base, roles: [...base.roles, second] } as OrgTree;
  const { createRoot } = await import("react-dom/client");
  const { HandingOverSection, MergeStepSwitch, SplitRoleSection, SuccessionSection, mergeStepWords, splitReadiness } = await import("./RoleHandoffSections");
  // The three writes are store actions that ride dispatch to orgLineMerge.setLineMerge,
  // orgHandoff.settle and orgSplit.split; each spy records the server call its
  // dispatch handler makes (convex/dispatch.ts), by the mutation's name.
  const { useInboxStore } = await import("../../../store/inboxStore");
  const record = (fn: string, args: any, answer: any = {}) => { calls.push({ fn, args }); return answer; };
  useInboxStore.setState({
    setOrgLineMerge: async (role_id: string, on: boolean, per_day?: number) => record("setLineMerge", { role_id, on, ...(per_day !== undefined ? { per_day } : {}) }),
    settleOrgHandoff: async (role_id: string, how: "run" | "close") => record("settle", { role_id, how }),
    splitOrgRole: async (args: any) => record("split", { role_id: args.role_id, halves: args.halves, standing_session: args.standing_session }, { roles: [{ handle: args.halves[0].handle }, { handle: args.halves[1].handle }], handoff: { deadline: Date.now() + 86_400_000 } }),
  } as any);
  const root = createRoot(document.getElementById("root")!);
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
  const text = () => document.body.textContent ?? "";
  const render = async (node: React.ReactElement) => { await act(async () => { root.render(node); }); };

  const growth = tree.roles.find((r) => r.handle !== "head-of-people" && r.status === "active")!;
  const other = tree.roles.find((r) => r._id !== growth._id && r.status !== "retired") ?? tree.roles.find((r) => r._id !== growth._id)!;

  // ── the merge switch: off by default, says so; on without a grant asks for the limit and writes it in one act ──
  assert.equal(mergeStepWords(null), "Reading the line");
  assert.match(mergeStepWords({ on: false, allowed: false, reason: "merge is off", used: 0, limit: null }), /left for a person/);
  assert.match(mergeStepWords({ on: true, allowed: true, reason: null, used: 1, limit: 3 }), /1 of 3 today/);
  assert.match(mergeStepWords({ on: true, allowed: false, reason: "the role's merge authority has expired", used: 0, limit: 3 }), /not now: the role's merge authority has expired/);
  await render(React.createElement(MergeStepSwitch, { role: growth, canEdit: true, merge: { on: false, allowed: false, reason: "merge is off for this line", used: 0, limit: null } }));
  assert.equal(q("[data-merge-step]")!.getAttribute("data-merge-step"), "off");
  await act(async () => { q<HTMLButtonElement>("[role=switch]")!.click(); });
  assert.ok(q("[data-merge-limit-form]"), "no grant yet: the switch asks for a daily limit first");
  assert.equal(calls.length, 0);
  assert.equal(q<HTMLInputElement>("[data-merge-limit-form] input[type=number]")!.value, "3", "a sensible default limit is filled in");
  await act(async () => { q<HTMLButtonElement>("[data-merge-limit-form] button[type=submit]")!.click(); });
  assert.deepEqual(calls.pop(), { fn: "setLineMerge", args: { role_id: growth._id, on: true, per_day: 3 } });
  // With a grant already held, on is one click; off is one click.
  await render(React.createElement(MergeStepSwitch, { role: growth, canEdit: true, merge: { on: false, allowed: false, reason: "merge is off for this line", used: 0, limit: 3 } }));
  await act(async () => { q<HTMLButtonElement>("[role=switch]")!.click(); });
  assert.deepEqual(calls.pop(), { fn: "setLineMerge", args: { role_id: growth._id, on: true } });
  await render(React.createElement(MergeStepSwitch, { role: { ...growth, line_merge: true }, canEdit: true, merge: { on: true, allowed: true, reason: null, used: 0, limit: 3 } }));
  assert.equal(q("[data-merge-step]")!.getAttribute("data-merge-step"), "on");
  await act(async () => { q<HTMLButtonElement>("[role=switch]")!.click(); });
  assert.deepEqual(calls.pop(), { fn: "setLineMerge", args: { role_id: growth._id, on: false } });

  // ── the handoff banner: receivers, their state, the deadline, and the two acts ──
  const project = growth.scope_names.projects[0];
  const handing: OrgRole = { ...growth, handing_over: { reason: "retire", started_at: Date.now() - 3_600_000, deadline: Date.now() + 20 * 3_600_000, by: "u", trigger_id: "tr1", receivers: [{ role_id: other._id, handle: other.handle, project_ids: project ? [project.id] : [], plan_ids: [] }], retire: {} } };
  await render(React.createElement(HandingOverSection, { tree, role: handing, canEdit: true }));
  assert.equal(q("[data-handing-over]")!.getAttribute("data-handing-over"), "retire");
  assert.match(text(), /It retires once this lands/);
  assert.match(text(), new RegExp(`@${other.handle}`));
  if (project) assert.match(text(), new RegExp(`takes ${project.title}`));
  assert.match(text(), /waiting/);
  assert.match(text(), /20h left/);
  await act(async () => { [...qa<HTMLButtonElement>("button")].find((b) => b.textContent === "Hand over now")!.click(); });
  assert.deepEqual(calls.pop(), { fn: "settle", args: { role_id: growth._id, how: "run" } });
  await act(async () => { [...qa<HTMLButtonElement>("button")].find((b) => /Close and retire now/.test(b.textContent ?? ""))!.click(); });
  assert.deepEqual(calls.pop(), { fn: "settle", args: { role_id: growth._id, how: "close" } });
  await render(React.createElement(HandingOverSection, { tree, role: growth, canEdit: true }));
  assert.equal(q("[data-handing-over]"), null, "no banner when nothing is handed over");

  // ── succession: which role it took which area from, and whether the rest came ──
  const succeeded: OrgRole = { ...growth, succeeded: [{ project_id: project?.id, from_role_id: other._id, from_handle: other.handle, from_name: other.name, at: Date.now() - 86_400_000, lines: 1 }, { plan_id: "plans_x", from_role_id: "gone", from_handle: "old-lead", from_name: "Old", at: Date.now(), lines: 0, handed_at: Date.now() }] };
  await render(React.createElement(SuccessionSection, { tree, role: succeeded }));
  assert.equal(qa("[data-succession-row]").length, 2);
  assert.match(text(), /1 line, handoff pending/);
  assert.match(text(), /@old-lead/);
  assert.match(text(), /no line, handoff/);

  // ── the split: readiness is pure; the dialog places every area and sends the partition ──
  const halves: [any, any] = [{ handle: "growth-a", name: "A" }, { handle: "growth-b", name: "B" }];
  const areas = [{ key: "project:1" }, { key: "project:2" }, { key: "plan:3" }];
  assert.equal(splitReadiness(areas, {}, halves), "Place 3 more areas");
  assert.equal(splitReadiness(areas, { "project:1": 0, "project:2": 0, "plan:3": 0 }, halves), "@growth-b would own nothing");
  assert.equal(splitReadiness(areas, { "project:1": 0, "project:2": 1, "plan:3": 1 }, halves), null);
  assert.equal(splitReadiness(areas, { "project:1": 0, "project:2": 1, "plan:3": 1 }, [halves[0], { handle: "growth-a", name: "B" }]), "The two roles need different handles");
  assert.match(splitReadiness(areas, {}, [{ handle: "A!", name: "A" }, halves[1]])!, /not a handle/);

  const wide: OrgRole = { ...growth, scope_names: { projects: [{ id: "p1", title: "Website" }, { id: "p2", title: "Ads" }], plans: [{ id: "pl1", title: "Launch", short_id: "pl-1" }] }, handing_over: undefined };
  await render(React.createElement(SplitRoleSection, { tree, role: wide, canEdit: true }));
  assert.ok(q("[data-split-section]"));
  await act(async () => { [...qa<HTMLButtonElement>("button")].find((b) => /Split into two leads/.test(b.textContent ?? ""))!.click(); });
  assert.ok(q("[data-split-dialog]"));
  assert.equal(q("[data-split-readiness]")!.textContent, "Place 3 more areas");
  const place = async (title: string, side: 0 | 1) => { await act(async () => { q(`[data-split-area="${title}"]`)!.querySelectorAll<HTMLButtonElement>("button")[side].click(); }); };
  await place("Website", 0); await place("Ads", 1); await place("Launch", 1);
  assert.equal(q("[data-split-readiness]")!.textContent, "Ready");
  await act(async () => { [...qa<HTMLButtonElement>("button")].find((b) => b.textContent === "Split")!.click(); });
  const sent = calls.pop()!;
  assert.equal(sent.fn, "split");
  assert.deepEqual(sent.args, { role_id: growth._id, halves: [{ name: `${growth.name} A`, handle: `${growth.handle}-a`, refs: ["project:p1"] }, { name: `${growth.name} B`, handle: `${growth.handle}-b`, refs: ["project:p2", "plan:pl1"] }], standing_session: "keep" });
  // One area or a handoff in flight: no split offered.
  await render(React.createElement(SplitRoleSection, { tree, role: { ...wide, scope_names: { projects: wide.scope_names.projects.slice(0, 1), plans: [] } }, canEdit: true }));
  assert.equal(q("[data-split-section]"), null);
  await render(React.createElement(SplitRoleSection, { tree, role: handing, canEdit: true }));
  assert.equal(q("[data-split-section]"), null);

  await act(async () => { root.unmount(); });
}

test("merge step, handoff banner, succession and split on the role page (L12, S32, S34)", verify, 60_000);
