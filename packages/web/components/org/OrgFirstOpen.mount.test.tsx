// First open (org-staffing.md S14) and the retire confirm (S16), mounted in
// jsdom: the empty canvas while a review runs and after one ended with
// nothing; the one retire confirm asks keep or retire for the head of people
// and nothing for any other seat. The guided walk is the org tour
// (tours/TourLayer.mount.test.tsx).
// Run: bun components/org/OrgFirstOpen.mount.test.tsx
import assert from "node:assert/strict";
import { closeDomWindow } from "../../test-helpers/domGlobals";
async function verifyFirstOpen() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { OrgEmptyCanvas } = await import("./OrgFirstOpen");
  const { RetireRoleConfirm } = await import("./RetireRoleConfirm");
  const { retireToastText } = await import("../../lib/retireRole");
  const root = createRoot(document.getElementById("root")!);
  const render = (el: React.ReactElement) => act(async () => root.render(el));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

  const calls: string[] = [];

  // ── the empty canvas: reviewing, then a review that ended with nothing ──
  await render(React.createElement(OrgEmptyCanvas, { me: null, reviewing: true, onOpenReview: () => calls.push("open-review"), onHireHeadOfPeople: () => calls.push("hire"), onProposeNow: () => calls.push("propose") }));
  assert.ok(q("[data-reviewing]"));
  assert.equal(q('[data-org-guide="start"]'), null);
  await act(async () => qa("[data-reviewing] button")[0].click());
  assert.deepEqual(calls.splice(0), ["open-review"]);
  await render(React.createElement(OrgEmptyCanvas, { me: null, reviewing: false, reviewEnded: true, onOpenReview: () => calls.push("open-review"), onHireHeadOfPeople: () => calls.push("hire"), onProposeNow: () => calls.push("propose") }));
  assert.match(q("[data-review-ended]")!.textContent!, /stopped without making a proposal/);
  assert.equal(qa('[data-org-guide="start"] button').length, 2, "the buttons are back");

  // ── the retire confirm ──
  await render(React.createElement(RetireRoleConfirm, { role: { name: "Head of People", handle: "head-of-people" }, onRetire: (c: unknown) => calls.push(`retire:${c}`), onCancel: () => calls.push("cancel") }));
  assert.equal(q("[data-retire-confirm]")!.getAttribute("data-retire-confirm"), "head");
  assert.deepEqual(qa("[data-unseat-choice]").map((b) => [b.getAttribute("data-unseat-choice"), b.getAttribute("aria-checked")]), [["keep", "true"], ["retire", "false"]]);
  await act(async () => q<HTMLButtonElement>("[data-retire-submit]")!.click());
  assert.deepEqual(calls.splice(0), ["retire:keep"], "keeping the agent is the default");
  await act(async () => q<HTMLButtonElement>('[data-unseat-choice="retire"]')!.click());
  await act(async () => q<HTMLButtonElement>("[data-retire-submit]")!.click());
  assert.deepEqual(calls.splice(0), ["retire:retire"]);
  // Any other seat: no question, no choice sent.
  await render(React.createElement(RetireRoleConfirm, { role: { name: "Growth lead", handle: "growth" }, lead: "Its 3 sessions go back to their owners.", onRetire: (c: unknown) => calls.push(`retire:${c}`), onCancel: () => calls.push("cancel") }));
  assert.equal(q("[data-retire-confirm]")!.getAttribute("data-retire-confirm"), "role");
  assert.equal(qa("[data-unseat-choice]").length, 0);
  assert.match(q("[data-retire-confirm]")!.textContent!, /Its 3 sessions go back to their owners/);
  await act(async () => q<HTMLButtonElement>("[data-retire-submit]")!.click());
  assert.deepEqual(calls.splice(0), ["retire:undefined"]);
  assert.equal(retireToastText("Head of People", "keep"), "Retired Head of People; its agent keeps running as a plain agent");
  assert.equal(retireToastText("Head of People", "retire"), "Retired Head of People; its thread is kept");
  assert.equal(retireToastText("Growth lead", undefined), "Retired Growth lead");

  await act(async () => root.unmount());
  closeDomWindow(dom);
  console.log("first open and retire confirm mount: passed");
}

if (import.meta.main) await verifyFirstOpen();
