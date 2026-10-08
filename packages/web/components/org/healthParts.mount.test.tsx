// The week's parts mounted against the fixture health (cohesive build spec
// D12): a role's two levers as a person uses them on its sheet (the daily
// limit replayed and applied, part of its work moved and asked of the Head
// of People), and the note for a health read that could not happen. None of
// the load model's words reach the page.
import { test, expect, afterAll } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "SVGElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
  const v = (dom.window as any)[key];
  if (v !== undefined) Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

const React = await import("react");
const h = React.createElement;
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { HealthNote, RoleLevers } = await import("./healthParts");
const { ORG_FIXTURE_WITH_HEAD } = await import("./orgFixture");
const { ORG_STAFFING_FIXTURE_HEALTH } = await import("./orgStaffingFixture");
const { findHeadOfPeople } = await import("./staffingModel");
const { flowDays, roleFlows } = await import("./orgFlow");

const now = ORG_STAFFING_FIXTURE_HEALTH.generated_at;
const flows = roleFlows(ORG_FIXTURE_WITH_HEAD, ORG_STAFFING_FIXTURE_HEALTH, now);
const growth = flows.find((f) => f.role.handle === "growth")!;
const head = findHeadOfPeople(ORG_FIXTURE_WITH_HEAD);

const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const setInput = async (el: HTMLInputElement | HTMLSelectElement, value: string) => act(async () => {
  const proto = el instanceof (window as any).HTMLSelectElement ? (window as any).HTMLSelectElement.prototype : (window as any).HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
});

async function mount(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  const render = (n: React.ReactElement) => act(async () => { root.render(n); });
  await render(node);
  return { el, render, unmount: async () => { await act(async () => { root.unmount(); }); el.remove(); } };
}

test("the daily limit: a role that hit it opens there, the week replays under a new limit, and Set applies it", async () => {
  const calls: string[] = [];
  const props = { f: growth, flows, days: flowDays(now), head, onSetLimit: (n: number) => calls.push(`limit:${n}`), onAskHead: (t: string) => calls.push(`ask:${t}`) };
  const m = await mount(h(RoleLevers, props));
  expect(q("[data-what-if]", m.el)!.getAttribute("data-what-if")).toBe("limit");
  expect(q("[data-what-if-says]", m.el)!.textContent).toBe("Now 40 a day. It sat at that limit on 4 of 7 days.");
  await setInput(q<HTMLInputElement>("[data-what-if-limit]", m.el)!, "20");
  expect(q("[data-what-if-says]", m.el)!.textContent).toBe("At 20 a day it would have sat at its limit on 5 of 7 days, holding at least 87 pieces of work.");
  await setInput(q<HTMLInputElement>("[data-what-if-limit]", m.el)!, "60");
  expect(q("[data-what-if-says]", m.el)!.textContent).toMatch(/the 4 days it sat at 40 would have gone further; held work is not counted, so whether they would reach 60 is unknown\./);
  await act(async () => q<HTMLButtonElement>("[data-what-if-apply]", m.el)!.click());
  expect(calls.pop()).toBe("limit:60");
  expect(m.el.textContent).not.toMatch(/\bwakes?\b|\bhands?\b|cap hit|ledger|breach/i);
  // Without the right to edit the role, the projection still reads and says who can change it.
  await m.render(h(RoleLevers, { ...props, onSetLimit: undefined }));
  await setInput(q<HTMLInputElement>("[data-what-if-limit]", m.el)!, "20");
  expect(q("[data-what-if-apply]", m.el)).toBeNull();
  expect(m.el.textContent).toContain("Only an admin or the role's owner can change its limit.");
  await m.unmount();
});

test("moving part of its work: the two weeks replayed side by side, and the ask goes to the Head of People once", async () => {
  const calls: string[] = [];
  const m = await mount(h(RoleLevers, { f: growth, flows, days: flowDays(now), head, onAskHead: (t: string) => calls.push(t) }));
  await act(async () => q<HTMLButtonElement>("[data-what-if-pick='move']", m.el)!.click());
  await setInput(q<HTMLInputElement>("[data-what-if-share]", m.el)!, "0.5");
  expect(q("[data-what-if-says]", m.el)!.textContent).toBe("About 108 pieces of work move over the week. Head of Growth would sit at its limit on 0 days instead of 4; Head of People on 0 instead of 0.");
  await act(async () => q<HTMLButtonElement>("[data-what-if-ask]", m.el)!.click());
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^Propose moving about 50% of Head of Growth/);
  expect(q("[data-what-if-sent]", m.el)).not.toBeNull();
  expect(q<HTMLButtonElement>("[data-what-if-ask]", m.el)!.disabled).toBe(true);
  await m.unmount();
  // With no other role there is nobody to hand work to.
  const alone = await mount(h(RoleLevers, { f: growth, flows: [growth], days: flowDays(now), head }));
  await act(async () => q<HTMLButtonElement>("[data-what-if-pick='move']", alone.el)!.click());
  expect(alone.el.textContent).toContain("There is no other role to hand work to.");
  await alone.unmount();
});

test("a health read that could not happen is said, with Retry; a clean read says nothing", async () => {
  const calls: string[] = [];
  const m = await mount(h(HealthNote, { missing: true, hasHealth: false }));
  expect(m.el.textContent).toMatch(/does not read the company's health yet/);
  await m.render(h(HealthNote, { error: "Too many reads", hasHealth: false, onRetry: () => calls.push("retry") }));
  expect(m.el.textContent).toMatch(/^Health could not be read: Too many reads/);
  await act(async () => q<HTMLButtonElement>("[data-health-error] button", m.el)!.click());
  expect(calls).toEqual(["retry"]);
  await m.render(h(HealthNote, { error: "Too many reads", hasHealth: true }));
  expect(q("[data-health-stale]", m.el)).not.toBeNull();
  await m.render(h(HealthNote, { hasHealth: true }));
  expect(m.el.textContent).toBe("");
  await m.unmount();
});
