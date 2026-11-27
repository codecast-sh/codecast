import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { LabelChipsRow } from "../LabelChipsRow";
import { MemoryRouter } from "react-router";

import { closeDomWindow } from "../../test-helpers/domGlobals";
// The +N pill is the ONLY way to reach a label the row clipped away, so two
// things about it are load-bearing, and both broke in the session panel at
// narrow widths (zooming the desktop app in squeezes the header the same way):
//
//   1. It used to live INSIDE the row's overflow-hidden clip shell. That shell
//      is `flex-1 min-w-0`, so the panel header can squeeze it to zero width —
//      and it then clipped the pill out of paint AND out of hit testing.
//      Clicking where the pill had been landed on the panel's icon cluster,
//      which is why "clicking +57 does nothing, a reload fixes it".
//   2. The document mousedown that dismisses the popover fired before the
//      pill's own click, so the click reopened what the mousedown had just
//      closed and the pill could never close the popover.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Real Convex ids: a non-Convex id reads as an optimistic create stub, which
// keeps a zero-count label in the row instead of behind the pill.
const A = "mh73xedd7ep2nmr082mqnxts2x86kzfy";
const B = "jx75sqw53801qvexsvem39mbhh88c8wt";

beforeEach(() => {
  useInboxStore.setState({
    buckets: {
      [A]: { _id: A, name: "growth", sort_order: 0 },
      [B]: { _id: B, name: "outreach", sort_order: 1 },
    } as any,
    activeBucketFilter: null,
    activeProjectFilter: null,
    chipFilterExclude: false,
    extraBucketFilters: [],
    extraProjectFilters: [],
    activeProjectPath: null,
  } as any);
});

async function mountRow(machineCounts: Array<[string, number]> = [], priorityCounts: Array<[string, number]> = [], bucketCounts: Record<string, number> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Both labels hold nothing, so both live behind the pill: +2.
  await act(() =>
    root.render(
      <MemoryRouter>
        <LabelChipsRow
          bucketCounts={bucketCounts}
          projectCounts={[]}
          projectPathByName={{}}
          machineCounts={machineCounts}
          priorityCounts={priorityCounts}
          dropSessionOnLabel={() => {}}
        />
      </MemoryRouter>,
    ),
  );
  const pill = [...container.querySelectorAll("button")].find((b) =>
    /^\+\d+$/.test((b.textContent || "").trim()),
  ) as HTMLElement;
  return { container, root, pill };
}

const popoverEl = () =>
  [...document.body.querySelectorAll("div")].find((d) =>
    (d.getAttribute("class") || "").includes("z-[9999]"),
  );

test("machines stay in the popover; one joins the row only while it is in the filter", async () => {
  useInboxStore.setState({ machineRoster: [{ device_id: "m2", label: "jb-m2-pro" }] } as any);
  const { container, root } = await mountRow([["mc:m2", 4]]);
  const rowChip = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("jb-m2-pro"));
  try {
    expect(rowChip()).toBeUndefined();
    await act(() => useInboxStore.setState({ activeProjectFilter: "mc:m2" } as any));
    expect(rowChip()).toBeTruthy();
  } finally {
    await act(() => root.unmount());
    container.remove();
    useInboxStore.setState({ machineRoster: [] } as any);
  }
});

