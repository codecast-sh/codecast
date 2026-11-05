// The Apps board, mounted: its rows are names and states, the manifest's own
// words and full errors stay behind the row that names them, and a grant is
// only ever made by the person's own click (through the shared review for a high-risk action).
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
  // The shared review (components/consequential) is a dialog: it needs the rest of a browser's DOM.
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  DocumentFragment: dom.window.DocumentFragment,
  KeyboardEvent: dom.window.KeyboardEvent,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  NodeFilter: dom.window.NodeFilter,
  requestAnimationFrame: (f: any) => setTimeout(f, 0),
  cancelAnimationFrame: clearTimeout,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { AppBoard, NoAppActions } = await import("../AppsTab");
const { source, CALLS, MANIFEST, NOW, UNREACHABLE } = await import("../__fixtures__/appBoard");
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
    root.render(<MemoryRouter><AppBoard source={source()} manifest={MANIFEST} calls={CALLS} now={NOW} nameOf={() => "Ada"} onGrant={(a, on) => grants.push([a, on])} {...over} /></MemoryRouter>);
  });
  const panel = (title: string) => container.querySelector(`section[aria-label="${title}"]`) as HTMLElement;
  const row = (within: HTMLElement, title: string) => [...within.querySelectorAll<HTMLElement>(".ops-row")].find((r) => r.querySelector(".ops-row-title")?.textContent === title)!;
  const chip = (within: HTMLElement, label: string) => [...within.querySelectorAll<HTMLElement>(".ops-chip")].find((c) => c.firstChild?.textContent === label)!;
  const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
  const done = () => { root.unmount(); container.remove(); };
  return { container, grants, panel, row, chip, click, done };
}

const text = (el: Element | null | undefined) => el?.textContent ?? "";
/** A call or watch row as [state, title, tone]. */
const rowState = (r: Element) => [text(r.querySelector(".ops-state, .ops-outcome")), text(r.querySelector(".ops-row-title")), r.getAttribute("data-tone")];

test("the head says how the connection is: a verdict, two numbers, and when it last answered and last failed", async () => {
  const { container, done } = await mount();
  const head = container.querySelector(".ops-app-head")!;
  expect(head.getAttribute("data-tone")).toBe("ok");
  expect(text(head.querySelector(".ops-app-verdict"))).toBe("Healthy");
  const stats = [...head.querySelectorAll(".ops-stat")].map((s) => [text(s.querySelector(".ops-stat-value")), text(s.querySelector(".ops-stat-label"))]);
  // Two counts that never overlap: the watches in the source's one sentence, and the calls failing outside them.
  expect(stats).toEqual([["2/2", "watches ok"], ["0", "calls failing"]]);
  expect([...head.querySelectorAll(".ops-app-meta > span")].map(text)).toEqual(["answered 1m ago", "last failure 2d ago"]);
  done();
});

test("a failing watch turns the head red and opens its full error on demand", async () => {
  const failing = source({ watch_state: [{ key: "job:jobs.failed", polled_at: NOW - 2 * 60_000, last_error: "no answer in 15s" }, { key: "check:invariants.list", polled_at: NOW - 60_000 }] });
  const { container, panel, row, click, done } = await mount({ source: failing });
  const head = container.querySelector(".ops-app-head")!;
  expect(head.getAttribute("data-tone")).toBe("bad");
  expect(text(head.querySelector(".ops-app-verdict"))).toBe("Failing");
  expect(text(head.querySelector(".ops-stat .ops-stat-value"))).toBe("1/2");
  expect(text(head.querySelector(".ops-stat .ops-stat-label"))).toBe("watches ok · 1 failing");
  const watch = row(panel("Checks"), "Recent job failures");
  // The Recent calls shape: a Failing pill in the state column, why it fails under the name.
  expect(rowState(watch)).toEqual(["Failing", "Recent job failures", "bad"]);
  expect(text(watch.querySelector("[data-ops-watch-reason]"))).toBe("Timed out15×");
  expect(rowState(row(panel("Checks"), "Invariants"))).toEqual(["OK", "Invariants", "ok"]);
  expect(watch.querySelector(".ops-fulltext")).toBeNull();
  await click(watch.querySelector(".ops-row-main"));
  expect(text(watch.querySelector(".ops-fulltext"))).toBe("no answer in 15s");
  done();
});

