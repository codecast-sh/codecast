// Mounts the charter block (org-staffing.md S7) in jsdom: every field renders
// from the charter it is given, each inline edit reaches onChange as a patch,
// and the empty state points at the chief of staff when one exists and opens
// the fields when none does.
import assert from "node:assert/strict";
import { beforeAll, describe, it } from "bun:test";
import { ORG_FIXTURE } from "../org/orgFixture";
import { CHIEF_OF_STAFF_HANDLE } from "../org/orgStaffingTypes";
import type { CharterPatch } from "./charterMeta";

// One DOM and one React for the file (the imports take seconds); each case
// mounts into its own fresh container so roots never overlap.
let dom: any;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let CharterBlock: typeof import("./CharterBlock").CharterBlock;
beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ CharterBlock } = await import("./CharterBlock"));
});
const SLOW = 30_000;

async function setup() {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const patches: CharterPatch[] = [];
  const render = async (props: Partial<React.ComponentProps<typeof CharterBlock>>) => {
    await React.act(async () => root.render(
      <CharterBlock kind="project" title="Codecast: Product" charter={{}} canEdit onChange={(p) => patches.push(p)} tree={ORG_FIXTURE} {...props} />,
    ));
  };
  const text = () => document.body.textContent ?? "";
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
  const button = (t: string | RegExp) => {
    const el = buttons().find((b) => (typeof t === "string" ? b.textContent === t : t.test(b.textContent ?? "")));
    assert.ok(el, `Missing button ${t}. Body: ${text()}`);
    return el;
  };
  const click = async (el: Element) => act(async () => (el as HTMLElement).click());
  const act = React.act;
  const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => el.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  };
  return { render, patches, text, button, buttons, click, typeInto, act, unmount: async () => { await act(async () => root.unmount()); } };
}

const role = ORG_FIXTURE.roles[0];
const full = {
  goal: "Make the inbox the place every agent is steered from.",
  success_metrics: ["Median time to first reply under 5 minutes", "Weekly active teams up 20%"],
  priority: "p1" as const,
  owner_role_id: role._id,
  non_goals: ["A general purpose chat client"],
  risks: ["Convex saturation on the message tail"],
  budget: { tokens_per_day: 400_000, hands_per_day: 2 },
};

