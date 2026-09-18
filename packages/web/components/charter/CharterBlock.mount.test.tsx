// Mounts the charter block (org-staffing.md S7) in jsdom: every field renders
// from the charter it is given, each inline edit reaches onChange as a patch,
// and the empty state points at the chief of staff when one exists and opens
// the fields when none does.
import assert from "node:assert/strict";
import { afterAll, describe, it } from "bun:test";
import { ORG_FIXTURE } from "../org/orgFixture";
import { CHIEF_OF_STAFF_HANDLE } from "../org/orgStaffingTypes";
import type { CharterPatch } from "./charterMeta";

// One DOM and one React for the file, set up at module level so the import
// cost (seconds) sits outside every hook and case timeout; each case mounts
// into its own fresh container so roots never overlap.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
const DOM_GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "getComputedStyle"];
const priorGlobals = new Map(DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of DOM_GLOBALS) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// Bun runs the suite's files in one process: put the globals back so a later
// file that expects no window (the React Native cases) is not fooled.
afterAll(() => {
  for (const [key, desc] of priorGlobals) {
    if (desc) Object.defineProperty(globalThis, key, desc); else delete (globalThis as any)[key];
  }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { CharterBlock } = await import("./CharterBlock");
const SLOW = 30_000;

async function setup() {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const patches: CharterPatch[] = [];
  const render = async (props: Partial<React.ComponentProps<typeof CharterBlock>>) => {
    await React.act(async () => root.render(
      <MemoryRouter>
        <CharterBlock kind="project" title="Codecast: Product" charter={{}} canEdit onChange={(p) => patches.push(p)} roles={ORG_FIXTURE.roles} {...props} />
      </MemoryRouter>,
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
    // The chip reads the role's NAME; the handle rides its accessible label.
    assert.match(owner.textContent!, new RegExp(role.name));
    assert.match(owner.getAttribute("aria-label") ?? owner.getAttribute("title") ?? "", new RegExp(`@?${role.handle}|${role.name}`));
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
    await t.click(document.querySelector('[aria-label="Remove Risk 1"]')!);
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

  it("empty with no chief of staff: the link says it hires one (that is what /org will do) and carries no parenthetical", async () => {
    const t = await setup();
    await t.render({ charter: {} });
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "empty");
    assert.match(t.text(), /No charter yet\./);
    const link = document.querySelector<HTMLAnchorElement>("a");
    assert.ok(link, "the ask is a link even with no chief of staff");
    assert.equal(link.textContent!.trim(), "Hire a Chief of Staff to draft one");
    assert.equal(link.getAttribute("data-charter-ask"), "hire");
    assert.equal(link.getAttribute("href"), `/org?compose=${encodeURIComponent("draft a charter for Codecast: Product")}`);
    assert.doesNotMatch(t.text(), /none hired yet|\(/, "no parenthetical patching the label");
    assert.equal(t.buttons().filter((b) => /Chief of Staff/.test(b.textContent ?? "")).length, 0, "the ask is never a button that opens blank fields");
    await t.click(t.button("or write it"));
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "project");
    assert.ok(t.button("Add a metric"));
    assert.ok(document.querySelector('[data-priority]'), "the empty pill is editable");
    assert.ok(document.querySelector('[data-owner="none"]'), "the no owner chip");
    t.unmount();
  }, SLOW);

  it("empty with a chief of staff: the link asks the seat by handle and lands on /org with the composer prefilled", async () => {
    const t = await setup();
    const chief = { ...role, _id: "role-chief", short_id: "or-99", handle: CHIEF_OF_STAFF_HANDLE, name: "Chief of Staff", status: "active" as const };
    await t.render({ charter: {}, roles: [...ORG_FIXTURE.roles, chief] });
    const link = document.querySelector<HTMLAnchorElement>("a");
    assert.ok(link);
    assert.equal(link.textContent!.trim(), `Ask @${CHIEF_OF_STAFF_HANDLE} to draft one`);
    assert.equal(link.getAttribute("data-charter-ask"), "ask");
    assert.equal(link.getAttribute("href"), `/org?compose=${encodeURIComponent("draft a charter for Codecast: Product")}`);
    assert.doesNotMatch(t.text(), /none hired yet|Hire a/);
    await t.click(t.button("or write it"));
    assert.equal(document.querySelector("[data-charter]")?.getAttribute("data-charter"), "project");
    t.unmount();
  }, SLOW);

  it("empty with no roles to read (loading, or another workspace's tree): the seat is unknown, not absent, so the link stays the plain ask", async () => {
    const t = await setup();
    await t.render({ charter: {}, roles: null });
    const link = document.querySelector<HTMLAnchorElement>("a")!;
    assert.equal(link.textContent!.trim(), "Ask the Chief of Staff to draft one");
    assert.equal(link.getAttribute("data-charter-ask"), "unknown");
    assert.doesNotMatch(t.text(), /Hire a|none hired/);
    t.unmount();
  }, SLOW);

  it("the no owner chip on a project opens the hire form when there is no role to pick", async () => {
    const t = await setup();
    let hired = 0;
    await t.render({ charter: { goal: "x" }, roles: [], onHire: () => { hired += 1; } });
    await t.click(document.querySelector('[data-owner="none"]')!);
    assert.equal(hired, 1);
    t.unmount();
  }, SLOW);

  it("the no owner chip with no role to pick and no hire path is disabled and says why, never a dead button", async () => {
    const t = await setup();
    // No roles, no hire path (a plan, or a project whose hire button is hidden).
    await t.render({ charter: { goal: "x" }, roles: [] });
    let chip = document.querySelector<HTMLButtonElement>('[data-owner="none"]')!;
    assert.ok(chip.disabled, "disabled");
    assert.ok(chip.hasAttribute("data-owner-blocked"));
    assert.match(chip.title, /No roles in this workspace yet/);
    // The tree is still loading.
    await t.render({ charter: { goal: "x" }, roles: null });
    chip = document.querySelector<HTMLButtonElement>('[data-owner="none"]')!;
    assert.ok(chip.disabled);
    assert.match(chip.title, /still loading/);
    // The page knows better why (the tree on screen is another workspace's).
    await t.render({ charter: { goal: "x" }, roles: null, ownerBlockedReason: "Switch to the project's workspace to assign an owner" });
    chip = document.querySelector<HTMLButtonElement>('[data-owner="none"]')!;
    assert.match(chip.title, /Switch to the project's workspace/);
    assert.match(chip.getAttribute("aria-label") ?? "", /Switch to the project's workspace/);
    t.unmount();
  }, SLOW);

  it("a retired owner renders as 'No owner' so the person reassigns, not as a link to a gone seat", async () => {
    const t = await setup();
    const roles = ORG_FIXTURE.roles.map((r) => (r._id === role._id ? { ...r, status: "retired" as const } : r));
    await t.render({ charter: full, roles });
    assert.equal(document.querySelector(`[data-owner="${role.short_id}"]`), null, "no chip for the retired seat");
    assert.ok(document.querySelector('[data-owner="none"]'), "the chip reads No owner");
    assert.equal([...document.querySelectorAll("a")].filter((a) => a.getAttribute("href") === `/org/${role.short_id}`).length, 0);
    t.unmount();
  }, SLOW);

  it("a budget written tokens first has the echo's key order (sorted, as Convex returns it), so the field lock retires", async () => {
    const t = await setup();
    await t.render({ charter: { goal: "x" } });
    await t.click(t.button("tokens"));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "400k");
    assert.deepEqual(t.patches.at(-1), { budget: { tokens_per_day: 400_000 } });
    // The row now carries the tokens only budget; hands land second and
    // would otherwise be appended after tokens.
    await t.render({ charter: { goal: "x", budget: { tokens_per_day: 400_000 } } });
    await t.click(t.button("hands"));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "2");
    const budget = (t.patches.at(-1) as any).budget;
    assert.deepEqual(Object.keys(budget), ["hands_per_day", "tokens_per_day"], "sorted keys, the echo's order");
    assert.equal(JSON.stringify(budget), JSON.stringify({ hands_per_day: 2, tokens_per_day: 400_000 }));
    // Clearing both leaves null (the wire's clear), not an empty object.
    await t.render({ charter: { goal: "x", budget: { hands_per_day: 2 } } });
    await t.click(t.button("2"));
    await t.typeInto(document.querySelector<HTMLInputElement>("input")!, "");
    assert.deepEqual(t.patches.at(-1), { budget: null });
    t.unmount();
  }, SLOW);

  it("chip menus are keyboard complete: focus lands on the first item, arrows walk, Escape closes and returns focus to the chip", async () => {
    const t = await setup();
    await t.render({ charter: full });
    const pill = document.querySelector<HTMLButtonElement>('[data-priority="p1"]')!;
    await t.click(pill);
    const items = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
    assert.ok(items.length >= 4, "the levels are menu items");
    assert.equal(document.activeElement, items[0], "first item focused on open");
    const key = async (k: string) => t.act(async () => document.activeElement!.dispatchEvent(new (dom.window as any).KeyboardEvent("keydown", { key: k, bubbles: true })));
    await key("ArrowDown");
    assert.equal(document.activeElement, items[1]);
    await key("ArrowUp");
    assert.equal(document.activeElement, items[0]);
    await key("ArrowUp");
    assert.equal(document.activeElement, items[items.length - 1], "wraps");
    await key("End");
    assert.equal(document.activeElement, items[items.length - 1]);
    await key("Home");
    assert.equal(document.activeElement, items[0]);
    await key("Escape");
    assert.equal(document.querySelector("[role=menu]"), null, "Escape closes");
    assert.equal(document.activeElement, pill, "focus returns to the chip");
    assert.equal(pill.getAttribute("aria-expanded"), "false");
    t.unmount();
  }, SLOW);

  it("every inline field has an accessible name", async () => {
    const t = await setup();
    await t.render({ charter: full });
    const names = t.buttons().map((b) => b.getAttribute("aria-label")).filter(Boolean) as string[];
    for (const n of ["Edit Goal", "Edit Success metric 1", "Edit Success metric 2", "Edit New success metric", "Edit Non goal 1", "Edit Risk 1", "Edit Budget tokens per day", "Edit Budget hands per day", "Remove Risk 1"]) {
      assert.ok(names.includes(n), `${n} in ${names.join(" | ")}`);
    }
    await t.click(t.button(/Make the inbox/));
    const ta = document.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(ta.getAttribute("aria-label"), "Goal");
    assert.ok(document.querySelector("kbd"), "the multiline commit shortcut renders as keycaps");
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
