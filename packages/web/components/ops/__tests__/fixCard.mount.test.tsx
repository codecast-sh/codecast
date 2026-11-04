// The Fix card, mounted: it reads a closed fix against the occurrences since
// (held, or did not hold and by how much), names how the task closed, and
// flags a problem task filed for another title.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/issues/eg-71" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  requestAnimationFrame: (f: any) => setTimeout(f, 0),
  cancelAnimationFrame: clearTimeout,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { FixCard } = await import("../issueCards");
const { fixPlan, fixStage } = await import("../issuesModel");
type Props = Parameters<typeof FixCard>[0];

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 3, 12, 30);

const group = (over: Partial<Props["group"]> = {}): Props["group"] => ({
  _id: "g1", workspace: "team:t", source_id: "s1", short_id: "eg-71", kind: "error", fingerprint: "fp", title: "TypeError: x is undefined",
  status: "open", first_seen: NOW - 30 * D, last_seen: NOW - 5 * H, count: 40, buckets: [{ hour: Math.floor((NOW - 5 * H) / H) * H, count: 12 }], updated_at: NOW,
  signal_task_id: "t1", ...over,
});

async function mount(g: Props["group"], task: NonNullable<Props["task"]>, events: Props["events"] = []) {
  const stage = fixStage(g, task);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><FixCard group={g} stage={stage} task={task} sessions={[]} plan={fixPlan(g, stage, [])} now={NOW} onStart={() => {}} events={events} /></MemoryRouter>);
  });
  const text = (sel: string) => container.querySelector(sel)?.textContent ?? "";
  const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  return { container, text, buttons, stage, done: () => { root.unmount(); container.remove(); } };
}

test("a landed fix that kept firing says it did not hold, with the count since the commit, and leads with a follow-up", async () => {
  const m = await mount(group(), { _id: "t1", short_id: "ct-1", title: "TypeError: x is undefined in cart", status: "done", closed_at: NOW - 2 * D, landed: { sha: "9f2c1a0aa1", at: NOW - 2 * D, url: "https://github.com/o/r/commit/9f2c1a0aa1", repository: "o/r" } });
  expect(m.stage).toBe("recurring");
  expect(m.container.querySelector(".iss-fixcard")?.getAttribute("data-stage")).toBe("recurring");
  expect(m.text(".iss-verdict")).toContain("Did not hold");
  expect(m.text(".iss-verdict")).toContain("12 events since 9f2c1a0 landed");
  expect(m.text(".iss-chain")).toContain("9f2c1a0aa");
  expect(m.buttons().some((b) => b.startsWith("Start follow-up fix"))).toBe(true);
  expect(m.buttons().some((b) => b.startsWith("Reopen ct-1"))).toBe(true);
  m.done();
});

test("a fix that held names the deploy after it and leads with resolve; a close with no change says so", async () => {
  const quiet = group({ last_seen: NOW - 4 * D, buckets: [] });
  const deploy = { _id: "d", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release: "v2.4.0" }, created_at: NOW - 3 * D };
  const held = await mount(quiet, { _id: "t1", short_id: "ct-1", title: "TypeError: x is undefined", status: "done", closed_at: NOW - 3.5 * D, landed: { sha: "abcdef1234", at: NOW - 3.5 * D } }, [deploy as any]);
  expect(held.stage).toBe("shipped");
  expect(held.text(".iss-verdict")).toContain("Held");
  expect(held.text(".iss-verdict")).toContain("since abcdef1 deployed");
  expect(held.text(".iss-chain")).toContain("v2.4.0");
  expect(held.buttons().some((b) => b.startsWith("Resolve"))).toBe(true);
  held.done();

  const noChange = await mount(quiet, { _id: "t1", short_id: "ct-1", title: "TypeError: x is undefined", status: "done", closed_at: NOW - 3.5 * D });
  expect(noChange.stage).toBe("closed");
  expect(noChange.text(".iss-chain")).toContain("no change landed");
  noChange.done();
});