test("no manifest description, route or raw error is on the board until its row is opened", async () => {
  const { container, panel, row, chip, click, done } = await mount();
  const closed = text(container);
  for (const hidden of ["Enqueue a job again", "/codecast/jobs", "jobs.rerun", "no answer in 15s", "Connection reset by peer", "a person grants it"]) expect(closed).not.toContain(hidden);
  expect(container.querySelector(".ops-app p")).toBeNull();

  const rerun = row(panel("Agents can"), "Rerun a job");
  await click(rerun.querySelector(".ops-row-main"));
  expect(rerun.querySelector(".ops-row-main")!.getAttribute("aria-expanded")).toBe("true");
  expect(text(rerun.querySelector(".ops-row-detail"))).toContain("Enqueue a job again");
  expect(text(rerun.querySelector(".ops-row-detail"))).toContain("POST /codecast/jobs/rerun");
  expect([...rerun.querySelectorAll('.ops-param[data-required="true"]')].map(text)).toEqual(["jobName", "jobId"]);
  await click(rerun.querySelector(".ops-row-main"));
  expect(rerun.querySelector(".ops-row-detail")).toBeNull();

  // What agents can read is one row a kind with its count. Opening it lists every name as a chip,
  // and picking a chip opens the manifest's words; picking another replaces them.
  const readers = panel("Agents can read");
  expect([...readers.querySelectorAll(".ops-row-main")].map(text)).toEqual(["Data3", "Screens1"]);
  expect(readers.querySelector(".ops-chip")).toBeNull();
  await click(readers.querySelector(".ops-row-main"));
  expect([...readers.querySelectorAll(".ops-chip")].map(text)).toEqual(["Recent job failures", "Invariants", "Error counts"]);
  await click(chip(readers, "Error counts"));
  expect(chip(readers, "Error counts").getAttribute("aria-expanded")).toBe("true");
  expect(text(readers.querySelector(".ops-chip-detail"))).toContain("GET /codecast/errors/stats");
  await click(chip(readers, "Invariants"));
  expect(readers.querySelectorAll(".ops-chip-detail")).toHaveLength(1);
  expect(text(readers.querySelector(".ops-chip-detail"))).toContain("Watchedevery 1h");
  done();
});

test("calls are one row per reader or action, standing at its newest outcome; the full errors open under the row", async () => {
  const { panel, row, click, done } = await mount();
  const calls = panel("Recent calls");
  expect(calls.querySelector(".ops-sub")).toBeNull();
  expect([...calls.querySelectorAll(".ops-row")].map(rowState)).toEqual([
    ["OK", "Open an Acme view", "ok"],
    ["OK", "Error counts", "ok"],
    ["Recovered", "Recent job failures", "off"],
  ]);
  // Newest first, each with when it last happened.
  expect([...calls.querySelectorAll(".ops-watch-age")].map(text)).toEqual(["1m ago", "10m ago", "2d ago"]);
  // What went wrong before is a count on the row; the errors themselves are behind it.
  expect(text(row(calls, "Recent job failures").querySelector(".ops-call-what + .ops-row-when"))).toBe("15 failed");
  expect(calls.querySelectorAll(".ops-row-main .ops-tag")).toHaveLength(0);
  expect([...calls.querySelectorAll(".ops-row-actor")].map(text)).toEqual(["CLI", "CLI", "Watch"]);
  const failures = row(calls, "Recent job failures");
  await click(failures.querySelector(".ops-row-main"));
  expect([...failures.querySelectorAll(".ops-reason-head")].map(text)).toEqual(["Timed out13", "Unreachable1", "HTTP 5021"]);
  expect([...failures.querySelectorAll(".ops-fulltext")].map(text)).toContain(UNREACHABLE);
  expect(failures.querySelectorAll(".ops-occ tbody tr")).toHaveLength(8);
  expect(text(failures.querySelector(".ops-row-detail"))).toContain("+7 earlier");
  done();
});

test("a failure nothing has answered since leads the calls under Failing now, in red", async () => {
  const fresh = { ...CALLS[3], _id: "fresh", name: "errors.stats", error: "answered 500", http_status: 500, created_at: NOW - 30_000 };
  const { container, panel, done } = await mount({ calls: [fresh, ...CALLS] });
  const calls = panel("Recent calls");
  expect([...calls.querySelectorAll(".ops-sub")].map(text)).toEqual(["Failing now1", "Earlier2"]);
  const first = calls.querySelector<HTMLElement>(".ops-sub + .ops-row")!;
  expect(rowState(first)).toEqual(["Failing", "Error counts", "bad"]);
  // Each reason carries its own count, the way the head counts them, under the name.
  expect([...first.querySelectorAll(".ops-call-reasons .ops-tag")].map(text)).toEqual(["HTTP 5001×"]);
  expect(first.querySelector(".ops-state")!.getAttribute("data-live")).toBe("true");
  expect(text(container.querySelector(".ops-app-verdict"))).toBe("Degraded");
  expect([...container.querySelectorAll(".ops-stat")].map((s) => text(s))).toEqual(["2/2watches ok", "1call failing"]);
  done();
});

