// The ten-day strips on /priorities and the breakdown under them
// (components/priorities/parts DayStrip, MessagesByWorkspace), mounted in
// jsdom over the list's fixtures (test-helpers/prioritiesList.tsx). Proves: a
// tap (focus) opens a day's card and a day is no Tab stop; until the typing
// arrives each strip is its baseline with no card; and "Where your messages
// went" renders last in the list, its bars on the strips' own columns.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityStrips.mount.test.tsx
import { expect, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
// Radix's focus scope walks the popover with a TreeWalker.
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { HISTORY, ROWS, block, days, listOf, mount, view } = await import("../../test-helpers/prioritiesList");

test("a tap on a day (focus, as a touch screen gives it) opens its card; a day is no Tab stop", async () => {
  const { act } = React as any;
  const page = await mount(view());
  try {
    const bars = [...block(page.container, "pri-1").querySelectorAll("[data-priority-head] [data-day]")] as HTMLElement[];
    expect(bars.every((d) => d.getAttribute("tabindex") === "-1")).toBe(true);
    await act(async () => { bars[9].focus(); });
    await page.waitFor(() => !!document.querySelector("[data-day-card]"), 2000);
    expect(document.querySelector("[data-day-card]")!.textContent).toContain("4 messages");
  } finally {
    await page.unmount();
  }
}, 60_000);

test("until the typing arrives, each strip is its empty baseline and no day opens a card", async () => {
  const { act } = React as any;
  const page = await mount(view({ history: undefined }));
  try {
    const strip = block(page.container, "pri-1").querySelector("[data-priority-head] [data-day-strip]")!;
    expect(strip.hasAttribute("data-pending")).toBe(true);
    const bars = [...strip.querySelectorAll("[data-day]")];
    expect(bars).toHaveLength(days.length);
    // No count is claimed, each bar is the 2px baseline, and the columns keep the strip's widths.
    expect(bars.every((d) => !d.hasAttribute("data-count"))).toBe(true);
    expect(bars.every((d) => (d.firstElementChild as HTMLElement).style.height === "2px")).toBe(true);
    expect(bars[0].parentElement!.className).toContain("w-[20px]");
    await act(async () => {
      const trigger = bars[9].parentElement!;
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new (window as any).MouseEvent("mouseenter", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(document.querySelector("[data-day-card]")).toBeNull();
  } finally {
    await page.unmount();
  }
  // Once it arrives the strip draws the counts.
  const ready = await mount(view());
  try {
    const strip = block(ready.container, "pri-1").querySelector("[data-priority-head] [data-day-strip]")!;
    expect(strip.hasAttribute("data-pending")).toBe(false);
    expect(strip.querySelectorAll("[data-count]")).toHaveLength(days.length);
  } finally {
    await ready.unmount();
  }
}, 60_000);

test("where your messages went sits at the bottom of the list, its day bars on the strips' own day columns", async () => {
  const prev = { history: answers["priorities:history"], list: answers["priorities:list"] };
  answers["priorities:history"] = HISTORY;
  answers["priorities:list"] = listOf(ROWS);
  const page = await mount(view());
  try {
    await page.waitFor(() => !!page.container.querySelector("[data-messages-by-workspace]"));
    const list = page.container.querySelector("[data-priorities]")!;
    const section = list.querySelector("[data-messages-by-workspace]")!;
    // Last in the list, after every row and the past ones.
    expect(list.lastElementChild).toBe(section);
    const spaces = [...section.querySelectorAll("[data-workspace]")];
    expect(spaces.length).toBeGreaterThan(0);
    // One bar per day the strips draw, each in a column the same width as a strip's day, the same gap apart.
    const strip = block(page.container, "pri-1").querySelector("[data-day-strip]")!;
    const stripDay = strip.querySelector("[data-day]")!.parentElement!;
    for (const w of spaces) {
      const bars = [...w.querySelectorAll("[data-day]")];
      expect(bars).toHaveLength(days.length);
      for (const cls of ["w-[20px]", "[@container(max-width:40rem)]:w-[7px]"]) {
        expect(stripDay.className).toContain(cls);
        expect(bars[0].className).toContain(cls);
      }
      for (const cls of ["gap-1", "[@container(max-width:40rem)]:gap-[2px]"]) {
        expect(strip.className).toContain(cls);
        expect(bars[0].parentElement!.className).toContain(cls);
      }
    }
  } finally {
    await page.unmount();
    for (const [k, v] of [["priorities:history", prev.history], ["priorities:list", prev.list]] as const) {
      if (v === undefined) delete answers[k];
      else answers[k] = v;
    }
  }
}, 60_000);