describe("CharterBlock", () => {
  it("renders every field of a full project charter", async () => {
    const t = await setup();
    await t.render({ charter: full });
    const body = t.text();
    assert.match(body, /Charter/);
    assert.match(body, /Make the inbox the place/);
    for (const m of full.success_metrics) assert.ok(body.includes(m), m);
    for (const g of full.non_goals) assert.ok(body.includes(g), g);
    for (const r of full.risks) assert.ok(body.includes(r), r);
    assert.match(body, /Success metrics2/);
    assert.match(body, /Non goals1/);
    assert.match(body, /Risks1/);
    // The priority pill carries the level and its palette colour.
    const pill = document.querySelector<HTMLElement>('[data-priority="p1"]');
    assert.ok(pill, "priority pill");
    assert.match(pill.textContent!, /P1/);
    assert.match(pill.getAttribute("style") ?? "", /--sol-orange/);
    // The owner chip names the role; the menu carries the link to /org/or-N.
    const owner = document.querySelector<HTMLElement>(`[data-owner="${role.short_id}"]`);
    assert.ok(owner, "owner chip");
    assert.match(owner.textContent!, new RegExp(`@${role.handle}`));
    await t.click(owner);
    const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.getAttribute("href") === `/org/${role.short_id}`);
    assert.ok(link, "owner link to /org/or-N");
    // The advisory budget line.
    assert.match(body, /Budget400ktokens\/day ·2hands\/dayadvisory/);
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "project");
    t.unmount();
  }, SLOW);

  it("a plan charter has no risks and no budget", async () => {
    const t = await setup();
    await t.render({ kind: "plan", charter: { ...full, risks: undefined, budget: undefined } });
    const body = t.text();
    assert.doesNotMatch(body, /Risks/);
    assert.doesNotMatch(body, /Budget/);
    assert.match(body, /Success metrics/);
    assert.match(body, /Non goals/);
    t.unmount();
  }, SLOW);

  it("each inline edit reaches onChange as one patch", async () => {
    const t = await setup();
    await t.render({ charter: full });
    // Priority: open the pill's menu, pick P0.
    await t.click(document.querySelector('[data-priority="p1"]')!);
    await t.click(t.button(/^P0/));
    assert.deepEqual(t.patches.at(-1), { priority: "p0" });
    // Owner: pick "No owner" from the chip's menu.
    await t.click(document.querySelector(`[data-owner="${role.short_id}"]`)!);
    await t.click(t.button("No owner"));
    assert.deepEqual(t.patches.at(-1), { owner_role_id: null });
    // Goal: click, type, Enter with meta commits a multiline edit.
    await t.click(t.button(/Make the inbox/));
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await t.act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "A sharper goal");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await t.act(async () => ta.dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    assert.deepEqual(t.patches.at(-1), { goal: "A sharper goal" });
    // Metrics: the add row appends; the remove button drops.
    await t.click(t.button("Add a metric"));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "NPS above 50");
    assert.deepEqual(t.patches.at(-1), { success_metrics: [...full.success_metrics, "NPS above 50"] });
    await t.click(document.querySelector('[aria-label="Remove from Risks"]')!);
    assert.deepEqual(t.patches.at(-1), { risks: [] });
    // Non goals: editing a row to empty removes it.
    await t.click(t.button(full.non_goals[0]));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "");
    assert.deepEqual(t.patches.at(-1), { non_goals: [] });
    // Budget: tokens parse from "800k".
    await t.click(t.button("400k"));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "800k");
    assert.deepEqual(t.patches.at(-1), { budget: { tokens_per_day: 800_000, hands_per_day: 2 } });
    t.unmount();
  }, SLOW);

  it("empty with no chief of staff: one line, and the ask opens the fields", async () => {
    const t = await setup();
    await t.render({ charter: {} });
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "empty");
    assert.match(t.text(), /No charter yet\./);
    assert.equal(document.querySelector("a"), null, "no link without a chief of staff");
    await t.click(t.button(/Ask the Chief of Staff to draft one/));
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "project");
    assert.ok(t.button("Add a metric"));
    assert.ok(document.querySelector('[data-priority]'), "the empty pill is editable");
    assert.ok(document.querySelector('[data-owner="none"]'), "the no owner chip");
    t.unmount();
  }, SLOW);

  it("empty with a chief of staff: the ask links to /org with the composer prefilled", async () => {
    const t = await setup();
    const chief = { ...role, _id: "role-chief", short_id: "or-99", handle: CHIEF_OF_STAFF_HANDLE, name: "Chief of Staff", status: "active" as const };
    await t.render({ charter: {}, tree: { ...ORG_FIXTURE, roles: [...ORG_FIXTURE.roles, chief] } });
    const link = document.querySelector<HTMLAnchorElement>("a");
    assert.ok(link);
    assert.match(link.textContent!, /Ask the Chief of Staff to draft one/);
    assert.equal(link.getAttribute("href"), `/org?compose=${encodeURIComponent("draft a charter for Codecast: Product")}`);
    await t.click(t.button("or write it"));
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "project");
    t.unmount();
  }, SLOW);

  it("the no owner chip on a project opens the hire form when there is no role to pick", async () => {
    const t = await setup();
    let hired = 0;
    await t.render({ charter: { goal: "x" }, tree: { ...ORG_FIXTURE, roles: [] }, onHire: () => { hired += 1; } });
    await t.click(document.querySelector('[data-owner="none"]')!);
    assert.equal(hired, 1);
    t.unmount();
  }, SLOW);

  it("read only: no pencils, no add rows, the owner chip is the link", async () => {
    const t = await setup();
    await t.render({ charter: full, canEdit: false });
    assert.equal(t.buttons().filter((b) => /Add a/.test(b.textContent ?? "")).length, 0);
    const owner = document.querySelector<HTMLAnchorElement>(`a[data-owner="${role.short_id}"]`);
    assert.ok(owner);
    assert.equal(owner.getAttribute("href"), `/org/${role.short_id}`);
    t.unmount();
  }, SLOW);
});
