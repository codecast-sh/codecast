// /priorities mounted in jsdom (test-helpers/prioritiesList.tsx): the milestone lines and what hangs
// off them, each kind of link as its chip and its count, an open milestone's links, the coarse-pointer
// targets, Waiting on you's box and popover, and the one-row line across chips-cell widths, measured
// against the layout stub.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritiesLines.mount.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, TEAM_ID, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { useInboxStore } = await import("../../store/inboxStore");
const { default: PrioritiesPage } = await import("./PrioritiesPage");
const { default: PrioritiesRoute } = await import("../../app/priorities/page");
const { readFilters } = await import("../../lib/priorityList");
const { ALL_KINDS, CHIP_KINDS, DAY, DESK_INBOX_CELL, FILTERS, HISTORY, KINDS, NOW, PL_1075, ROWS, at, base, block, counts, lineAt, links, listOf, mount, partsOf, row, seedKinds, sess, step, view } = await import("../../test-helpers/prioritiesList");

test("with every kind shown, each link is a chip of its own shape, labelled by its title and never a short id", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS], filters: ALL_KINDS }));
  const { act } = React as any;
  try {
    expect(describeFailures(page)).toBe("");
    const b = block(page.container, "pri-9");
    // The closed line, first to last (with room for all of it): the action and its session, "+N", one glyph and
    // count per other kind (its words in the tooltip), the plan.
    const s1 = b.querySelector('[data-milestone="s1"]')!;
    expect(partsOf(s1.querySelector("[data-line-chips]")!)).toEqual(["action", "in Kinds driver", "+1", "task 1", "pr 1", "branch 1", "deploy 1", "plan"]);
    expect(s1.querySelector('[data-chip-count="pr"]')!.getAttribute("title")).toBe("1 pull request");
    // Open, the line lists each one as its own chip.
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    for (const kind of CHIP_KINDS) expect(b.querySelector(`[data-chip="${kind}"]`)).not.toBeNull();
    expect(b.querySelector('[data-chip="task"]')!.textContent).toBe("Write the wiring");
    expect(b.querySelector('[data-chip="branch"]')!.textContent).toBe("feat/every-link");
    expect(page.text()).not.toMatch(/jx7|ct-|pl-/);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("on a phone, Looks done? and correction pending sit on a line under the title, which keeps its width", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "A milestone title long enough to need its two lines", "critical"), step("s2", "Corrected", "critical")], {
    links: [links("s1", [sess("mk1", "Marked session", "needs_you", 1)], { looks_done: true, correction_pending: true }), links("s2", [])],
  });
  const page = await mount(view({ rows: [marked], layout: "phone" }));
  try {
    const line = block(page.container, "pri-8").querySelector('[data-milestone="s1"]')!;
    const marks = line.querySelector("[data-milestone-marks]")!;
    expect(marks.querySelector("[data-looks-done]")).not.toBeNull();
    expect(marks.querySelector("[data-correction-pending]")).not.toBeNull();
    // The title's own line holds the title alone, above the marks.
    const title = line.querySelector("[data-milestone-title]")!;
    expect(title.parentElement).toBe(marks.parentElement);
    expect(title.nextElementSibling).toBe(marks);
    // Whatever trails the line (here the Answer) leaves the title at least 8rem.
    expect(title.closest(".grid")!.className).toContain("grid-cols-[minmax(8rem,1fr)_auto]");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("\"+N older sessions\" in an open milestone opens the priority's page at that milestone", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-1");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    const older = b.querySelector("[data-older-sessions]")!;
    expect(older.textContent).toBe("+3 older sessions");
    expect(older.getAttribute("href")).toBe("/priorities/pri-1?milestone=s1");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("one other kind asked for counts after \"+N sessions\", which stays; none asked for keeps it too", async () => {
  seedKinds();
  const prs = await mount(view({ rows: [KINDS], filters: readFilters(new URLSearchParams("show=sessions,plans,prs")) }));
  try {
    const s1 = block(prs.container, "pri-9").querySelector('[data-milestone="s1"]')!;
    expect(partsOf(s1.querySelector("[data-line-chips]")!)).toEqual(["action", "in Kinds driver", "+1", "pr 1", "plan"]);
    expect(s1.querySelector("[data-more-sessions]")!.getAttribute("aria-label")).toBe("1 more session");
  } finally {
    await prs.unmount();
  }
  const plain = await mount(view({ rows: [KINDS] }));
  try {
    expect(block(plain.container, "pri-9").querySelector('[data-milestone="s1"] [data-more-sessions]')!.textContent).toBe("+1");
  } finally {
    await plain.unmount();
  }
}, 60_000);

test("an open milestone shows every kind of link whatever Show says, and its whole title", async () => {
  seedKinds();
  const long = { ...KINDS, steps: [{ ...KINDS.steps[0], title: "Wire every link a milestone can have, so the open line shows the whole of this long title" }, KINDS.steps[1]] };
  const page = await mount(view({ rows: [long], filters: readFilters(new URLSearchParams("show=none")) }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-9");
    // Show off: a closed line has no chips.
    expect(b.querySelector('[data-milestone="s1"] [data-chip]')).toBeNull();
    const title = () => b.querySelector('[data-milestone="s1"] [data-milestone-title]')!;
    expect(title().className).toContain("truncate");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    const detail = b.querySelector("[data-milestone-detail]")!;
    expect([...detail.querySelectorAll("[data-type-row]")].map((r) => r.getAttribute("data-type-row"))).toEqual(["Plan", "Tasks", "PRs", "Branches", "Deploys"]);
    for (const kind of CHIP_KINDS) expect(detail.querySelector(`[data-chip="${kind}"]`)).not.toBeNull();
    // Under a coarse pointer the plan and task chips are 44px tall, and their rows' labels keep to the first line.
    for (const kind of ["plan", "task"]) {
      const chip = detail.querySelector(`[data-chip="${kind}"]`)!;
      expect(chip.className).toContain("[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:modern:h-11");
      expect(chip.closest("[data-type-row]")!.firstElementChild!.className).toContain("[@media(pointer:coarse)]:h-11");
    }
    expect(title().className).not.toContain("truncate");
    expect(title().className).toContain("whitespace-normal");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("the progress button shows the done critical milestones, and hides them again", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-5");
    expect(b.querySelector('[data-milestone="s2"]')).toBeNull();
    await act(async () => { (b.querySelector("[data-progress-toggle]") as HTMLElement).click(); });
    expect(b.querySelector('[data-milestone="s2"]')!.textContent).toContain("Re-measure grader faults");
    await act(async () => { (b.querySelector("[data-progress-toggle]") as HTMLElement).click(); });
    expect(b.querySelector('[data-milestone="s2"]')).toBeNull();
  } finally {
    await page.unmount();
  }
}, 60_000);

test("every priority says how many landed and how long since, on every layout; a phone's compact line is one line, its today and its sparkline in the row", async () => {
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ layout }));
    try {
      expect(block(page.container, "pri-5").querySelector("[data-momentum-words]")!.textContent).toBe("1 landed · last 2d");
      for (const id of ["pri-1", "pri-2", "pri-3", "pri-4"]) expect(block(page.container, id).querySelector("[data-momentum-words]")!.textContent).toBe("0 landed · none yet");
    } finally {
      await page.unmount();
    }
  }
  const compact = await mount(view({ layout: "phone", compact: true }));
  try {
    const head = block(compact.container, "pri-1").querySelector("[data-priority-head]")!;
    // Today is the bare count just before the progress, as the default row says "4 today": none beside the title.
    expect(head.textContent).not.toContain("today");
    const today = head.querySelector("[data-today]")!;
    expect(today.textContent).toBe("4");
    expect(today.getAttribute("aria-label")).toBe("4 today");
    expect(today.parentElement).toBe(head.children[2] as Element);
    expect(today.nextElementSibling).not.toBeNull();
    // An untouched top three says "0" there; a row past the top three with nothing today says nothing.
    expect(block(compact.container, "pri-3").querySelector("[data-priority-head] [data-today]")?.textContent).toBe("0");
    expect(block(compact.container, "pri-5").querySelector("[data-priority-head] [data-today]")).toBeNull();
    // One line a priority: the mini sparkline stays in the row, and no meta line of words under it.
    expect(head.querySelector("[data-day-strip]")).not.toBeNull();
    expect(head.querySelector("[data-meta]")).toBeNull();
    expect(head.querySelector("[data-momentum-words]")).toBeNull();
    expect(head.querySelector("[data-action]")).not.toBeNull();
  } finally {
    await compact.unmount();
  }
  // A wide compact view stays one line per row: no meta-line words, and at Daylight's narrow grid the polish slot
  // leaves too; a wide one keeps the words beside its strip.
  const wideCompact = await mount(view({ compact: true }));
  try {
    const head = block(wideCompact.container, "pri-5").querySelector("[data-priority-head]")!;
    expect(head.querySelector("[data-momentum-words]")).toBeNull();
    expect(head.querySelector("[data-momentum]")!.textContent).toContain("1 landed");
    // Hidden, not invisible: the slot gives its width back at Daylight's narrow grid.
    expect(head.querySelector("[data-polish-slot]")!.className).toContain("[@container(max-width:44rem)]:hidden");
    expect(head.querySelector("[data-polish-slot]")!.className).not.toContain("invisible");
  } finally {
    await wideCompact.unmount();
  }
  const full = await mount(view());
  try {
    expect(block(full.container, "pri-5").querySelector("[data-polish-slot]")!.className).not.toContain("invisible");
  } finally {
    await full.unmount();
  }
}, 60_000);

