// The swapped sites: each control that used to turn something consequential on
// in one press now opens the review, and only the review's own button writes.
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";

async function dom() {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  const w = d.window as any;
  const restore = replaceGlobals({
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter,
    localStorage: w.localStorage, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(w.document.getElementById("root"));
  const q = <T extends Element = HTMLElement>(sel: string) => w.document.querySelector(sel) as T | null;
  const click = (sel: string) => React.act(async () => (q(sel) as HTMLElement).click());
  const render = (el: any) => React.act(async () => root.render(el));
  const done = async () => { await React.act(async () => root.unmount()); await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); }); restore(); };
  return { React, q, click, render, done };
}

test("Allow all: the button opens the review of switching a session's prompts off; the review's button does it", async () => {
  const { React, q, click, render, done } = await dom();
  try {
    const { PermissionStackView } = await import("../../PermissionCard");
    const calls: string[] = [];
    const pending = [{ _id: "p1", tool_name: "Bash", arguments_preview: "ls", status: "pending" as const }, { _id: "p2", tool_name: "Bash", arguments_preview: "pwd", status: "pending" as const }];
    await render(React.createElement(PermissionStackView, { pending, inflight: new Set<string>(), onApprove: () => {}, onDeny: () => {}, onApproveAll: () => calls.push("approveAll"), onDenyAll: () => {}, onAllowAll: () => calls.push("allowAll") }));
    await click("[data-allow-all]");
    assert.deepEqual(calls, [], "the button alone bypasses nothing");
    assert.equal(q('[data-switch-figure="approved now"]')!.textContent, "2");
    assert.match(q('[data-switch-row="Asks first"]')!.textContent!, /Never/);
    await click("[data-switch-cancel]");
    assert.deepEqual(calls, []);
    await click("[data-allow-all]");
    await click("[data-switch-confirm]");
    assert.deepEqual(calls, ["allowAll"]);
  } finally { await done(); }
}, 120_000);