test("a low-risk action is granted and revoked by one click on its switch", async () => {
  const { panel, row, click, grants, done } = await mount({ source: source({ grants: [{ action: "jobs.cancel", granted_by: "u1", granted_at: NOW - 1000, via: "session" }] }) });
  const actions = panel("Agents can");
  const cancel = row(actions, "Cancel a job");
  expect(cancel.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  expect(cancel.querySelector('[role="switch"]')!.getAttribute("aria-label")).toBe("Revoke Cancel a job");
  const view = row(actions, "Open an Acme view");
  expect(view.querySelector('[role="switch"]')!.getAttribute("aria-label")).toBe("Grant Open an Acme view");
  await click(cancel.querySelector('[role="switch"]'));
  await click(view.querySelector('[role="switch"]'));
  expect(grants).toEqual([["jobs.cancel", false], ["views.token", true]]);
  // Who granted it and when is behind the row.
  await click(cancel.querySelector(".ops-row-main"));
  expect(text(cancel.querySelector(".ops-row-detail"))).toContain("· Ada");
  // Opening a row never grants.
  await click(view.querySelector(".ops-row-main"));
  expect(grants).toHaveLength(2);
  done();
});

test("a high-risk action shows its risk and is granted only through the shared review", async () => {
  const { panel, row, click, grants, done } = await mount();
  const rerun = row(panel("Agents can"), "Rerun a job");
  // Risk is the panel's own structure: a band the action sits under.
  expect([...panel("Agents can").querySelectorAll(".ops-sub")].map(text)).toEqual(["High risk1", "Low risk2"]);
  expect(panel("Agents can").querySelector(".ops-sub + .ops-row")).toBe(rerun);
  const toggle = rerun.querySelector('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(grants).toEqual([]);
  // The review (components/consequential) names what is handed over, to whom, and how to stop it.
  const review = () => document.querySelector<HTMLElement>('[data-switch-review="Rerun a job"]');
  expect(review()).not.toBeNull();
  expect(text(review()!.querySelector("[data-switch-alert]"))).toContain("High risk");
  // Focus lands on the way out, so a stray Enter never grants.
  expect(document.activeElement).toBe(review()!.querySelector("[data-switch-cancel]"));
  await click(review()!.querySelector("[data-switch-cancel]"));
  expect(grants).toEqual([]);
  await click(rerun.querySelector('[role="switch"]'));
  await click(review()!.querySelector("[data-switch-confirm]"));
  expect(grants).toEqual([["jobs.rerun", true]]);
  done();
});

test("a watch can be run now and paused from its row", async () => {
  const runs: string[] = [];
  const pauses: Array<[string, boolean]> = [];
  const { panel, done } = await mount({ onWatch: { run: (k) => runs.push(k), pause: (k, p) => pauses.push([k, p]) } });
  const watches = panel("Checks");
  const run = watches.querySelector<HTMLElement>('button[title="Run now"]')!;
  const pause = watches.querySelector<HTMLElement>('button[title="Pause"]')!;
  await act(async () => { run.click(); });
  await act(async () => { pause.click(); });
  expect(runs.length).toBe(1);
  expect(pauses).toEqual([[runs[0], true]]);
  done();
});

test("views say when agents cannot open them, and a vendor source shows only its actions and calls", async () => {
  // The refusal is the newest call of the action: nobody has granted it since.
  const locked = await mount({ source: source({ grants: [] }), calls: CALLS.slice(1) });
  expect(text(locked.panel("Agents can read").querySelectorAll(".ops-row")[1].querySelector(".ops-tag"))).toBe("Not granted");
  // An agent was refused an action that is still off: the action's own row says it was asked for.
  const asked = locked.row(locked.panel("Agents can"), "Open an Acme view");
  expect(text(asked.querySelector('.ops-tag[data-tone="warn"]'))).toBe("Asked 10m ago");
  expect(asked.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  locked.done();

  const sentry = await mount({ source: source({ provider: "sentry", grants: [], watch_state: [] }), manifest: null, calls: [] });
  expect([...sentry.container.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Agents can", "Recent calls"]);
  expect([...sentry.panel("Agents can").querySelectorAll(".ops-row-title")].map(text)).toEqual(["Resolve or reopen an issue in Sentry", "Ignore an issue in Sentry"]);
  expect(text(sentry.panel("Recent calls").querySelector(".ops-panel-empty"))).toBe("No calls yet");
  sentry.done();
});

test("a reader is read and a granted action run from its row, as the person, with the app's answer under it", async () => {
  const runs: Array<[string, string, string, string | undefined]> = [];
  const runner = {
    call: async (kind: "read" | "do", name: string, args: string, o: { idempotencyKey?: string }) => { runs.push([kind, name, args, o.idempotencyKey]); return { ok: true, status: 200, text: '{"n":3}', ms: 12 }; },
    refresh: async () => ({ ok: true, readers: 3, actions: 3, watches: 2 }),
  };
  const { panel, row, chip, click, done } = await mount({ runner });
  const readers = panel("Agents can read");
  await click(readers.querySelector(".ops-row-main"));
  await click(chip(readers, "Recent job failures"));
  const form = readers.querySelector<HTMLElement>('[data-ops-run-form="jobs.failed"]')!;
  const limit = form.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(limit, "5");
    limit.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await click(form.querySelector('[data-ops-run="jobs.failed"]'));
  expect(runs).toEqual([["read", "jobs.failed", '{"limit":5}', undefined]]);
  expect(text(form.querySelector(".ops-run-status"))).toContain("OK");
  expect(text(form.querySelector(".ops-run-out"))).toBe('{\n  "n": 3\n}');

  // An action that is not granted cannot be run; granted, it runs with its own idempotency key when it repeats.
  const cancel = row(panel("Agents can"), "Cancel a job");
  await click(cancel.querySelector(".ops-row-main"));
  const btn = cancel.querySelector<HTMLButtonElement>('[data-ops-run="jobs.cancel"]');
  expect(btn).not.toBeNull();
  done();
});

test("an app with no manifest read says what to serve and reads it again on a press", async () => {
  let refreshed = 0;
  const runner = { call: async () => ({ ok: true }), refresh: async () => { refreshed++; return { ok: false, error: "manifest: answered 404" }; } };
  const { container, click, done } = await mount({ manifest: null, runner, source: source({ last_error: "manifest: could not reach the app" }) });
  const box = container.querySelector<HTMLElement>("[data-ops-no-manifest]")!;
  expect(text(box)).toContain("GET /codecast/manifest");
  expect(text(box)).toContain("manifest: could not reach the app");
  await click(box.querySelector("[data-ops-manifest-check]"));
  expect(refreshed).toBe(1);
  expect(text(box)).toContain("manifest: answered 404");
  done();
});

test("the head names the one shared reading, and metric watches reading through the app count and list with the app's own", async () => {
  const metric = (o: Record<string, unknown>) => ({ _id: "w1", short_id: "mw-1", name: "Dollars per intro", status: "active", state: "ok", last_value: 382, last_at: NOW - 60_000, unit: "$", query_kind: "reader", query: "metrics.read {\"key\":\"dpi\"}", ...o }) as any;
  const health = { tone: "warn" as const, label: "Reader failing", reason: "metrics.read is returning HTTP 502 (94×), so the Dollars per intro watch has no answer" };
  const { container, panel, done } = await mount({ health, metricWatches: [metric({ last_error: "no answer in 15s" }), metric({ _id: "w2", short_id: "mw-2", name: "Signups" })] });
  const head = container.querySelector(".ops-app-head")!;
  expect(head.getAttribute("data-tone")).toBe("warn");
  expect(text(head.querySelector(".ops-app-verdict"))).toBe("Reader failing");
  expect(text(head.querySelector("[data-ops-health-reason]"))).toBe(health.reason);
  const stats = [...head.querySelectorAll(".ops-stat")].map((s) => [text(s.querySelector(".ops-stat-value")), text(s.querySelector(".ops-stat-label"))]);
  expect(stats).toEqual([["1/4", "watches ok · 1 failing · 1 no line"], ["0", "calls failing"]]);
  const rows = [...panel("Watches").querySelectorAll("[data-ops-metric-watch]")];
  expect(rows.map((r) => [text(r.querySelector(".ops-state")), text(r.querySelector(".ops-row-title"))])).toEqual([["Timed out", "Dollars per intro"], ["No line", "Signups"]]);
  expect(rows[0].querySelector("a")!.getAttribute("href")).toContain("mw-1");
  done();
});

test("every call row counts its calls, the header counts what the filters cover, and an empty caller is not offered", async () => {
  const { panel, click, done } = await mount();
  const calls = panel("Recent calls");
  expect([...calls.querySelectorAll(".ops-row-n")].every((n) => /^\d+×$/.test(text(n)))).toBe(true);
  const actors = [...calls.querySelectorAll('[aria-label="Who called"] button')].map(text);
  expect(actors).not.toContain("Agent");
  const total = text(calls.querySelector(".ops-panel-title .ops-num"));
  await click([...calls.querySelectorAll<HTMLElement>('[aria-label="Outcome"] button')].find((b) => text(b) === "Failed"));
  expect(text(calls.querySelector(".ops-panel-title .ops-num"))).toMatch(new RegExp(`^\\d+ of ${total}$`));
  done();
});

test("a failing reader reads as structure (reader, how it fails, the watches it blinds) and every metric watch row reads now and pauses in place", async () => {
  const metric = (o: Record<string, unknown>) => ({ _id: "w1", short_id: "mw-1", name: "Dollars per intro", status: "active", state: "ok", last_value: 382, last_at: NOW - 60_000, unit: "$", query_kind: "reader", query: "metrics.read {\"key\":\"dpi\"}", ...o }) as any;
  const fails = Array.from({ length: 3 }, (_, i) => ({ _id: `m${i}`, source_id: "s1", user_id: "u", kind: "read", name: "metrics.read", args_hash: "", status: "error", error: "metric metrics.read: no answer in 15s", ms: 15000, bytes: 0, created_at: NOW - (i + 1) * 60_000 }) as any);
  const health = { tone: "warn" as const, label: "Reader failing", reason: "metrics.read times out, 3× in the last 3m, so the Dollars per intro watch has no answer", starves: { reader: { kind: "read" as const, name: "metrics.read", reason: "Timed out", count: 3 }, watchIds: ["w1"] } };
  const ran: string[] = [];
  const paused: Array<[string, boolean]> = [];
  const onMetric = { run: (id: string) => ran.push(id), pause: (id: string, p: boolean) => paused.push([id, p]) };
  const { container, panel, click, done } = await mount({ health, calls: [...fails, ...CALLS], onMetric, metricWatches: [metric({ last_error: "no answer in 15s", missed: 1 }), metric({ _id: "w2", short_id: "mw-2", name: "Signups" })] });
  const cause = container.querySelector<HTMLElement>("[data-ops-cause]")!;
  expect(cause.getAttribute("data-ops-cause")).toBe("metrics.read");
  expect([...cause.querySelectorAll(".ops-tag")].map(text)).toEqual(["Timed out3×"]);
  expect([...cause.querySelectorAll(".ops-app-cause-watch")].map(text)).toEqual(["Dollars per intro"]);
  const rows = [...panel("Watches").querySelectorAll<HTMLElement>("[data-ops-metric-watch]")];
  // Its last read failed: the value it shows is older than that try, so it is dimmed.
  expect(rows[0].querySelector("[data-stale]")).not.toBeNull();
  expect(rows[1].querySelector("[data-stale]")).toBeNull();
  await click(rows[0].querySelector("[data-ops-metric-run]"));
  await click(rows[1].querySelector("[data-ops-metric-pause]"));
  expect(ran).toEqual(["w1"]);
  expect(paused).toEqual([["w2", true]]);
  done();
});

test("a source with no actions, picked from the source filter, says so under its own name and opens the apps that have them", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ci = { _id: "s9", name: "github-ci", provider: "github" } as any;
  const app = { _id: "s1", name: "union", provider: "app" } as any;
  await act(async () => {
    root.render(<MemoryRouter><NoAppActions source={ci} apps={[app]} /></MemoryRouter>);
  });
  const box = container.querySelector("[data-ops-no-app]")!;
  expect(text(box.querySelector(".ops-noapp-head b"))).toBe("github-ci has no app actions");
  expect([...box.querySelectorAll("dd")].map(text)).toEqual(["IssuesTimeline", "No actions"]);
  const open = box.querySelector<HTMLAnchorElement>(".ops-noapp-apps a")!;
  expect(text(open)).toBe("Open union");
  expect(open.getAttribute("href")).toContain("source=union");
  await act(async () => root.unmount());
  container.remove();
});
