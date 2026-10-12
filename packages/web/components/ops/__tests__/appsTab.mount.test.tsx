// The Apps board, mounted: its rows are names and states, the manifest's own
// words and full errors stay behind the row that names them, and a grant is
// only ever made by the person's own click (twice for a high-risk action).
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/apps" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { AppBoard } = await import("../AppsTab");
const { app, CALLS, MANIFEST, NOW, SOURCE, UNREACHABLE } = await import("../__fixtures__/appBoard");
type BoardProps = Parameters<typeof AppBoard>[0];

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function mount(over: Partial<BoardProps> = {}) {
  const grants: Array<[string, boolean]> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AppBoard source={SOURCE} app={app()} manifest={MANIFEST} calls={CALLS} now={NOW} nameOf={() => "Ada"} onGrant={(a, on) => grants.push([a, on])} {...over} />);
  });
  const panel = (title: string) => container.querySelector(`section[aria-label="${title}"]`) as HTMLElement;
  const row = (within: HTMLElement, title: string) => [...within.querySelectorAll<HTMLElement>(".ops-row")].find((r) => r.querySelector(".ops-row-title")?.textContent === title)!;
  const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
  const done = () => { root.unmount(); container.remove(); };
  return { container, grants, panel, row, click, done };
}

const text = (el: Element | null | undefined) => el?.textContent ?? "";

test("the head says how the connection is, in a word and four numbers", async () => {
  const { container, done } = await mount();
  const head = container.querySelector(".ops-app-head")!;
  expect(head.getAttribute("data-tone")).toBe("ok");
  expect(text(head.querySelector(".ops-app-verdict"))).toBe("Healthy");
  const stats = [...head.querySelectorAll(".ops-stat")].map((s) => [text(s.querySelector(".ops-stat-value")), text(s.querySelector(".ops-stat-label"))]);
  expect(stats.slice(0, 3)).toEqual([["2/3", "actions granted"], ["2/2", "watches ok"], ["0", "failing now"]]);
  expect(text(head.querySelector(".ops-stat:last-child .ops-stat-label"))).toBe("last failure 2d ago");
  expect(head.querySelectorAll(".ops-day")).toHaveLength(7);
  expect(head.querySelectorAll('.ops-day[data-tone="bad"]').length).toBeGreaterThan(0);
  done();
});

test("a failing watch turns the head red and opens its full error on demand", async () => {
  const failing = app({ watch_state: [{ key: "job:jobs.failed", polled_at: NOW - 2 * 60_000, last_error: "no answer in 15s" }, { key: "check:invariants.list", polled_at: NOW - 60_000 }] });
  const { container, panel, row, click, done } = await mount({ app: failing });
  const head = container.querySelector(".ops-app-head")!;
  expect(head.getAttribute("data-tone")).toBe("bad");
  expect(text(head.querySelector(".ops-app-verdict"))).toBe("Failing");
  const watch = row(panel("Watches"), "Recent job failures");
  expect(watch.getAttribute("data-tone")).toBe("bad");
  expect(text(watch.querySelector(".ops-tone-ink"))).toBe("Timed out");
  expect(watch.querySelector(".ops-fulltext")).toBeNull();
  await click(watch.querySelector(".ops-row-main"));
  expect(text(watch.querySelector(".ops-fulltext"))).toBe("no answer in 15s");
  done();
});

test("no manifest description, route or raw error is on the board until its row is opened", async () => {
  const { container, panel, row, click, done } = await mount();
  const closed = text(container);
  for (const hidden of ["Enqueue a job again", "/codecast/jobs", "jobs.rerun", "no answer in 15s", "Connection reset by peer", "a person grants it"]) expect(closed).not.toContain(hidden);
  expect(container.querySelector(".ops-app p")).toBeNull();

  const rerun = row(panel("Actions"), "Rerun a job");
  await click(rerun.querySelector(".ops-row-main"));
  expect(rerun.querySelector(".ops-row-main")!.getAttribute("aria-expanded")).toBe("true");
  expect(text(rerun.querySelector(".ops-row-detail"))).toContain("Enqueue a job again");
  expect(text(rerun.querySelector(".ops-row-detail"))).toContain("POST /codecast/jobs/rerun");
  expect([...rerun.querySelectorAll('.ops-param[data-required="true"]')].map(text)).toEqual(["jobName", "jobId"]);
  await click(rerun.querySelector(".ops-row-main"));
  expect(rerun.querySelector(".ops-row-detail")).toBeNull();
  done();
});