test("the line's start switch: off, a press opens the review with the line's own numbers; on, a press turns it off", async () => {
  const { React, q, click, render, done } = await dom();
  try {
    const realQuery = await import("../../../hooks/useQueryNoThrow");
    mock.module("../../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: () => ({ data: undefined }) }));
    const realTree = await import("../../../hooks/useSyncOrgTree");
    mock.module("../../../hooks/useSyncOrgTree", () => ({ ...realTree, useSyncOrgTreeFeeder: () => ({ ready: true, missing: false, refused: false, retry: () => {} }) }));
    mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
    const { LineStartSwitch } = await import("../../line/map/LineStartSwitch");
    const calls: string[] = [];
    const admit = (on: boolean): any => ({
      admission: { role: { id: "r1", handle: "quality", paused: false }, on, queued: 60, slots: 5, busy: 0, hands: 0, handsCap: 6 },
      role: { _id: "r1", handle: "quality", trust: "direct", scope: { project_ids: ["p1"] } },
      setOn: (v: boolean) => calls.push(`setOn:${v}`), setSlots: () => {},
    });
    await render(React.createElement(LineStartSwitch, { admit: admit(false), waiting: 77, ready: 60, notReady: [{ count: 17, words: "a fix to decide" }], projectId: "p1" }));
    await click("[data-line-start-switch]");
    assert.deepEqual(calls, [], "the switch alone starts nothing");
    assert.equal(q('[data-switch-figure="start within 2 min"]')!.textContent, "5");
    assert.equal(q('[data-switch-figure="ready"]')!.textContent, "60");
    assert.match(q("[data-switch-confirm]")!.textContent!, /Turn on: run all 60/);
    await click("[data-switch-confirm]");
    assert.deepEqual(calls, ["setOn:true"]);

    await render(React.createElement(LineStartSwitch, { admit: admit(true), projectId: "p1" }));
    await click("[data-line-start-switch]");
    assert.deepEqual(calls, ["setOn:true", "setOn:false"], "turning off is one press");
    assert.equal(q("[data-switch-review]"), null);
  } finally { await done(); }
}, 120_000);

test("the sharing banner: its button opens the review of who then reads what; the review's button raises the level", async () => {
  const { React, q, click, render, done } = await dom();
  try {
    mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
    mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
    const { useInboxStore } = await import("../../../store/inboxStore");
    const calls: string[] = [];
    useInboxStore.setState({
      teams: [{ _id: "t1", name: "Union", member_count: 5, shared_project_count: 2, visibility: "summary" }],
      setTeamMembershipVisibility: (team: string, level: string, mode: string) => { calls.push(`${team}:${level}:${mode}`); },
      updateClientDismissed: () => {},
    } as any);
    const { TeamSharingNudgeBanner } = await import("../../TeamSharingNudgeBanner");
    await render(React.createElement(TeamSharingNudgeBanner));
    await click("[data-share-in-full]");
    assert.deepEqual(calls, [], "the banner's button alone shares nothing");
    assert.equal(q('[data-switch-figure="teammates read"]')!.textContent, "4");
    await click("[data-switch-confirm]");
    assert.deepEqual(calls, ["t1:full:going_forward"]);
  } finally { await done(); }
}, 120_000);

test("PR merge: the button opens the review of what lands where; only the review's button merges", async () => {
  const { React, q, click, render, done } = await dom();
  try {
    const merged: any[] = [];
    const realConvex = await import("convex/react");
    mock.module("convex/react", () => ({ ...realConvex, useAction: () => async (args: any) => { merged.push(args); return {}; }, useMutation: () => async () => ({}) }));
    mock.module("sonner", () => ({ toast: Object.assign(() => {}, { success: () => {}, error: () => {} }) }));
    const { MergeMenu } = await import("../../pr/PRActions");
    const pr = { state: "open", repository: "acme/app", number: 42, title: "Fix login", base_ref: "main", head_ref: "fix-login", changed_files: 3, additions: 40, deletions: 2, checks_state: "success", mergeable: true };
    await render(React.createElement(MergeMenu, { pr }));
    await click("[data-pr-merge]");
    assert.deepEqual(merged, [], "the button alone merges nothing");
    assert.match(q("[data-switch-review]")!.textContent!, /Merge #42.*Open.*Merged/);
    assert.equal(q('[data-switch-figure="lands on"]')!.textContent, "main");
    assert.match(q("[data-switch-confirm]")!.textContent!, /Merge into main/);
    await click("[data-switch-confirm]");
    assert.equal(merged.length, 1);
    assert.equal(merged[0].number, 42);
  } finally { await done(); }
}, 120_000);

test("bulk kill: idle sessions end at once; a selection with working ones opens the review first", async () => {
  const { React, q, click, render, done } = await dom();
  try {
    const { InboxSelectionBar } = await import("../../BulkMoveSessions");
    const killed: string[][] = [];
    const idle = [{ _id: "s1", title: "Idle one", is_idle: true }];
    await render(React.createElement(InboxSelectionBar, { sessions: idle, onKill: (ids: string[]) => killed.push(ids), onClear: () => {} }));
    await click("[data-bulk-kill]");
    assert.deepEqual(killed, [["s1"]], "nothing mid-turn: one press, restore undoes it");
    assert.equal(q("[data-switch-review]"), null);

    const mixed = [{ _id: "s1", title: "Idle one", is_idle: true }, { _id: "s2", title: "Busy one", is_idle: false }];
    await render(React.createElement(InboxSelectionBar, { sessions: mixed, onKill: (ids: string[]) => killed.push(ids), onClear: () => {} }));
    await click("[data-bulk-kill]");
    assert.equal(killed.length, 1, "a working session in the selection: the press asks first");
    assert.equal(q('[data-switch-figure="cut off mid-turn"]')!.textContent, "1");
    assert.match(q('[data-switch-row="Working"]')!.textContent!, /Busy one/);
    await click("[data-switch-confirm]");
    assert.deepEqual(killed[1], ["s1", "s2"]);
  } finally { await done(); }
}, 120_000);
