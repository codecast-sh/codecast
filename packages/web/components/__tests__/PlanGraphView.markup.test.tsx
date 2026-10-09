// The plan's Graph tab as it renders (task-graph.md TG12). Proves the three
// things only the markup can say: every state of the tab sits in the same
// panel the other tabs sit in (an empty plan must not look broken), the key's
// two families of meaning — status NAMES and the lowercase phrases that
// explain the colours and dashes — are separated rather than run together in
// one row, and the picture pans inside a capped box so the key, the only place
// those marks are explained, stays on screen.
// Run: bun test components/__tests__/PlanGraphView.markup.test.tsx
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const { PlanGraphView } = await import("../PlanGraphView");
const { JSDOM } = await import("jsdom");

const task = (n: number, over: Record<string, unknown> = {}) =>
  ({ _id: `id${n}`, short_id: `ct-${n}`, title: `Task ${n}`, status: "open", ...over }) as any;

/** The rendered tab as a DOM to query. */
function render(tasks: any[]): HTMLElement {
  const dom = new JSDOM(`<!doctype html><html><body><div id="r">${renderToStaticMarkup(<PlanGraphView tasks={tasks} />)}</div></body></html>`);
  return dom.window.document.getElementById("r")!.firstElementChild as HTMLElement;
}

const PANEL = ["rounded-lg", "border", "bg-sol-bg-alt/30"];

test("a plan with no tasks keeps the panel, so the tab reads as empty rather than broken", () => {
  const empty = render([]);
  for (const c of PANEL) expect(empty.className).toContain(c);
  expect(empty.textContent).toContain("This plan has no tasks yet");
  // The same frame holds the drawn graph.
  const drawn = render([task(1)]);
  for (const c of PANEL) expect(drawn.className).toContain(c);
});

test("the key separates the status names from the phrases that explain the marks", () => {
  // ct-1 is finished (a cleared edge), ct-2 open and held by it, ct-3 waiting.
  const root = render([
    task(1, { status: "done" }),
    task(2, { blocked_by: ["ct-1"] }),
    task(3, { waits: [{ id: "w1", kind: "decision", decision: "sd-4", state: "waiting", created_at: 0 }] }),
  ]);
  const key = root.querySelector("[data-plan-graph-key]")!;
  const groups = [...key.children].filter((c) => !c.hasAttribute("aria-hidden"));
  expect(groups.length).toBe(2);
  // Statuses first, as names; then the encodings, as lowercase phrases.
  expect(groups[0].textContent).toBe("OpenDone");
  expect(groups[1].textContent).toBe("clearedstill waiting");
  // A divider between them, so the two families never read as one run.
  const divider = [...key.children].find((c) => c.hasAttribute("aria-hidden"))!;
  expect(divider.className).toContain("border-l");
  expect([...key.children].indexOf(divider)).toBe(1);
});

test("the picture pans inside a capped box, so the key stays on screen", () => {
  const box = render([task(1)]).querySelector("div.overflow-auto") as HTMLElement;
  expect(box.className).toContain("max-h-[");
  // The key is outside the scroll box, which is why the box is what scrolls.
  expect(box.querySelector("[data-plan-graph-key]")).toBeNull();
});