test("the pill renders outside the clip shell that can collapse to zero width", async () => {
  const { container, root, pill } = await mountRow();
  try {
    expect(pill).toBeTruthy();
    expect(pill.textContent?.trim()).toBe("+2");
    // Walk up to the component root: no ancestor on the way may clip, or a
    // squeezed panel header takes the pill's paint and its clicks with it.
    const clipping: string[] = [];
    for (let el = pill.parentElement; el && el !== container; el = el.parentElement) {
      const cls = el.getAttribute("class") || "";
      if (cls.includes("overflow-hidden")) clipping.push(cls);
    }
    expect(clipping).toEqual([]);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("a mousedown plus click on the pill closes the popover it opened", async () => {
  const { container, root, pill } = await mountRow();
  try {
    // JSDOM does no layout, and the popover only renders once it has a real
    // anchor box to place against.
    pill.getBoundingClientRect = () =>
      ({ left: 900, right: 940, top: 80, bottom: 100, width: 40, height: 20, x: 900, y: 80, toJSON() {} }) as DOMRect;

    const press = async () => {
      await act(() => {
        pill.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
        pill.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    };

    await press();
    expect(popoverEl()).toBeTruthy();

    await press();
    expect(popoverEl()).toBeUndefined();

    await press();
    expect(popoverEl()).toBeTruthy();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("the popover is placed under the pill and capped to the room below it", async () => {
  const { container, root, pill } = await mountRow();
  try {
    pill.getBoundingClientRect = () =>
      ({ left: 900, right: 940, top: 80, bottom: 100, width: 40, height: 20, x: 900, y: 80, toJSON() {} }) as DOMRect;
    await act(() => {
      pill.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    const pop = popoverEl() as HTMLElement;
    expect(pop).toBeTruthy();
    expect(pop.style.top).toBe("106px"); // pill bottom + 6
    expect(pop.style.left).toBe("684px"); // right edge aligned to the pill: 940 - 256
    // Never taller than the room under the pill, so a long list scrolls inside
    // the window instead of running off its bottom edge.
    const cap = Math.min(window.innerHeight - 100 - 16, window.innerHeight * 0.6);
    expect(parseFloat(pop.style.maxHeight)).toBeLessThanOrEqual(cap);
    expect(parseFloat(pop.style.maxHeight)).toBeGreaterThan(0);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

const openPopover = async (pill: HTMLElement) => {
  pill.getBoundingClientRect = () =>
    ({ left: 900, right: 940, top: 80, bottom: 100, width: 40, height: 20, x: 900, y: 80, toJSON() {} }) as DOMRect;
  await act(() => {
    pill.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  return popoverEl() as HTMLElement;
};
const TOP_N: Array<[string, number]> = [["pr:3", 2], ["pr:5", 3], ["pr:10", 5]];

test("the popover reads Projects, Folders, Machines, Priorities, then Labels", async () => {
  useInboxStore.setState({ machineRoster: [{ device_id: "m2", label: "jb-m2-pro" }] } as any);
  const { container, root, pill } = await mountRow([["mc:m2", 4]], TOP_N);
  try {
    const pop = await openPopover(pill);
    const text = pop.textContent ?? "";
    const at = (s: string) => text.indexOf(s);
    expect(at("Machines")).toBeGreaterThanOrEqual(0);
    expect(at("Machines")).toBeLessThan(at("Priorities"));
    expect(at("Priorities")).toBeLessThan(at("Labels"));
    expect([...pop.querySelectorAll<HTMLElement>("[data-popover-axis-row]")].map((el) => el.dataset.popoverAxisRow)).toEqual(["mc:m2", "pr:3", "pr:5", "pr:10"]);
    // Top N rows carry no count; machine rows keep theirs.
    expect(pop.querySelector('[data-popover-axis-row="pr:10"]')?.textContent?.trim()).toBe("Top 10");
    expect(pop.querySelector('[data-popover-axis-row="mc:m2"]')?.textContent).toContain("4");
  } finally {
    await act(() => root.unmount());
    container.remove();
    useInboxStore.setState({ machineRoster: [] } as any);
  }
});

test("the pill stays reachable for Top N even when every label chip fits", async () => {
  // Both labels hold sessions, so nothing hides; only the Top N rows need the popover.
  const { container, root, pill } = await mountRow([], TOP_N, { [A]: 1, [B]: 2 });
  try {
    expect(pill?.textContent?.trim()).toBe("+3");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("a Top N in the filter joins the row as a chip", async () => {
  const { container, root } = await mountRow([], TOP_N);
  const rowChip = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Top 3"));
  try {
    expect(rowChip()).toBeUndefined();
    await act(() => useInboxStore.setState({ activeProjectFilter: "pr:3" } as any));
    expect(rowChip()).toBeTruthy();
    // The chip draws its label twice (an invisible copy holds the width) and no count.
    expect(rowChip()!.textContent?.replaceAll("Top 3", "").trim()).toBe("");
  } finally {
    await act(() => root.unmount());
    container.remove();
    await act(() => useInboxStore.setState({ activeProjectFilter: null } as any));
  }
});

test("a long folder list shows five, the rest behind a fold, so Priorities stays near the top", async () => {
  const many: Array<[string, number]> = Array.from({ length: 12 }, (_, i) => [`folder${i}`, 12 - i]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter>
        <LabelChipsRow bucketCounts={{}} projectCounts={many} projectPathByName={{}} machineCounts={[]} priorityCounts={TOP_N} dropSessionOnLabel={() => {}} />
      </MemoryRouter>,
    ),
  );
  try {
    const pill = [...container.querySelectorAll("button")].find((b) => /^\+\d+$/.test((b.textContent || "").trim())) as HTMLElement;
    const pop = await openPopover(pill);
    const folderRows = () => [...pop.querySelectorAll<HTMLElement>("[data-popover-axis-row]")].filter((el) => el.dataset.popoverAxisRow?.startsWith("folder"));
    expect(folderRows().length).toBe(5);
    const fold = pop.querySelector<HTMLElement>('[data-popover-axis-fold="Folders"]')!;
    expect(fold.textContent).toContain("7 more folders");
    await act(() => fold.click());
    expect(folderRows().length).toBe(12);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
