import assert from "node:assert/strict";
import { test } from "bun:test";
import { replaceGlobals } from "../../../test-helpers/globals";
import type { SwitchLedger } from "../ConsequentialSwitch";

const LEDGER: SwitchLedger = {
  name: "Auto-start",
  subject: "Agent Quality",
  figures: [{ value: "5", label: "start within 2 min", tone: "warn" }, { value: "77", label: "waiting" }],
  rows: [{ k: "Per session", v: "~$3 · 12 runs" }, { k: "Merges", v: "Never without you", tone: "ok" }],
  stop: "Switch off",
  confirm: "Start 5",
};

async function mount() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  const w = dom.window as any;
  const restore = replaceGlobals({
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const mod = await import("../ConsequentialSwitch");
  const root = createRoot(w.document.getElementById("root"));
  const calls: string[] = [];
  const render = (on: boolean, ledger = LEDGER) => React.act(async () => root.render(
    <mod.ConsequentialSwitch on={on} ledger={ledger} onTurnOn={() => calls.push("on")} onTurnOff={() => calls.push("off")} />,
  ));
  const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  // Radix's focus scope sends its unmount event a tick after the dialog leaves: wait it out before the globals go back.
  const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const done = async () => { await React.act(async () => root.unmount()); await tick(); restore(); };
  return { React, w, render, q, calls, done };
}

test("off: the control opens the review and turns nothing on; only the review's own button does", async () => {
  const { React, w, render, q, calls, done } = await mount();
  try {
    await render(false);
    const trigger = q('[data-consequential="off"]')!;
    assert.equal(trigger.textContent, "Review", "the control is not a Turn on button");
    assert.equal(q("[data-switch-review]"), null);

    await React.act(async () => trigger.click());
    assert.deepEqual(calls, [], "opening the review writes nothing");
    if (!q("[data-switch-review]")) console.log("BODY", w.document.body.innerHTML.slice(0, 3000));
    const review = q("[data-switch-review]")!;
    assert.match(review.textContent!, /Auto-start/);
    assert.match(review.textContent!, /Agent Quality/);
    assert.equal(q('[data-switch-figure="start within 2 min"]')!.textContent, "5");
    assert.equal(q('[data-switch-figure="waiting"]')!.textContent, "77");
    assert.match(q('[data-switch-row="Per session"]')!.textContent!, /~\$3 · 12 runs/);
    assert.match(q('[data-switch-row="To stop"]')!.textContent!, /Switch off/);
    assert.equal(w.document.activeElement, q("[data-switch-cancel]"), "focus rests on Keep off, so Enter backs out");
    assert.match(q("[data-switch-confirm]")!.textContent!, /Start 5/, "the confirm names what it starts");
    assert.ok(q("[data-switch-confirm] kbd"), "the confirm chord is drawn as key caps");

    // A bare Enter is not the chord.
    await React.act(async () => { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(calls, []);

    await React.act(async () => q("[data-switch-cancel]")!.click());
    assert.equal(q("[data-switch-review]"), null);
    assert.deepEqual(calls, [], "Keep off writes nothing");

    await React.act(async () => q('[data-consequential="off"]')!.click());
    await React.act(async () => q("[data-switch-confirm]")!.click());
    assert.deepEqual(calls, ["on"]);
    assert.equal(q("[data-switch-review]"), null, "confirming closes the review");

    await React.act(async () => q('[data-consequential="off"]')!.click());
    await React.act(async () => { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    assert.deepEqual(calls, ["on", "on"], "the chord confirms");
  } finally { await done(); }
}, 120_000);

test("on: the state shows with its off control, and turning off is one press with no review", async () => {
  const { React, render, q, calls, done } = await mount();
  try {
    await render(true);
    assert.match(q('[data-consequential="on"]')!.textContent!, /On/);
    await React.act(async () => q("[data-consequential-off]")!.click());
    assert.deepEqual(calls, ["off"]);
    assert.equal(q("[data-switch-review]"), null);
  } finally { await done(); }
}, 120_000);

test("a handover draws as two columns, and a row can name the things it covers", async () => {
  const { React, render, q, done } = await mount();
  try {
    await render(false, { ...LEDGER, hands: { its: ["Which approach a session takes"], yours: ["Approving a fix"] }, rows: [{ k: "Starting", v: "2 problems", list: ["ct-1 Cold sends", "+1 more"] }] });
    await React.act(async () => q('[data-consequential="off"]')!.click());
    const hands = q("[data-switch-hands]")!;
    assert.match(hands.textContent!, /It decides.*Which approach a session takes.*You decide.*Approving a fix/);
    assert.match(q('[data-switch-row="Starting"]')!.textContent!, /ct-1 Cold sends.*\+1 more/);
  } finally { await done(); }
}, 120_000);

test("a blocked ledger cannot be confirmed, by button or by chord", async () => {
  const { React, w, render, q, calls, done } = await mount();
  try {
    await render(false, { ...LEDGER, blocked: "No lead on this project" });
    await React.act(async () => q('[data-consequential="off"]')!.click());
    const confirm = q("[data-switch-confirm]") as HTMLButtonElement;
    assert.ok(confirm.disabled);
    assert.match(confirm.textContent!, /No lead on this project/);
    await React.act(async () => { w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    assert.deepEqual(calls, []);
  } finally { await done(); }
}, 120_000);