test("a task filed for another title is flagged and not offered as the fix to refile", async () => {
  const m = await mount(
    group({ title: 'Rage click on button "What if the introduction leads nowhere?" on /pricing' }),
    { _id: "t1", short_id: "ct-64667", title: 'Rage click on button "What counts as a transaction?" on /pricing', status: "done", closed_at: NOW - 6 * D, cause: { dissolved: { at: NOW - 6 * D } } },
  );
  expect(m.stage).toBe("dropped");
  expect(m.text(".iss-mismatch")).toContain("other issue's task");
  expect(m.buttons().some((b) => b.startsWith("Reopen"))).toBe(false);
  expect(m.buttons().some((b) => b.startsWith("Start fix"))).toBe(true);
  m.done();
});

test("a bulk resolve on an open problem is not a fix: no verdict, no follow-up, the task's own stage", async () => {
  const m = await mount(
    group({ resolved_at: NOW - 11 * D, regressed_at: NOW - 5 * D, last_seen: NOW - 5 * H, resolved_via: "person", resolved_by: "u1" }),
    { _id: "t1", short_id: "ct-74150", title: "TypeError: x is undefined", status: "open" },
  );
  expect(m.stage).toBe("filed");
  expect(m.container.querySelector(".iss-verdict")).toBeNull();
  expect(m.text(".iss-chain")).not.toContain("by hand");
  expect(m.buttons().some((b) => b.startsWith("Start follow-up fix"))).toBe(false);
  // The press names the task it works on.
  expect(m.buttons().some((b) => b.startsWith("Start fix on ct-74150"))).toBe(true);
  m.done();
});

test("a dissolved problem's note is one press away, not half a line", async () => {
  const note = "Dropped: the judge was wrong. Dissolved before anyone started on it because the rule misread a retry as a failure.";
  const m = await mount(group(), { _id: "t1", short_id: "ct-61538", title: "TypeError: x is undefined", status: "done", closed_at: NOW - 3 * D, cause: { dissolved: { at: NOW - 3 * D, note } } });
  expect(m.stage).toBe("dropped");
  expect(m.container.textContent).not.toContain(note);
  const why = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Why dropped")!;
  await act(async () => why.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  expect(m.text(".iss-task-notefull")).toBe(note);
  m.done();
});

test("a dropped problem leads with one press that reopens its task and starts the fix, by name; reopening alone is the second", async () => {
  const m = await mount(group(), { _id: "t1", short_id: "ct-57171", title: "TypeError: x is undefined", status: "dropped", closed_at: NOW - 3 * D });
  expect(m.stage).toBe("dropped");
  const lead = m.container.querySelector<HTMLElement>('.ops-btn[data-tone="primary"]');
  expect(lead?.textContent).toContain("Reopen ct-57171 and fix");
  expect(m.buttons().some((b) => b.startsWith("Reopen only"))).toBe(true);
  m.done();
});

test("a resolved, quiet issue offers a fix without leading with it", async () => {
  const m = await mount(group({ status: "resolved", resolved_at: NOW - 2 * H, resolved_via: "recovered", last_seen: NOW - 3 * H }), { _id: "t1", short_id: "ct-9", title: "TypeError: x is undefined", status: "open" });
  expect(m.container.querySelector('.ops-btn[data-tone="primary"]')).toBeNull();
  expect(m.buttons().some((b) => b.startsWith("Start fix on ct-9"))).toBe(true);
  m.done();
});

test("a commit on a task filed for another title and still in review is neither a close nor a fix", async () => {
  const g = group({ kind: "check", title: "OpenRouter Credit Runway", meta: { ok: false }, resolved_at: NOW - 5 * D, last_seen: NOW - H });
  const m = await mount(g, { _id: "t1", short_id: "ct-58659", title: "Broker candidate_score_ready trigger fires while a circuit is open", status: "in_review", landed: { sha: "9d6ae645d1", at: NOW - 8 * D, url: "https://github.com/o/r/commit/9d6ae645d1", repository: "o/r" } });
  const chain = m.text(".iss-chain");
  expect(chain).not.toContain("Closed");
  expect(chain).toContain("Its commit");
  expect(chain).toContain("other title");
  expect(m.container.querySelector(".iss-verdict")).toBeNull();
  m.done();
});

