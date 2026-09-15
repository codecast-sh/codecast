// Mounts the staffing pane in jsdom against the fixture proposal and health
// (org-staffing.md S5) and checks the three states: a proposal (header counts,
// flags, grouped change list, accept, skip and edit, rationale, accept all), the
// health summary with no proposal, and the two buttons with no chief of staff.
// Run: bun components/org/StaffingPane.mount.test.tsx
import assert from "node:assert/strict";

async function verifyStaffingPane() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  // The thread embed and the markdown renderer pull the whole store and the
  // message pipeline; the pane only places them.
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("../tools/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => React.createElement("div", { "data-md": true }, content) }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { StaffingPane } = await import("./StaffingPane");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } = await import("./orgStaffingFixture");
  const { findChiefOfStaff } = await import("./staffingModel");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const calls: string[] = [];
  const base = {
    tree: chiefTree,
    health: ORG_STAFFING_FIXTURE_HEALTH,
    proposals: [ORG_STAFFING_FIXTURE_PROPOSAL],
    chief: findChiefOfStaff(chiefTree),
    reviewing: false,
    now: Date.now(),
    onSelectChange: (id: string | null) => calls.push(`select:${id}`),
    onDecide: (id: string, verdict: string, edits?: Record<string, unknown>) => calls.push(`decide:${id}:${verdict}${edits ? ":" + JSON.stringify(edits) : ""}`),
    onAcceptAll: (id: string) => calls.push(`acceptAll:${id}`),
    onEditRole: (c: any) => calls.push(`editRole:${c._id}`),
    onSelectNode: (id: string) => calls.push(`node:${id}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    onPickProposal: (id: string) => calls.push(`pick:${id}`),
    onHireChief: () => calls.push("hire"),
    onProposeNow: () => calls.push("propose"),
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (props: any) => act(async () => root.render(React.createElement(StaffingPane, { ...base, ...props })));
  const text = () => document.body.textContent ?? "";
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const button = (label: string) => {
    const el = qa("button").find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
    assert.ok(el, `Missing button "${label}"`);
    return el!;
  };

  // ── a proposal: header, flags, grouped list, rationale ──
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "proposal");
  assert.match(text(), /Split growth, own the platform work, budget the reviews/);
  assert.equal(q("[data-progress]")!.textContent, "2 of 6 decided");
  assert.match(text(), /Chief of Staff/);
  assert.equal(q<HTMLAnchorElement>('a[href="/org/or-9"]')?.textContent, "Chief of Staff");
  assert.deepEqual(qa("[data-change-group]").map((g) => g.getAttribute("data-change-group")), ["projects", "role", "project_meta", "budget", "routine"]);
  assert.equal(qa("[data-change-row]").length, 6);
  assert.deepEqual(qa("[data-flag]").map((f) => f.getAttribute("data-flag")), ["unowned", "overloaded", "cap_hit", "no_charter", "review_stall"]);
  assert.equal(q("[data-rationale]"), null);
  assert.match(text(), /Accept all remaining \(4\)/);
  // Only proposed rows carry the action trio.
  assert.equal(qa('[data-change-status="proposed"] button[aria-label="Accept"]').length, 4);
  assert.equal(qa('[data-change-status="accepted"] button[aria-label="Accept"]').length, 0);
  assert.equal(q("[data-thread]")!.getAttribute("data-thread"), "fixture-chief-conv");

  // A flag on a role focuses its node; a company flag is not a button.
  await act(async () => (qa('[data-flag="overloaded"]')[0] as HTMLButtonElement).click());
  assert.equal(calls.pop(), "node:role:fixture-role-growth");
  assert.equal(qa('[data-flag="unowned"]')[0].tagName, "DIV");

  // Accept, skip, edit, click to focus.
  await act(async () => qa('[data-change-row="fixture-change-1"] button[aria-label="Accept"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-1:accept");
  await act(async () => qa('[data-change-row="fixture-change-2"] button[aria-label="Skip"]')[0].click());
  assert.equal(calls.pop(), "decide:fixture-change-2:skip");
  await act(async () => qa('[data-change-row="fixture-change-1"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "editRole:fixture-change-1");
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-pressed]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-4");

  // The selected change shows its rationale, evidence and risk.
  await render({ proposal: ORG_STAFFING_FIXTURE_PROPOSAL, selectedChangeId: "fixture-change-4" });
  assert.ok(q("[data-rationale]"));
  assert.match(q("[data-rationale]")!.textContent!, /hit its token cap on four of the last seven days/);
  assert.match(q("[data-rationale]")!.textContent!, /Doubles the role's daily spend ceiling/);
  assert.equal(q<HTMLAnchorElement>('[data-rationale] a[href="/org/or-1?tab=settings"]')?.textContent?.trim(), "4 cap hits in 7 days");

  // Edit on a budget change is the inline form; accept with edits carries them.
  await act(async () => qa('[data-change-row="fixture-change-4"] button[aria-label="Edit"]')[0].click());
  assert.equal(calls.pop(), "select:fixture-change-4");
  const input = q<HTMLInputElement>('[data-edit-form] input[type="number"]');
  assert.ok(input, "budget edit form");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "600000");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => q("[data-edit-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(calls.pop(), 'decide:fixture-change-4:accept:{"caps":{"tokens_per_day":600000}}');

  // Accept all is a two step: confirm then the action.
  await act(async () => button("Accept all remaining (4)").click());
  await act(async () => button("Accept 4").click());
  assert.equal(calls.pop(), "acceptAll:fixture-proposal-7");

  // ── no proposal, a chief: the health summary ──
  await render({ proposal: null, selectedChangeId: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "health");
  assert.match(text(), /Company health/);
  assert.equal(qa("[data-span] button").length, 2);
  assert.match(qa("[data-span] button")[0].textContent!, /Ashot Petrosian1 \/ 7/);
  assert.equal(qa("[data-bottlenecks] button").length, 1);
  assert.match(qa("[data-bottlenecks] button")[0].textContent!, /@growth/);
  assert.ok(q("[data-thread]"));
  await act(async () => qa("[data-bottlenecks] button")[0].click());
  assert.equal(calls.pop(), "node:role:fixture-role-growth");

  // Health missing on this backend says so instead of "no flags".
  await render({ proposal: null, selectedChangeId: null, health: null, healthMissing: true });
  assert.match(text(), /Health is not deployed on this backend yet/);

  // ── no chief of staff: the two buttons, then reviewing ──
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null });
  assert.equal(q("[data-staffing-mode]")!.getAttribute("data-staffing-mode"), "no_chief");
  await act(async () => button("Hire a Chief of Staff").click());
  assert.equal(calls.pop(), "hire");
  await act(async () => button("Propose an org now").click());
  assert.equal(calls.pop(), "propose");
  assert.equal(q("[data-composer]"), null);
  await render({ proposal: null, selectedChangeId: null, tree: ORG_FIXTURE, chief: null, reviewing: true });
  assert.ok(q("[data-reviewing]"));
  assert.equal(qa("button").find((b) => b.textContent?.trim() === "Hire a Chief of Staff"), undefined);

  await act(async () => root.unmount());
  dom.window.close();
  console.log("staffing pane mount: passed");
}

if (import.meta.main) await verifyStaffingPane();
