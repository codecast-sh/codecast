// The Deploys page's focus chip: the thing a link names reads as the pill a conversation draws for it (a session or
// task by its title), never a raw conversation id, and its × still clears the highlight; a change on its
// way reads as on its way. The pill runs for real; only the Convex transport is faked. Below it, the landing a link
// runs (landFocus): each column brings its highlighted row to the middle, the row flashes once, and the viewer's own
// move ends it.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
}));
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({ ...noThrow, useQueryNoThrow: () => ({ data: undefined }) }));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { FocusChip, Paused } = await import("../DeploysPage");
const { landFocus } = await import("../../../lib/deploys/landFocus");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const CONVERSATION_ID = "jx7b0m0k4q2v9d8h3s6n1p5r7t2w8y4z";

function mount(focus: any, onClear = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><FocusChip focus={focus} repository="acme/app" waiting deploys={[]} live={null} onClear={onClear} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("a session named by its conversation id is the app's session pill, never the raw id, and its × clears", () => {
  let cleared = 0;
  const { host, unmount } = mount({ kind: "session", id: CONVERSATION_ID }, () => cleared++);
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.textContent).not.toContain(CONVERSATION_ID);
  expect(chip.querySelector(`.dpp-focus-ref a[href="/conversation/${CONVERSATION_ID}"]`)).not.toBeNull();
  act(() => (chip.querySelector("[data-deploy-focus-clear]") as HTMLButtonElement).click());
  expect(cleared).toBe(1);
  unmount();
});

test("a task, PR, commit and deploy are each the pill a conversation draws, at their own page", () => {
  for (const [focus, href] of [
    [{ kind: "task", id: "ct-98653" }, "/tasks/ct-98653"],
    [{ kind: "pr", pr: 12 }, "/pr/acme/app/12"],
    [{ kind: "sha", sha: "abcdef1234" }, "/commit/acme/app/abcdef1234"],
    [{ kind: "deploy", id: "dp-3080" }, "/deploys?deploy=dp-3080"],
  ] as const) {
    const { host, unmount } = mount(focus);
    expect(host.querySelector(".dpp-focus-ref a")!.getAttribute("href")).toBe(href);
    unmount();
  }
});

test("a branch keeps its plain name", () => {
  const { host, unmount } = mount({ kind: "branch", name: "jb/x" });
  expect(host.querySelector(".dpp-focus b")!.textContent).toBe("jb/x");
  expect(host.querySelector(".dpp-focus a")).toBeNull();
  unmount();
});

// A link to something on neither the queue nor a deploy: when it is on its way (an open change, found in the left
// column) the chip says so and reads as waiting; otherwise it is not on this target.
function mountWhere(coming: "coming" | "parked" | "reading" | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><FocusChip focus={{ kind: "pr", pr: 101 } as any} repository="acme/app" waiting={false} coming={coming} deploys={[]} live={null} onClear={() => {}} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("a change on its way, on no deploy yet, reads as on its way and waiting", () => {
  const { host, unmount } = mountWhere("coming");
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.querySelector(":scope > span:not(.dpp-focus-ref)")!.textContent).toBe("on its way");
  expect(chip.getAttribute("data-state")).toBe("waiting");
  unmount();
});

test("a parked change says so, never that it is moving", () => {
  const { host, unmount } = mountWhere("parked");
  expect(host.querySelector(".dpp-focus")!.querySelector(":scope > span:not(.dpp-focus-ref)")!.textContent).toBe("parked on its way");
  unmount();
});

test("while what is on its way is still being read, the chip says it is looking, never that the thing is not here", () => {
  const { host, unmount } = mountWhere("reading");
  expect(host.querySelector(".dpp-focus")!.querySelector(":scope > span:not(.dpp-focus-ref)")!.textContent).toBe("looking…");
  unmount();
});

test("a change neither coming nor deployed is not on this target", () => {
  const { host, unmount } = mountWhere(null);
  const chip = host.querySelector(".dpp-focus")!;
  expect(chip.querySelector(":scope > span:not(.dpp-focus-ref)")!.textContent).toBe("not on this target");
  expect(chip.getAttribute("data-state")).toBe("missing");
  unmount();
});