test("under a coarse pointer every control on the list is a 44px target, at every layout", async () => {
  seedKinds();
  // A size of 44px or more (h-11, size-11, min-h-11, a box's 52px) at every pointer, or one a coarse pointer gets: its own, or a 44px ::after press area.
  const sized = /(?:^|\s)(?:size-11|h-11|min-h-11|h-\[52px\])(?:\s|$)|\[@media\(pointer:coarse\)\]:(?:h-11|h-12|min-h-11|size-11|h-\[52px\]|after:)/;
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [...ROWS, KINDS], layout, filters: ALL_KINDS }));
    const { act } = React as any;
    try {
      // Open a milestone, so its sessions, runs and links are in the count.
      await act(async () => { (block(page.container, "pri-2").querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
      const controls = [...page.container.querySelectorAll("a[href], button, [role=button]")];
      expect(controls.length).toBeGreaterThan(40);
      const small = controls.filter((el) => !sized.test(el.className)).map((el) => el.outerHTML.slice(0, 120));
      expect(small).toEqual([]);
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("a narrow window takes the desktop grid on a touch screen at least 900px wide (Daylight), and the phone layout otherwise", async () => {
  answers["priorities:list"] = listOf(ROWS);
  answers["priorities:history"] = HISTORY;
  const realMatch = window.matchMedia;
  const realWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  const layoutWith = async (tablet: boolean) => {
    (window as any).matchMedia = (q: string) => ({ ...realMatch(q), matches: tablet && q === "(pointer: coarse) and (min-width: 900px)" });
    const page = await mount(<PrioritiesPage />);
    try {
      return page.container.querySelector("[data-priorities]")?.getAttribute("data-layout");
    } finally {
      await page.unmount();
    }
  };
  try {
    expect(await layoutWith(true)).toBe("wide");
    expect(await layoutWith(false)).toBe("phone");
  } finally {
    (window as any).matchMedia = realMatch;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: realWidth });
  }
}, 60_000);

test("a milestone line's chips use the today and momentum columns, its today count sits in the line, and the action keeps its session while the plan gives way", async () => {
  const history = { ...HISTORY, sessions: { jx7crfl: at(3) } };
  const page = await mount(view({ history }));
  try {
    const grid = block(page.container, "pri-1").querySelector('[data-milestone="s2"] [role=button] > div')!;
    expect(grid.className).toContain("col-end-6");
    // The line's today count is inside the line, not a column of its own.
    expect(block(page.container, "pri-1").querySelector('[data-milestone="s2"] [data-line-today]')!.textContent).toBe("3 today");
    // pri-3: the Open action with "in ‹session›" right after the button, ellipsizing inside the chips cell (the
    // group and the words both shrink); the plan last, the chip a narrow line clips (the open line lists it).
    const line = block(page.container, "pri-3").querySelector('[data-milestone="s1"] [data-line-chips]')!;
    expect(partsOf(line)).toEqual(["action", "in Eval cost reduction", "plan"]);
    // One row that never wraps; the button never shrinks, the session's words ellipsize down to 5rem.
    expect(line.className.split(" ")).toContain("flex-nowrap");
    expect(line.querySelector('[data-fit="fixed"]')!.className.split(" ")).toContain("shrink-0");
    const words = line.querySelector('[data-fit="label"]')!;
    // At least 5rem, and with the plan shown the width the fit held for them (--line-label).
    for (const c of ["min-w-[max(5rem,var(--line-label,0px))]", "shrink"]) expect(words.className.split(" ")).toContain(c);
    expect(words.querySelector("[data-in-session]")!.className.split(" ")).toContain("truncate");
  } finally {
    await page.unmount();
  }
  // "+N sessions" comes after the session's name, before the plan.
  const two = row(11, "Two sessions", 1, [step("s1", "One milestone", "critical"), step("s2", "Another", "critical")], {
    links: [links("s1", [sess("twoa", "First session", "dormant", 1), sess("twob", "Second session", "dormant", 2)], { plan: PL_1075 }), links("s2", [])],
  });
  const both = await mount(view({ rows: [two] }));
  try {
    expect(partsOf(block(both.container, "pri-11").querySelector('[data-milestone="s1"] [data-line-chips]')!)).toEqual(["action", "in First session", "+1", "plan"]);
  } finally {
    await both.unmount();
  }
}, 60_000);

test("Daylight's coarse pointer puts a line's marks under its title; compact moves the row's pending mark to the meta line", async () => {
  const marked = row(8, "Marked", 1, [step("s1", "A milestone", "critical"), step("s2", "Another", "critical")], {
    correction_pending: true,
    links: [links("s1", [], { looks_done: true }), links("s2", [])],
  });
  const page = await mount(view({ rows: [marked] }));
  try {
    const marks = block(page.container, "pri-8").querySelector('[data-milestone="s1"] [data-milestone-marks]')!;
    expect(marks.querySelector("[data-looks-done]")).not.toBeNull();
    // The title and the marks share one box that stacks them under a coarse pointer and sits them side by side on a mouse.
    expect(marks.parentElement!.className).toContain("[@media(pointer:coarse)]:flex-col");
    // The expand chevron shows wherever nothing hovers.
    expect(block(page.container, "pri-8").querySelector('[data-milestone="s1"] [data-line-chevron]')!.getAttribute("class")).toContain("[@media(hover:none)]:opacity-100");
    // The row's own pending correction sits by the title in the full view.
    expect(block(page.container, "pri-8").querySelector("[data-priority-head] [data-correction-pending]")!.closest("[data-meta]")).toBeNull();
  } finally {
    await page.unmount();
  }
  const compact = await mount(view({ rows: [marked], compact: true }));
  try {
    expect(block(compact.container, "pri-8").querySelector("[data-priority-head] [data-correction-pending]")!.closest("[data-meta]")).not.toBeNull();
  } finally {
    await compact.unmount();
  }
}, 60_000);

test("\"Part of ‹plan› (140 tasks)\" is one chip; No priority is a real button", async () => {
  const page = await mount(view());
  const { act } = React as any;
  try {
    const pri3 = block(page.container, "pri-3");
    await act(async () => { (pri3.querySelector("[data-polish]") as HTMLElement).click(); });
    await act(async () => { (pri3.querySelector('[data-milestone="s2"] [role=button]') as HTMLElement).click(); });
    const chip = [...pri3.querySelectorAll('[data-milestone-detail] [data-chip="plan"]')].find((c) => c.textContent?.includes("Part of"))!;
    expect(chip.querySelector("[data-plan-size]")!.textContent).toBe("(140 tasks)");
    // In a narrow row (a phone) the title keeps 6rem: the bar leaves first, then the size (container queries on the row).
    expect(chip.closest("[data-type-row]")!.querySelector(":scope > div")!.className).toContain("[container-type:inline-size]");
    expect([...chip.children].find((c) => c.textContent === "The whole platform program")!.className).toContain("min-w-[6rem]");
    expect(chip.querySelector("[data-plan-bar]")!.getAttribute("class")).toContain("[@container(max-width:24rem)]:hidden");
    expect(chip.querySelector("[data-plan-size]")!.className).toContain("[@container(max-width:17rem)]:hidden");
    expect(pri3.querySelector("[data-milestone-detail]")!.textContent).not.toMatch(/\)\s*140 tasks/);
    expect(page.container.querySelector('[data-today-seg="none"]')!.tagName).toBe("BUTTON");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("a linked session's branch and a PR's state repaint their chips when they change", async () => {
  seedKinds();
  const page = await mount(view({ rows: [KINDS], filters: ALL_KINDS }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-9");
    await act(async () => { (b.querySelector('[data-milestone="s1"] [role=button]') as HTMLElement).click(); });
    expect(b.querySelector('[data-chip="branch"]')!.textContent).toBe("feat/every-link");
    await act(async () => {
      useInboxStore.getState().syncTable("sessions", [{ _id: fixtureId("kinds2"), title: "Kinds helper", worktree_branch: "feat/renamed", updated_at: NOW }] as any, { isDelta: true });
      useInboxStore.setState((s: any) => ({ pullRequests: { ...s.pullRequests, pr4580: { _id: "pr4580", repository: "codecast-sh/codecast", number: 4580, state: "merged" } } }));
    });
    await page.waitFor(() => b.querySelector('[data-chip="branch"]')?.textContent === "feat/renamed");
    await page.waitFor(() => !!b.querySelector('[data-chip="pr"]')?.textContent?.includes("merged"));
  } finally {
    await page.unmount();
  }
}, 60_000);

test("Waiting on you tells two sessions on one milestone apart: \"milestone · session\", in the box, the popover and on a phone", async () => {
  const LONG = "Ship it with the whole long milestone title the box cannot hold";
  const twice = row(12, "Two asks", 1, [step("s1", LONG, "critical"), step("s2", "Tidy it", "critical"), ...[3, 4, 5, 6].map((i) => step(`s${i}`, `Other ${i}`, "critical"))], {
    links: [
      links("s1", [sess("aska", "Copy review", "needs_you", 1), sess("askb", "Review · ct-9001 the copy", "needs_you", 2)]), links("s2", [sess("askc", "Tidy session", "needs_you", 3)]),
      ...[3, 4, 5, 6].map((i) => links(`s${i}`, [sess(`ask${i}`, `Session ${i}`, "needs_you", 3 + i)])),
    ],
  });
  const read = (root: ParentNode) => [...root.querySelectorAll("[data-waiting-item] [data-waiting-label]")].map((a) => [...a.children].map((c) => c.textContent).join(" ") || a.textContent);
  const parts = (root: ParentNode) => {
    // Short of room the parts share it evenly, a shorter one whole (grid tracks grow evenly to their text's width), so the
    // who-part keeps its words up to half; an item naming one is not capped at 20rem.
    const whos = [...root.querySelectorAll("[data-waiting-who]")];
    expect(whos.length).toBeGreaterThanOrEqual(2);
    for (const who of whos) {
      const label = who.closest("[data-waiting-label]")!;
      expect(label.className).toContain("grid-cols-[minmax(0,max-content)_auto_minmax(0,max-content)]");
      expect(who.className).toContain("min-w-0 truncate");
      expect(label.querySelector("[data-waiting-milestone]")!.className).toContain("min-w-0 truncate");
      expect(who.closest("[data-waiting-item]")!.className).not.toContain("max-w-[20rem]");
    }
  };
  // 1280 and Daylight's 947 draw the wide box, 402 the phone's rows; each opens "+N more" too.
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ rows: [twice], layout }));
    const { act } = React as any;
    try {
      const labels = read(page.container);
      expect(labels[0]).toBe(`${LONG} · Copy review`);
      expect(labels[1]).toBe(`${LONG} · Review: the copy`);
      parts(page.container);
      // A milestone only one session waits on reads as the milestone alone, under the 20rem cap on the wide box.
      expect(labels[2]).toBe("Tidy it");
      if (layout === "wide") expect(page.container.querySelectorAll("[data-waiting-item]")[2].className).toContain("max-w-[20rem]");
      // The popover lists every ask, the two on one milestone still apart.
      await act(async () => { (page.container.querySelector("[data-waiting-more]") as HTMLElement).click(); });
      await page.waitFor(() => !!document.querySelector("[data-radix-popper-content-wrapper] [data-waiting-item]"));
      const pop = document.querySelector("[data-radix-popper-content-wrapper]")!;
      expect(read(pop).slice(0, 2)).toEqual([`${LONG} · Copy review`, `${LONG} · Review: the copy`]);
      parts(pop);
    } finally {
      await page.unmount();
    }
  }
}, 60_000);

test("at the desktop width the box never takes a third line: it shows fewer items until \"+N more\" fits the second", async () => {
  const many = row(13, "Many asks", 1, Array.from({ length: 7 }, (_, i) => step(`s${i}`, `Milestone ${i}`, "critical")), {
    links: Array.from({ length: 7 }, (_, i) => links(`s${i}`, [sess(`many${i}`, `Session ${i}`, "needs_you", i + 1)])),
  });
  // Lay the box out as a browser would: three slots a line (the heading, the items, "+N more"), 28px each.
  const proto = (window as any).HTMLElement.prototype;
  const realTop = Object.getOwnPropertyDescriptor(proto, "offsetTop");
  const realHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const realWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { const box = this.closest('[data-waiting="wide"]'); return box ? Math.floor([...box.children].indexOf(this) / 3) * 28 : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 28; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 800; } });
  try {
    const page = await mount(view({ rows: [many] }));
    try {
      await page.waitFor(() => page.container.querySelectorAll('[data-waiting="wide"] [data-waiting-item]').length === 4);
      expect(page.container.querySelector('[data-waiting="wide"] [data-waiting-more]')!.textContent).toBe("+3 more");
    } finally {
      await page.unmount();
    }
  } finally {
    for (const [k, d] of [["offsetTop", realTop], ["offsetHeight", realHeight], ["offsetWidth", realWidth]] as const) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}, 60_000);

