// The plan's Graph tab as it renders (task-graph.md TG12). Proves the three
// things only the markup can say: every state of the tab sits in the same
// panel the other tabs sit in (an empty plan must not look broken), the key's
// families of meaning — status NAMES, the edge phrases, the wait pills' — are
// separated rather than run together in one row, the picture pans inside a
// capped box so the key, the only place those marks are explained, stays on
// screen, and the whole shape is fitted to the panel by default rather than
// opening on its leftmost wave.
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
  const groups = [...key.children].filter((c) => !c.hasAttribute("aria-hidden") && !c.hasAttribute("data-plan-graph-fit"));
  // One family per kind of mark: the statuses as names, then the edge phrases,
  // then the wait pills' — "cleared" (an edge) and "still waiting" (a pill)
  // say different things about different marks, so they never share a run.
  expect(groups.length).toBe(3);
  expect(groups.map((g) => g.textContent)).toEqual(["OpenDone", "cleared", "still waiting"]);
  // A divider between each pair, so no two families read as one run.
  const dividers = [...key.children].filter((c) => c.hasAttribute("aria-hidden"));
  expect(dividers.length).toBe(2);
  for (const d of dividers) expect(d.className).toContain("border-l");
  expect(dividers.map((d) => [...key.children].indexOf(d))).toEqual([1, 3]);
});

test("the picture pans inside a capped box, so the key stays on screen", () => {
  const root = render([task(1)]);
  const box = root.querySelector("[data-plan-graph-key]")!.nextElementSibling as HTMLElement;
  expect(box.className).toContain("max-h-[");
  expect(box.className).toContain("overflow-y-auto");
  // The key is outside the scroll box, which is why the box is what scrolls.
  expect(box.querySelector("[data-plan-graph-key]")).toBeNull();
});

test("the graph is fitted to the panel, with 1:1 on offer for reading it", () => {
  const root = render([task(1), task(2, { blocked_by: ["ct-1"] })]);
  // Fitted by default: the viewBox scales the whole shape into the panel's
  // width, and nothing can overflow sideways.
  const svg = root.querySelector("svg[viewBox]")!;
  expect(svg.getAttribute("width")).toBeNull();
  expect(svg.getAttribute("class")).toContain("w-full");
  // Past 1:1 the graph is drawn at its own size rather than enlarged.
  expect(svg.getAttribute("style")).toContain("max-width");
  expect(root.querySelector("[data-plan-graph-key]")!.nextElementSibling!.className).toContain("overflow-x-hidden");
  // The control that switches to the reading size sits with the key.
  const fit = root.querySelector("[data-plan-graph-fit]")!;
  expect(fit.getAttribute("data-plan-graph-fit")).toBe("fit");
  expect(fit.textContent).toBe("1:1");
  // The label is the action, so the button has no pressed state to contradict
  // it; its accessible name is what the press does.
  expect(fit.getAttribute("aria-pressed")).toBeNull();
  expect(fit.getAttribute("aria-label")).toBe("Draw the graph at its own size and scroll it");
  expect(fit.closest("[data-plan-graph-key]")).not.toBeNull();
});

test("a wait pill opens what it names, and a time wait — which names nothing — does not", () => {
  const root = render([
    task(1, { waits: [{ id: "w1", kind: "decision", decision: "sd-4", state: "waiting", created_at: 0 }] }),
    task(2, { waits: [{ id: "w2", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "waiting", created_at: 0 }] }),
    task(3, { waits: [{ id: "w3", kind: "time", at: 4e12, state: "waiting", created_at: 0 }] }),
  ]);
  // The pill is the chrome every clickable reference wears, and the wait names
  // the one thing explaining why a wave is stuck, so it is reachable by
  // keyboard and openable (TG12) — like the task nodes beside it.
  const links = [...root.querySelectorAll("g[role=link]")] as HTMLElement[];
  const named = links.map((g) => g.querySelector("title")!.textContent!);
  expect(named.filter((t) => t.includes("sd-4")).length).toBe(1);
  expect(named.filter((t) => t.includes("#42")).length).toBe(1);
  for (const g of links) expect(g.getAttribute("tabindex")).toBe("0");
  // A time names nothing to open, so its pill stays inert rather than
  // promising a click it cannot honour.
  expect(named.some((t) => /until/i.test(t))).toBe(false);
  // The three task nodes plus the two openable waits.
  expect(links.length).toBe(5);
  // A pill is drawn before the task nodes, so a keyboard reader meets every
  // one of them first: its name says which task it holds, not only what it
  // waits for.
  expect(named.find((t) => t.includes("sd-4"))).toBe("Waiting on sd-4 — holds ct-1 Task 1");
});

test("a node says it HOLDS its task only while it does: a met wait is on it", () => {
  const root = render([
    task(1, { waits: [{ id: "w1", kind: "pr_merged", repository: "o/r", pr_number: 42, state: "met", created_at: 0, note: "merged" }] }),
    task(2, { waits: [{ id: "w2", kind: "decision", decision: "sd-9", state: "failed", created_at: 0, note: "dismissed" }] }),
  ]);
  const named = [...root.querySelectorAll("g[role=link] > title")].map((t) => t.textContent!);
  // Present tense would contradict the rest of the name: "PR o/r#42 merged —
  // holds ct-1" says both that the wait cleared and that it is still blocking.
  // A failed wait keeps blocking (TG2), so that one still holds.
  expect(named.find((t) => t.includes("#42"))).toBe("PR o/r#42 merged — on ct-1 Task 1");
  expect(named.find((t) => t.includes("sd-9"))).toBe("Wait on sd-9 failed: dismissed — holds ct-2 Task 2");
});

test("a halted agent draws and reads as the status it reported, in that status's colour", () => {
  const root = render([
    task(1, { execution_status: "blocked" }),
    task(2, { execution_status: "needs_context" }),
  ]);
  const nodes = [...root.querySelectorAll("g[role=link]")] as HTMLElement[];
  // The dashed border is the graph's one alarm, so the words beside it name
  // the status that drew it: a task whose agent asked a person for context is
  // not a stuck agent, and the board's badge calls it Needs Context in orange.
  expect(nodes.map((g) => g.getAttribute("aria-label"))).toEqual([
    "Open task ct-1: Task 1 — Open, blocked",
    "Open task ct-2: Task 2 — Open, needs context",
  ]);
  expect(nodes.map((g) => g.querySelector("rect")!.getAttribute("style"))).toEqual([
    expect.stringContaining("--sol-red"),
    expect.stringContaining("--sol-orange"),
  ]);
  // The key explains each one, in its own colour.
  const key = root.querySelector("[data-plan-graph-key]")!;
  expect(key.textContent).toContain("the agent is blocked");
  expect(key.textContent).toContain("the agent needs context");
});
