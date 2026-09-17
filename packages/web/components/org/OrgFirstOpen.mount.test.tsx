// First open (org-staffing.md S14) and the retire confirm (S16), mounted in
// jsdom: the guide's last step points at a proposal that is already waiting
// and its button opens it; the one retire confirm asks keep or retire for the
// chief of staff and nothing for any other seat.
// Run: bun components/org/OrgFirstOpen.mount.test.tsx
import assert from "node:assert/strict";

async function verifyFirstOpen() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><button data-org-guide='staffing'>Staffing</button><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { OrgGuide, OrgEmptyCanvas, orgGuideSteps } = await import("./OrgFirstOpen");
  const { RetireRoleConfirm, retireToastText } = await import("./RetireRoleConfirm");
  const root = createRoot(document.getElementById("root")!);
  const render = (el: React.ReactElement) => act(async () => root.render(el));
  const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

  // ── the steps ──
  const empty = orgGuideSteps("person:me", false);
  assert.deepEqual(empty.map((s) => s.target), ['.react-flow__node[data-id="person:me"]', '[data-org-guide="hire"]', '[data-org-guide="start"]']);
  assert.equal(empty[2].action, undefined);
  assert.match(empty[2].sentence, /these two buttons start the first one/);
  assert.equal(orgGuideSteps("person:me", true)[2].target, '[data-org-guide="staffing"]');
  // A proposal is already waiting: the story of "start one" would walk past
  // it, so the last step points at it, whether or not roles exist yet.
  for (const hasRoles of [false, true]) {
    const waiting = orgGuideSteps("person:me", hasRoles, { short_id: "op-6", remaining: 129 });
    assert.equal(waiting[2].target, '[data-org-guide="staffing"]');
    assert.match(waiting[2].sentence, /A proposal is already waiting: op-6 .* each of its 129 changes/);
    assert.deepEqual(waiting[2].action, { id: "open_proposal", label: "Open op-6" });
  }
  assert.match(orgGuideSteps(null, false, { short_id: "op-2", remaining: 1 })[2].sentence, /its one change/);
  // One sentence per step.
  for (const s of [...empty, ...orgGuideSteps("p", true, { short_id: "op-6", remaining: 3 })]) assert.equal((s.sentence.match(/\.(\s|$)/g) ?? []).length, 1, s.sentence);

  // ── the guide's last step opens the proposal and closes ──
  const calls: string[] = [];
  const steps = orgGuideSteps("person:me", false, { short_id: "op-6", remaining: 129 });
  await render(React.createElement(OrgGuide, { steps, step: 2, onStep: (i: number) => calls.push(`step:${i}`), onDone: () => calls.push("done"), onAction: (id: string) => calls.push(`action:${id}`) }));
  assert.equal(q("[data-org-guide-open]")!.getAttribute("data-org-guide-open"), "proposals");
  const open = q<HTMLButtonElement>('[data-org-guide-action="open_proposal"]')!;
  assert.equal(open.textContent, "Open op-6");
  await act(async () => open.click());
  assert.deepEqual(calls.splice(0), ["done", "action:open_proposal"]);
  // With nothing waiting the last step's button is Done.
  await render(React.createElement(OrgGuide, { steps: orgGuideSteps("person:me", false), step: 2, onStep: () => {}, onDone: () => calls.push("done") }));
  assert.equal(q("[data-org-guide-action]"), null);
  await act(async () => qa("[data-org-guide-card] button").find((b) => b.textContent === "Done")!.click());
  assert.deepEqual(calls.splice(0), ["done"]);

  // ── the empty canvas: reviewing, then a review that ended with nothing ──
  await render(React.createElement(OrgEmptyCanvas, { me: null, reviewing: true, onOpenReview: () => calls.push("open-review"), onHireChief: () => calls.push("hire"), onProposeNow: () => calls.push("propose") }));
  assert.ok(q("[data-reviewing]"));
  assert.equal(q('[data-org-guide="start"]'), null);
  await act(async () => qa("[data-reviewing] button")[0].click());
  assert.deepEqual(calls.splice(0), ["open-review"]);
  await render(React.createElement(OrgEmptyCanvas, { me: null, reviewing: false, reviewEnded: true, onOpenReview: () => calls.push("open-review"), onHireChief: () => calls.push("hire"), onProposeNow: () => calls.push("propose") }));
  assert.match(q("[data-review-ended]")!.textContent!, /stopped without posting a proposal/);
  assert.equal(qa('[data-org-guide="start"] button').length, 2, "the buttons are back");

  // ── the retire confirm ──
  await render(React.createElement(RetireRoleConfirm, { role: { name: "Chief of Staff", handle: "chief-of-staff" }, onRetire: (c: unknown) => calls.push(`retire:${c}`), onCancel: () => calls.push("cancel") }));
  assert.equal(q("[data-retire-confirm]")!.getAttribute("data-retire-confirm"), "chief");
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
  assert.equal(retireToastText("Chief of Staff", "keep"), "Retired Chief of Staff; its agent keeps running as a plain agent");
  assert.equal(retireToastText("Chief of Staff", "retire"), "Retired Chief of Staff and its standing agent; the thread is kept");
  assert.equal(retireToastText("Growth lead", undefined), "Retired Growth lead");

  await act(async () => root.unmount());
  dom.window.close();
  console.log("first open and retire confirm mount: passed");
}

if (import.meta.main) await verifyFirstOpen();