test("a new width re-fits the waiting box at once: a resize or a rotation starts over from five", async () => {
  const many = row(13, "Many asks", 1, Array.from({ length: 7 }, (_, i) => step(`s${i}`, `Milestone ${i}`, "critical")), {
    links: Array.from({ length: 7 }, (_, i) => links(`s${i}`, [sess(`many${i}`, `Session ${i}`, "needs_you", i + 1)])),
  });
  let perLine = 3;
  const observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
  const realRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class { constructor(cb: any) { observers.push(cb); } observe() {} disconnect() {} };
  const proto = (window as any).HTMLElement.prototype;
  const realTop = Object.getOwnPropertyDescriptor(proto, "offsetTop");
  const realHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "offsetTop", { configurable: true, get(this: HTMLElement) { const box = this.closest('[data-waiting="wide"]'); return box ? Math.floor([...box.children].indexOf(this) / perLine) * 28 : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 28; } });
  const { act } = React as any;
  try {
    const page = await mount(view({ rows: [many] }));
    const shown = () => page.container.querySelectorAll('[data-waiting="wide"] [data-waiting-item]').length;
    try {
      await page.waitFor(() => shown() === 4);
      // The box widens (four slots a line now): its observer starts it over from five, which fit.
      perLine = 4;
      await act(async () => { for (const cb of observers) { cb([{ contentRect: { width: 800 } }]); cb([{ contentRect: { width: 1100 } }]); } });
      await page.waitFor(() => shown() === 5);
      expect(page.container.querySelector('[data-waiting="wide"] [data-waiting-more]')!.textContent).toBe("+2 more");
      // It narrows again while five show: the new width alone re-runs the fit, which drops back to four.
      perLine = 3;
      await act(async () => { for (const cb of observers) cb([{ contentRect: { width: 700 } }]); });
      await page.waitFor(() => shown() === 4);
    } finally {
      await page.unmount();
    }
  } finally {
    (globalThis as any).ResizeObserver = realRO;
    for (const [k, d] of [["offsetTop", realTop], ["offsetHeight", realHeight]] as const) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}, 60_000);