// The repository's production pause (DP17): who, why, the rollback and the task that lift it, the migrations that rule
// a revert out, and Lift only for whoever may lift it.
function mountPaused(p: any, canLift: boolean, onLift = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><Paused p={p} canLift={canLift} now={p.at + 3 * 60_000} onLift={onLift} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("a pause by hand says who and why, lifts by them or the Release Captain, and Lift is one press for its holder", () => {
  let lifted = 0;
  const p = { repository: "acme/app", by: "Ana", reason: "errors spiking", at: 1_000_000, lifts: "", rollback: null, until: null };
  const { host, unmount } = mountPaused(p, true, () => lifted++);
  const box = host.querySelector("[data-deploy-paused]")!;
  expect(box.textContent).toContain("Paused");
  expect(box.textContent).toContain("Ana");
  expect(box.textContent).toContain("3m");
  expect(box.querySelector("[data-deploy-pause-reason]")!.textContent).toBe("errors spiking");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toBe("Ana or the Release Captain");
  expect(box.querySelector("[data-deploy-pause-migrations]")).toBeNull();
  act(() => (box.querySelector("[data-deploy-lift]") as HTMLButtonElement).click());
  expect(lifted).toBe(1);
  unmount();
  const other = mountPaused(p, false);
  expect(other.host.querySelector("[data-deploy-lift]")).toBeNull();
  other.unmount();
});

test("a rollback's pause names its deploy and task, and a fix forward shows the migrations that rule a revert out", () => {
  const p = { repository: "acme/app", by: "Ana", reason: "Rollback dp-10: checkout broken", at: 1_000_000, lifts: "", rollback: "dp-10", until: { task: "ct-5", kind: "fix_forward", migrations: ["drizzle/0007_x.sql"], commits: 2 } };
  const { host, unmount } = mountPaused(p, false);
  const box = host.querySelector("[data-deploy-paused]")!;
  expect(box.textContent).toContain("dp-10");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toContain("ct-5");
  expect(box.querySelector("[data-deploy-pause-lifts]")!.textContent).toContain("fix forward green on main");
  const warn = box.querySelector("[data-deploy-pause-migrations]")!;
  expect(warn.getAttribute("role")).toBe("alert");
  expect(warn.textContent).toContain("No revert: fix forward");
  expect(warn.textContent).toContain("drizzle/0007_x.sql");
  unmount();
});

// The landing, against a pane like the page's: two columns that each scroll, rows placed off their column's middle.
// jsdom lays nothing out, so each element reports the box the test gives it, and a scroll is a recorded call.
describe("landing a link on the Deploys page", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  let scrolled: string[] = [];
  function pane() {
    document.body.innerHTML = `<div data-deploy-pane><div class="dpp-body">
      <div data-deploy-col="before" style="overflow-y: auto"><section><div class="chb-rows"></div></section></div>
      <div data-deploy-col="after" style="overflow-y: auto"><section><ul class="dpp-commits"></ul></section></div>
    </div></div>`;
    for (const col of document.querySelectorAll("[data-deploy-col]")) (col as any).getBoundingClientRect = () => ({ top: 0, height: 400 });
    scrolled = [];
  }
  function row(where: "before" | "after", id: string, focus = true) {
    const el = document.createElement(where === "before" ? "a" : "li");
    el.className = where === "before" ? "chb-row" : "dpp-commit";
    el.id = id;
    if (focus) el.setAttribute("data-focus", "");
    (el as any).getBoundingClientRect = () => ({ top: 900, height: 20 });
    (el as any).scrollIntoView = () => scrolled.push(id);
    document.querySelector(where === "before" ? ".chb-rows" : ".dpp-commits")!.appendChild(el);
    return el;
  }

  test("a row that arrives after the page opens is brought to the middle of its own column, and flashes", async () => {
    pane();
    const stop = landFocus();
    await tick();
    expect(scrolled).toEqual([]);
    const r = row("after", "c1");
    await tick();
    expect(scrolled).toEqual(["c1"]);
    expect(r.hasAttribute("data-flash")).toBe(true);
    stop();
  });

  test("each column centres its own row; one column takes only its most telling one", async () => {
    pane();
    row("before", "change");
    row("after", "commit");
    row("after", "commit2");
    const stop = landFocus();
    await tick();
    expect(scrolled.sort()).toEqual(["change", "commit"]);
    stop();
  });

  test("a row already in the middle is left where it is", async () => {
    pane();
    const r = row("after", "c1");
    (r as any).getBoundingClientRect = () => ({ top: 190, height: 20 });
    const stop = landFocus();
    await tick();
    expect(scrolled).toEqual([]);
    expect(r.hasAttribute("data-flash")).toBe(true);
    stop();
  });

  test("the viewer's own key ends it: a row arriving afterwards is not scrolled to", async () => {
    pane();
    const stop = landFocus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    row("after", "late");
    await tick();
    expect(scrolled).toEqual([]);
    stop();
  });

  test("the flash ends when the row's own animation does, not a child's", async () => {
    pane();
    const r = row("after", "c1");
    const child = document.createElement("span");
    r.appendChild(child);
    const stop = landFocus();
    await tick();
    child.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(r.hasAttribute("data-flash")).toBe(true);
    r.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(r.hasAttribute("data-flash")).toBe(false);
    stop();
  });
});
