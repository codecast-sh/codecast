// The gate a hand made scope gain waits at (org-roles-run-work.md R1), and the
// scope editor that mounts it: a gain that moves nothing writes by itself, a
// gain that moves sessions says how many and offers the one edit before the
// write, and an edit that only removes never waits.
// Run: bun test components/org/TakeoverGate.mount.test.tsx
import assert from "node:assert/strict";
import { afterAll, describe, it, mock } from "bun:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"];
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
// What the server answers the count with, one entry per item asked; undefined
// is "not answered yet". `asked` is what the gate sent.
let answer: unknown[] | undefined = [null];
const asked: any[] = [];
mock.module("../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: (_q: unknown, args: any) => { if (args !== "skip") asked.push(args); return { data: args === "skip" ? undefined : answer }; } }));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("../../hooks/useWorkspaceCollection", () => ({ useWorkspaceCollection: (key: string) => key === "projects" ? [{ _id: "p-growth", title: "Growth", status: "active" }, { _id: "p-billing", title: "Billing", status: "active" }] : [] }));
// The chip on each scope row reads the store; it is not under test here.
mock.module("../charter/ProjectLeadChip", () => ({ ProjectLeadChip: () => null, ProjectLeadMark: () => null, HireLeadDialog: () => null }));
mock.module("../../hooks/useProjectLead", () => ({ useProjectLead: () => ({ project: undefined, roles: null, lead: { kind: "none" }, otherWorkspace: false }) }));

const { createRoot } = await import("react-dom/client");
const { TakeoverGate } = await import("./TakeoverEdit");
const { GatedScopeEditor } = await import("./OrgScopePanel");
const { ORG_FIXTURE } = await import("./orgFixture");

const WS = { kind: "team" as const, id: "fixture-team", name: "Acme" };
const moves = (n: number) => [{ sessions: Array.from({ length: n }, (_, i) => `jx7000${i}`), kept_in_front: [], over_cap: 0, phrase: "" }];
let root = createRoot(document.getElementById("root")!);
const mount = async (node: React.ReactNode) => {
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(node as never));
};
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

describe("TakeoverGate", () => {
  it("nothing would move: it confirms itself, once, with no edit, and shows nothing", async () => {
    answer = [null];
    const confirmed: unknown[] = [];
    await mount(<TakeoverGate workspace={WS} ask={{ handle: "growth", add: ["project:p-growth"] }} what="x" confirmLabel="Go" onConfirm={(o) => confirmed.push(o)} onCancel={() => {}} />);
    assert.deepEqual(confirmed, [{ leave_sessions: false }]);
    assert.equal(q("[data-takeover-gate]"), null);
  });

  it("until the server answers, the write waits and the button is off", async () => {
    answer = undefined;
    const confirmed: unknown[] = [];
    await mount(<TakeoverGate workspace={WS} ask={{ handle: "growth", add: ["project:p-growth"] }} what="Growth joins @growth" confirmLabel="Go" onConfirm={(o) => confirmed.push(o)} onCancel={() => {}} />);
    assert.equal(q("[data-takeover-gate]")!.getAttribute("data-takeover-gate"), "counting");
    assert.equal(q<HTMLButtonElement>("[data-takeover-confirm]")!.disabled, true);
    assert.deepEqual(confirmed, []);
  });

  it("sessions would move: the sentence, the one edit, and the person's own press", async () => {
    answer = moves(3);
    const confirmed: unknown[] = [];
    let cancelled = 0;
    await mount(<TakeoverGate workspace={WS} ask={{ handle: "growth", add: ["project:p-growth"] }} what="Growth joins @growth" confirmLabel="Go" onConfirm={(o) => confirmed.push(o)} onCancel={() => cancelled++} />);
    assert.deepEqual(asked.at(-1), { team_id: "fixture-team", items: [{ handle: "growth", add: ["project:p-growth"] }] });
    assert.deepEqual(confirmed, [], "a takeover never confirms itself");
    assert.match(q("[data-takeover-phrase]")!.textContent!, /^3 sessions now report to @growth and leave your needs input\.$/);
    await act(async () => q<HTMLInputElement>("[data-takeover-leave-input]")!.click());
    await act(async () => q<HTMLButtonElement>("[data-takeover-confirm]")!.click());
    await act(async () => q<HTMLButtonElement>("[data-takeover-confirm]")?.click());
    assert.deepEqual(confirmed, [{ leave_sessions: true }], "one write, however many presses");
    await act(async () => q<HTMLButtonElement>("[data-takeover-cancel]")!.click());
    assert.equal(cancelled, 1);
  });
});

describe("GatedScopeEditor", () => {
  const role = { ...ORG_FIXTURE.roles[0], handle: "growth", scope: { project_ids: ["p-growth"], plan_ids: [] }, scope_names: { projects: [{ id: "p-growth", title: "Growth" }], plans: [] } } as any;
  const pick = async (value: string) => act(async () => {
    const select = q<HTMLSelectElement>('select[aria-label="Add to scope"]')!;
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });

  it("a gain that moves sessions shows in the editor at once and is written only after the person confirms", async () => {
    answer = moves(2);
    const writes: unknown[][] = [];
    await mount(<GatedScopeEditor workspace={WS} role={role} canEdit onChange={(...a) => writes.push(a)} />);
    await pick("project:p-billing");
    assert.ok(q('[data-scope-project="p-billing"]'), "the pending project is painted");
    assert.deepEqual(writes, []);
    assert.match(q("[data-takeover-phrase]")!.textContent!, /^2 sessions now report to @growth/);
    await act(async () => q<HTMLButtonElement>("[data-takeover-confirm]")!.click());
    assert.deepEqual(writes, [[{ project_ids: ["p-growth", "p-billing"], plan_ids: [] }, undefined]]);
    assert.equal(q("[data-takeover-gate]"), null);
  });

  it("leave the sessions rides the write; cancel drops the pending gain", async () => {
    answer = moves(2);
    const writes: unknown[][] = [];
    await mount(<GatedScopeEditor workspace={WS} role={role} canEdit onChange={(...a) => writes.push(a)} />);
    await pick("project:p-billing");
    await act(async () => q<HTMLButtonElement>("[data-takeover-cancel]")!.click());
    assert.equal(q('[data-scope-project="p-billing"]'), null);
    assert.deepEqual(writes, []);
    await pick("project:p-billing");
    await act(async () => q<HTMLInputElement>("[data-takeover-leave-input]")!.click());
    await act(async () => q<HTMLButtonElement>("[data-takeover-confirm]")!.click());
    assert.deepEqual(writes, [[{ project_ids: ["p-growth", "p-billing"], plan_ids: [] }, { leave_sessions: true }]]);
  });

  it("a gain that moves nothing, and an edit that only removes, are written without a question", async () => {
    answer = [null];
    const writes: unknown[][] = [];
    await mount(<GatedScopeEditor workspace={WS} role={role} canEdit onChange={(...a) => writes.push(a)} />);
    await pick("project:p-billing");
    assert.deepEqual(writes, [[{ project_ids: ["p-growth", "p-billing"], plan_ids: [] }, undefined]]);
    const before = asked.length;
    await act(async () => q<HTMLButtonElement>('[data-scope-project="p-growth"] button')!.click());
    assert.deepEqual(writes.at(-1), [{ project_ids: [], plan_ids: [] }]);
    assert.equal(asked.length, before, "a removal asks the server nothing");
  });
});
