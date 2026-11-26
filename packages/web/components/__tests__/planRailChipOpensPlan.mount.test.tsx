import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
// Imported before the DOM globals exist, so the store skips its browser-only
// cache hydration (IndexedDB), which JSDOM can't serve.
import "../../store/inboxStore";

// ct-101660: a plan chip in a conversation's context rail opened a summary
// panel, and the plan page sat behind a "View full plan" link inside it. A
// person who wanted the plan pressed the chip again and again (9 presses
// across three plans in rp-25924) and never got there. One press on the plan
// chip, or a control beside it on the rail, must lead to /plans/<short id>
// with no panel in between, even when the chip shares the row with others.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/conversation/c1" });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w,
  document: w.document,
  navigator: w.navigator,
  HTMLElement: w.HTMLElement,
  Element: w.Element,
  Node: w.Node,
  Event: w.Event,
  MouseEvent: w.MouseEvent,
  MutationObserver: w.MutationObserver,
  getComputedStyle: w.getComputedStyle,
  requestAnimationFrame: w.requestAnimationFrame,
  cancelAnimationFrame: w.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const PLAN_ID = "pl_doc_1";
const SHORT = "pl-1095";
const plan = {
  _id: PLAN_ID,
  short_id: SHORT,
  title: "Close concerns: prototype five follow-ups and report",
  goal: "A long goal that the panel cuts to two lines.",
  status: "active",
  progress: { done: 8, total: 8 },
  tasks: [{ _id: "t1", title: "First task", status: "done", priority: "medium" }],
};

// Every way the chip could get the person to the plan is recorded: a link
// press (next/link) and a router push (next/navigation).
const navigations: string[] = [];
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({ ...realQuery, useQueryNoThrow: () => ({ data: plan, error: null }) }));
mock.module("next/link", () => ({
  default: ({ href, onClick, children, prefetch: _p, ...rest }: any) => (
    <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(e); navigations.push(String(href)); }} {...rest}>{children}</a>
  ),
}));
const realNav = { ...(await import("next/navigation")) };
const router = {
  push: (href: string) => { navigations.push(String(href)); },
  replace: (href: string) => { navigations.push(String(href)); },
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
};
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => router }));

const { createRoot } = await import("react-dom/client");
const { ContextRail, RailChip } = await import("../ContextRail");
const { PlanContextPanel } = await import("../PlanContextPanel");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

beforeEach(() => {
  navigations.length = 0;
  document.body.innerHTML = "";
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ContextRail>
        <RailChip data-cc-rail-item="task" open={false} onToggle={() => {}} title="A task">
          <span>Some task</span>
        </RailChip>
        <PlanContextPanel planId={PLAN_ID as any} />
      </ContextRail>,
    );
  });
  return { host, root };
}

// A link in the rail row itself (not the opened detail body), and not one the
// stylesheet hides when the chip shares the row (data-rail-full).
function rowPlanLinks(host: HTMLElement): HTMLAnchorElement[] {
  const row = host.querySelector("[data-cc-context-row] > div:first-child")!;
  return [...row.querySelectorAll<HTMLAnchorElement>(`a[href="/plans/${SHORT}"]`)].filter((a) => !a.closest("[data-rail-full]"));
}

test("one press on the plan chip (sharing the row) reaches the plan page, no panel first", () => {
  const { host, root } = mount();
  const chip = host.querySelector<HTMLElement>('[data-cc-rail-item="plan"]');
  expect(chip).not.toBeNull();

  // Either the rail row carries a visible link straight to the plan…
  const direct = rowPlanLinks(host);
  if (direct.length > 0) {
    act(() => { direct[0].click(); });
  } else {
    // …or one press on the chip itself goes there.
    act(() => { chip!.click(); });
  }

  expect(navigations).toContain(`/plans/${SHORT}`);
  act(() => root.unmount());
});
