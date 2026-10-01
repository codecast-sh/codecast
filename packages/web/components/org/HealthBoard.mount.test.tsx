// Mounts the health page in jsdom against the fixture health and checks it
// as a person uses it: the week in one line, what waits on them (each card
// saying its kind, who asks and the one thing to do), a role opened in the
// drawer with what is stuck and the two what-ifs, the chief's conversation in
// its own column, and the phone's list of role weeks. None of the load
// model's words reach the page.
// Run: bun components/org/HealthBoard.mount.test.tsx
import assert from "node:assert/strict";

import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyHealthBoard() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (dom.window as any).HTMLElement.prototype.scrollIntoView = () => {};
  const { mock } = await import("bun:test");
  const React = await import("react");
  mock.module("../anchor/AnchorConversation", () => ({ AnchorConversation: ({ conversationId }: { conversationId: string }) => React.createElement("div", { "data-thread": conversationId }, "thread") }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { HealthBoard } = await import("./HealthBoard");
  const { ORG_FIXTURE } = await import("./orgFixture");
  const { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } = await import("./orgStaffingFixture");
  const { findChiefOfStaff } = await import("./staffingModel");
  const { roleFlows } = await import("./orgFlow");
  const chiefTree = { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, { ...ORG_FIXTURE.roles[0], _id: "fixture-role-chief", short_id: "or-9", handle: "chief-of-staff", name: "Chief of Staff", standing: { conversation_id: "fixture-chief-conv", short_id: "jx7ch1f" } }] };
  const now = ORG_STAFFING_FIXTURE_HEALTH.generated_at;
  const calls: string[] = [];
  const queue: any[] = [{ key: "decide:1", source: "decide", conversationId: "fixture-growth-conv", question: "Which plan names go on the pricing page?", options: [{ label: "Starter and Pro" }, { label: "Free, Pro, Team" }], blocking: true, createdAt: now - 3_600_000, decisionId: "sd-77" }];
  const base = {
    tree: chiefTree,
    health: ORG_STAFFING_FIXTURE_HEALTH,
    flows: roleFlows(chiefTree, ORG_STAFFING_FIXTURE_HEALTH, now),
    proposals: [ORG_STAFFING_FIXTURE_PROPOSAL],
    queue,
    chief: findChiefOfStaff(chiefTree),
    now,
    map: React.createElement("div", { "data-map": true }),
    focusRoleId: null,
    onFocusRole: (id: string | null) => calls.push(`focus:${id}`),
    onOpenSession: (id: string) => calls.push(`open:${id}`),
    onPickProposal: (id: string) => calls.push(`pick:${id}`),
    onSelectNode: (id: string) => calls.push(`node:${id}`),
    onAnswerDecision: (id: string, i: number) => calls.push(`answer:${id}:${i}`),
    onTrigger: (id: string, verb: string) => calls.push(`trigger:${id}:${verb}`),
    onSetTriggerEvery: (id: string, ms: number) => calls.push(`every:${id}:${ms}`),
    onSendToRole: (conv: string, body: string) => calls.push(`send:${conv}:${body}`),
    onResumeChief: (id: string) => calls.push(`resume:${id}`),
    onSetLimit: (id: string, perDay: number) => calls.push(`limit:${id}:${perDay}`),
    canEditRole: () => true,
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (props: any = {}) => act(async () => root.render(React.createElement(HealthBoard, { ...base, ...props })));
  const text = () => document.body.textContent ?? "";
  const q = <T extends Element = Element>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => Array.from(document.querySelectorAll(sel));
  const setInput = async (el: HTMLInputElement | HTMLSelectElement, value: string, event = "input") => act(async () => {
    const proto = el instanceof (window as any).HTMLSelectElement ? (window as any).HTMLSelectElement.prototype : (window as any).HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new (window as any).Event(event, { bubbles: true }));
  });

  await render();
  assert.ok(q('[data-health-page="desktop"]'));
  assert.ok(q("[data-health-map] [data-map]"), "the page places the chart it was handed");
  assert.doesNotMatch(text(), /\bwakes?\b|\bhands?\b|cap hit|ledger|breach/i);

  // ── the week in one line, then what waits on you ──
  assert.match(q("[data-week-line]")!.textContent!, /^This week245 in→21 closed.*3 stuck1 at their limit$/);
  assert.equal(q("[data-needs-you]")!.getAttribute("data-needs-you"), "2");
  assert.match(text(), /2 waiting on you/);
  const decision = q('[data-needs-you-item="decision"]')!;
  assert.match(decision.textContent!, /Head of Growth· decision1h.*Which plan names go on the pricing page\?/);
  await act(async () => (decision.querySelectorAll("[data-needs-you-options] button")[1] as HTMLButtonElement).click());
  assert.equal(calls.pop(), "answer:sd-77:1");
  await act(async () => (decision.querySelector("[data-needs-you-open]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "open:fixture-growth-conv");
  const proposal = q('[data-needs-you-item="proposal"]')!;
  assert.match(proposal.textContent!, /org change.*Split growth.*\(6 changes to decide\)/);
  await act(async () => (proposal.querySelector("[data-needs-you-open]") as HTMLButtonElement).click());
  assert.equal(calls.pop(), "pick:op-7");

  // ── nothing open until a card is clicked on the chart ──
  assert.equal(q("[data-health-drawer]"), null);
  await render({ focusRoleId: "fixture-role-growth" });
  const drawer = q('[data-health-drawer="growth"]')!;
  assert.match(drawer.textContent!, /Head of Growthstuckits page/);
  assert.match(drawer.textContent!, /217 in · 12 closed · 9 decided for you · limit 40 a day/);
  assert.match(drawer.textContent!, /“Two landing pages shipped this week/);
  await act(async () => q<HTMLButtonElement>("[data-health-drawer-close]")!.click());
  assert.equal(calls.pop(), "focus:null");

  // What is stuck under it, as the area reads it.
  const detail = q('[data-flow-detail="growth"]')!;
  assert.match(detail.querySelector("[data-area-status-line]")!.textContent!, /^Stuck: 1 session under it waiting unanswered, 1 task stuck in review\.$/);
  assert.equal(qa("[data-area-waiting-session]").length, 2);
  await act(async () => (qa("[data-area-waiting-session]")[0] as HTMLButtonElement).click());
  assert.equal(calls.pop(), "open:fixture-growth-2");
  await act(async () => (detail.querySelector('[data-area-check] [aria-label="Check now"]') as HTMLButtonElement).click());
  assert.equal(calls.pop(), "trigger:fixture-trigger-growth-check:runNow");
  await setInput(detail.querySelector<HTMLInputElement>('[data-ask-role="growth"] input')!, "Why is the pricing page waiting?");
  await act(async () => { detail.querySelector("[data-ask-role]")!.dispatchEvent(new (window as any).Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(calls.pop(), "send:fixture-growth-conv:Why is the pricing page waiting?");

  // ── what if: the limit, replayed and applied ──
  assert.equal(q("[data-what-if]")!.getAttribute("data-what-if"), "limit", "a role that hit its limit opens on the limit");
  assert.match(q("[data-what-if-says]")!.textContent!, /^Now 40 a day\. It sat at that limit on 4 of 7 days\.$/);
  await setInput(q<HTMLInputElement>("[data-what-if-limit]")!, "20");
  assert.match(q("[data-what-if-says]")!.textContent!, /^At 20 a day it would have sat at its limit on 5 of 7 days, holding at least 87 pieces of work\.$/);
  await setInput(q<HTMLInputElement>("[data-what-if-limit]")!, "60");
  assert.match(q("[data-what-if-says]")!.textContent!, /the 4 days it sat at 40 would have gone further; held work is not counted, so whether they would reach 60 is unknown\./);
  await act(async () => q<HTMLButtonElement>("[data-what-if-apply]")!.click());
  assert.equal(calls.pop(), "limit:fixture-role-growth:60");

  // ── what if: half of it moved, asked of the chief ──
  await act(async () => (Array.from(q("[data-what-if]")!.querySelectorAll("button")).find((b) => /moved/.test(b.textContent!)) as HTMLButtonElement).click());
  await setInput(q<HTMLInputElement>("[data-what-if-share]")!, "0.5");
  assert.match(q("[data-what-if-says]")!.textContent!, /About 108 pieces of work move over the week\. Head of Growth would sit at its limit on 0 days instead of 4; Chief of Staff on 0 instead of 0\./);
  await act(async () => q<HTMLButtonElement>("[data-what-if-ask]")!.click());
  assert.match(calls.pop()!, /^send:fixture-chief-conv:Propose moving about 50% of Head of Growth/);
  assert.ok(q("[data-what-if-sent]"));
  await render({ focusRoleId: null });

  // ── the chief's conversation: its own column, full height, hideable ──
  assert.equal(q("[data-chief-column]")!.getAttribute("data-chief-column"), "open");
  assert.ok(q('[data-chief-column] [data-thread="fixture-chief-conv"]'));
  await act(async () => q<HTMLButtonElement>("[data-chief-column-close]")!.click());
  assert.equal(q("[data-chief-column]")!.getAttribute("data-chief-column"), "closed");
  await act(async () => q<HTMLButtonElement>('[data-chief-column="closed"]')!.click());
  const pausedTree = { ...chiefTree, roles: chiefTree.roles.map((r) => r.handle === "chief-of-staff" ? { ...r, status: "paused" as const } : r) };
  await render({ tree: pausedTree, chief: findChiefOfStaff(pausedTree) });
  assert.match(q("[data-chief-paused]")!.textContent!, /is paused: its triggers hold until you resume it\. Messages still reach it\./);
  await act(async () => (Array.from(document.querySelectorAll("[data-chief-paused] button")).find((b) => /Resume/.test(b.textContent!)) as HTMLButtonElement).click());
  assert.equal(calls.pop(), "resume:fixture-role-chief");

  // ── nothing waiting, and reads that failed ──
  await render({ queue: [], proposals: [] });
  assert.equal(q("[data-needs-you]")!.getAttribute("data-needs-you"), "empty");
  assert.match(text(), /Nothing is waiting on you/);
  await render({ health: null, healthMissing: true, flows: roleFlows(chiefTree, null, now) });
  assert.match(text(), /does not read the company's health yet/);
  assert.equal(q("[data-week-line]")!.textContent!.includes("This week0 in→0 closed"), true, "the week still reads, at zero");
  await render({ health: null, healthError: "Too many reads in a single function execution", onRetryHealth: () => calls.push("retryHealth"), flows: roleFlows(chiefTree, null, now) });
  assert.match(text(), /Health could not be read: Too many reads/);
  await act(async () => q<HTMLButtonElement>("[data-health-error] button")!.click());
  assert.equal(calls.pop(), "retryHealth");

  // ── the phone: one column, the conversation one tap away ──
  await render({ phone: true });
  assert.ok(q('[data-health-page="phone"]'));
  assert.equal(q("[data-health-map]"), null);
  assert.deepEqual(qa("[data-role-week]").map((e) => e.getAttribute("data-role-week")), ["growth", "chief-of-staff"]);
  assert.match(q('[data-role-week="growth"]')!.textContent!, /217in→12closed.*at its limit 4 of 7 days.*3 stuck/);
  await act(async () => q<HTMLButtonElement>('[data-flow-row="fixture-role-growth"]')!.click());
  assert.equal(calls.pop(), "focus:fixture-role-growth");
  await act(async () => (Array.from(document.querySelectorAll("button")).find((b) => /Talk to Chief of Staff/.test(b.textContent!)) as HTMLButtonElement).click());
  assert.equal(calls.pop(), "open:fixture-chief-conv");

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("health board mount: passed");
}

if (import.meta.main) await verifyHealthBoard();