test("a phone line's state word reads the person's session, not a workflow run; the priority's plan shows on its meta line", async () => {
  const page = await mount(view({ layout: "phone" }));
  try {
    // pri-2's second milestone: the driver (dormant) and two review runs (one idle). The driver is the action's
    // session on another line, which no longer hides it here.
    const line = block(page.container, "pri-2").querySelector('[data-milestone="s2"]')!;
    expect(line.textContent).toContain("Dormant");
    expect(line.textContent).not.toContain("Idle");
    expect(block(page.container, "pri-2").querySelector("[data-meta-plan] [data-chip=plan]")!.textContent).toContain("Every change merges green");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("an untouched top-three priority keeps its title's colour and says \"0\" in its today cell", async () => {
  for (const layout of ["wide", "phone"] as const) {
    const page = await mount(view({ layout }));
    try {
      // pri-3 (#3) has nothing typed today.
      const head = block(page.container, "pri-3").querySelector("[data-priority-head]")!;
      expect(head.querySelector("[title]")!.className).toContain("text-sol-text");
      expect(head.innerHTML).not.toContain("text-sol-text-muted\">Cut eval spend");
      expect(head.querySelector("[data-today]")!.textContent).toBe(layout === "wide" ? "0" : "0 today");
      // A lower priority with nothing today leaves the cell empty.
      const five = block(page.container, "pri-5").querySelector("[data-priority-head] [data-today]");
      expect(five?.textContent ?? "").toBe("");
    } finally {
      await page.unmount();
    }
  }
}, 60_000);


test("the line's one row across chips-cell widths: action, its session and +N always; the counts from 300px; the plan once the session has 12rem and the plan's title 8rem", async () => {
  const title = "Rework the scorer calibration so session mapping clears 0.75";
  expect(title.length).toBe(60);
  const busy = row(14, "Busy line", 1, [step("s1", "Ship the scorer", "critical", false, { refs: [{ kind: "task", id: "ct-8101" }, { kind: "pr", id: "codecast-sh/codecast#4601" }, { kind: "pr", id: "codecast-sh/codecast#4602" }] }), step("s2", "Another", "critical")], {
    links: [links("s1", [sess("busy1", title, "dormant", 1), ...[2, 3, 4, 5].map((i) => sess(`busy${i}`, `Helper ${i}`, "dormant", i))], { plan: PL_1075 }), links("s2", [])],
  });
  const at = async (w: number) => lineAt(w, [busy]);
  const base = { action: true, label: `in ${title}`, more: "+4", moreLabel: "4 more sessions" };
  expect(await at(220)).toEqual({ ...base, kinds: [], plan: null, held: null });
  expect(await at(300)).toEqual({ ...base, kinds: ["task 1", "pr 2"], plan: null, held: null });
  // 420px held 8rem for the plan once; now the session's words come first: 265px for the rest, 112px more for
  // the words (to 12rem), and 206px for the plan (72px of chrome, 128px of title) need a 595px cell.
  expect(await at(420)).toEqual({ ...base, kinds: ["task 1", "pr 2"], plan: null, held: null });
  expect(await at(590)).toEqual({ ...base, kinds: ["task 1", "pr 2"], plan: null, held: null });
  const line = await at(600);
  expect(line).toMatchObject({ ...base, kinds: ["task 1", "pr 2"], held: ["192px", "200px"] });
  expect(line.plan).toContain("Every change merges green");
}, 60_000);

test("a plan with a short title needs only that title's width, not 8rem", async () => {
  const short = { ...PL_1075, title: "Ship it" };
  const busy = row(14, "Busy line", 1, [step("s1", "Ship the scorer", "critical"), step("s2", "Another", "critical")], {
    links: [links("s1", [sess("busy1", "Scorer", "dormant", 1)], { plan: short }), links("s2", [])],
  });
  // "in Scorer" fits its 5rem; the plan takes 72px of chrome and its 7-character title's 35px.
  const line = await lineAt(300, [busy]);
  expect(line.plan).toContain("Ship it");
  expect(line.held).toEqual(["80px", "107px"]);
}, 60_000);

test("the Done-list case: at the 1280-with-inbox chips cell, \"Deploy drops the eval job\" shows its plan", async () => {
  const line = await lineAt(DESK_INBOX_CELL, ROWS, FILTERS, "pri-3", "s1");
  expect(line.action).toBe(true);
  expect(line.label).toBe("in Eval cost reduction");
  expect(line.plan).toContain("Every change merges green");
  // The session's words whole (130px) and the plan's title its 8rem.
  expect(line.held).toEqual(["130px", "200px"]);
}, 60_000);

test("a lone \"+N\" (a rail line, after Start) reads \"+N sessions\" when it fits; beside a session's name it stays \"+N\"", async () => {
  // s1 heads the bracket and names its driver; s2, under the rail, has only one older session; s3 (the next
  // milestone with no session) is Start's, three more sessions after the button.
  const driver = sess("lone0", "Driver session", "dormant", 1);
  const rail = row(15, "Rail", 1, [step("s1", "Head", "critical"), step("s2", "Under the rail", "critical"), step("s3", "Starts here", "critical")], {
    links: [links("s1", [driver]), links("s2", [driver], { sessions_more: 1 }), links("s3", [], { sessions_more: 3 })],
  });
  const under = await lineAt(600, [rail], FILTERS, "pri-15", "s2");
  expect(under.label).toBeNull();
  expect(under.more).toBe("+1\u00a0session");
  expect(under.moreLabel).toBe("1 more session");
  // A narrow line keeps "+1".
  expect((await lineAt(40, [rail], FILTERS, "pri-15", "s2")).more).toBe("+1");
  const start = { ...rail, links: [links("s1", []), links("s2", []), links("s3", [], { sessions_more: 3 })], steps: rail.steps.map((st: any, i: number) => (i < 2 ? { ...st, done: true, done_at: NOW - DAY } : st)) };
  const after = await lineAt(600, [start], FILTERS, "pri-15", "s3");
  expect(after.action).toBe(true);
  expect(after.label).toBeNull();
  expect(after.more).toBe("+3\u00a0sessions");
  // Beside "in ‹session›" it stays "+N" with its label, wide or tight.
  const named = row(16, "Named", 1, [step("s1", "Ship", "critical")], {
    links: [links("s1", [sess("named1", "First session", "dormant", 1), sess("named2", "Second session", "dormant", 2)], { sessions_more: 7 })],
  });
  for (const w of [220, 600]) {
    const line = await lineAt(w, [named], FILTERS, "pri-16", "s1");
    expect(line.label).toBe("in First session");
    expect(line.more).toBe("+8");
    expect(line.moreLabel).toBe("8 more sessions");
  }
}, 60_000);

test("the route shows the feature-off landing while the workspace has Priorities off", async () => {
  useInboxStore.getState().syncTable("teams", [{ _id: TEAM_ID, name: "Degrade Co", role: "admin", features: { priorities: false } }] as any);
  const page = await mount(<PrioritiesRoute />);
  try {
    expect(page.container.querySelector("[data-priorities]")).toBeNull();
    expect(page.text()).not.toContain("No priorities yet");
  } finally {
    await page.unmount();
  }
}, 60_000);