test("calls fold into one row per thing and outcome; what has passed is quiet, and the full errors open under it", async () => {
  const { panel, row, click, done } = await mount();
  const calls = panel("Calls");
  const rows = [...calls.querySelectorAll<HTMLElement>(".ops-row")];
  expect(rows.map((r) => [text(r.querySelector(".ops-row-title")), text(r.querySelector(".ops-cols .ops-tone-ink")), r.getAttribute("data-tone")])).toEqual([
    ["Open an Acme view", "OK", "ok"],
    ["Open an Acme view", "Granted since", "off"],
    ["Error counts", "OK", "ok"],
    ["Recent job failures", "Recovered", "off"],
  ]);
  const failures = row(calls, "Recent job failures");
  expect(text(failures.querySelector(".ops-tag"))).toBe("Timed out +2");
  expect(text(failures.querySelector(".ops-cols > :first-child"))).toBe("15");
  await click(failures.querySelector(".ops-row-main"));
  expect([...failures.querySelectorAll(".ops-reason-head")].map(text)).toEqual(["Timed out13", "Unreachable1", "HTTP 5021"]);
  expect([...failures.querySelectorAll(".ops-fulltext")].map(text)).toContain(UNREACHABLE);
  expect(failures.querySelectorAll(".ops-occ tbody tr")).toHaveLength(8);
  expect(text(failures.querySelector(".ops-row-detail"))).toContain("+7 earlier");
  done();
});

test("the call filter narrows the list and counts every outcome", async () => {
  const { panel, click, done } = await mount();
  const calls = panel("Calls");
  const filter = (label: string) => [...calls.querySelectorAll<HTMLElement>(".ops-seg button")].find((b) => text(b).startsWith(label))!;
  expect([...calls.querySelectorAll(".ops-seg button")].map(text)).toEqual(["All 18", "Failed 15", "Denied 1", "OK 2"]);
  await click(filter("Failed"));
  expect(filter("Failed").getAttribute("aria-pressed")).toBe("true");
  expect([...calls.querySelectorAll(".ops-row-title")].map(text)).toEqual(["Recent job failures"]);
  done();
});

test("a low-risk action is granted and revoked by one click on its switch", async () => {
  const { panel, row, click, grants, done } = await mount({ app: app({ grants: [{ action: "jobs.cancel", granted_by: "u1", granted_at: NOW - 1000, via: "session" }] }) });
  const actions = panel("Actions");
  const cancel = row(actions, "Cancel a job");
  expect(cancel.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  expect(text(cancel.querySelector(".ops-grant-state"))).toBe("Granted");
  await click(cancel.querySelector('[role="switch"]'));
  const view = row(actions, "Open an Acme view");
  expect(text(view.querySelector(".ops-grant-state"))).toBe("Off");
  await click(view.querySelector('[role="switch"]'));
  expect(grants).toEqual([["jobs.cancel", false], ["views.token", true]]);
  // Opening a row never grants.
  await click(view.querySelector(".ops-row-main"));
  expect(grants).toHaveLength(2);
  done();
});

test("a high-risk action shows its risk and is granted only after a second, named click", async () => {
  const { panel, row, click, grants, done } = await mount();
  const rerun = row(panel("Actions"), "Rerun a job");
  expect(text(rerun.querySelector('.ops-tag[data-tone="bad"]'))).toBe("High risk");
  const toggle = rerun.querySelector('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(grants).toEqual([]);
  const buttons = () => [...rerun.querySelectorAll<HTMLElement>(".ops-confirm button")];
  expect(buttons().map(text)).toEqual(["Grant high risk", "Cancel"]);
  await click(buttons()[1]);
  expect(grants).toEqual([]);
  expect(rerun.querySelector('[role="switch"]')).not.toBeNull();
  await click(rerun.querySelector('[role="switch"]'));
  await click(buttons()[0]);
  expect(grants).toEqual([["jobs.rerun", true]]);
  done();
});

test("views say when agents cannot open them, and a vendor source shows only its actions and calls", async () => {
  const locked = await mount({ app: app({ grants: [] }) });
  expect(text(locked.panel("Views").querySelector(".ops-card-head .ops-tag"))).toBe("Not granted");
  locked.done();

  const sentry = await mount({ source: { ...SOURCE, provider: "sentry" }, manifest: null, calls: [], app: app({ manifest_json: null, grants: [], watch_state: [] }) });
  expect([...sentry.container.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Actions", "Calls"]);
  expect([...sentry.panel("Actions").querySelectorAll(".ops-row-title")].map(text)).toEqual(["Resolve or reopen an issue in Sentry", "Ignore an issue in Sentry"]);
  expect(text(sentry.panel("Calls").querySelector(".ops-panel-empty"))).toBe("No calls yet");
  sentry.done();
});
