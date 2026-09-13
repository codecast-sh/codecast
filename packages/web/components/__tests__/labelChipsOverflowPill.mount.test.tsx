import { afterAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { LabelChipsRow } from "../LabelChipsRow";

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
afterAll(() => {
  dom.window.close();
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

async function mountRow() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Both labels hold nothing, so both live behind the pill: +2.
  await act(() =>
    root.render(
      <LabelChipsRow
        bucketCounts={{}}
        projectCounts={[]}
        projectPathByName={{}}
        dropSessionOnLabel={() => {}}
      />,
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
