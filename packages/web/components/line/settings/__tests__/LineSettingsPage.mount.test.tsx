// Mounts /line/settings in jsdom on a project whose line profile the store
// holds (plan pl-838): the sections read in order with each value's source,
// an unset command says what its station does, the finders show their health
// from the same Sense derivation the line page uses, the Stations slot gets
// the project, an edit paints at once and a daemon refusal puts it back with
// the loader's message, a quiet machine still takes edits with a warning, and a
// teammate's machine makes the page read only.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { closeDomWindow } from "../../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line/settings?project=pr-1", pretendToBeVisual: true });
const matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400, matchMedia }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  matchMedia,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

mock.module("../../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
// Nothing on this page queries the server directly; the hook stays for the sections that might.
// A live query pushes its answer; this one pushes when the test sets it.
let answer: unknown = undefined;
// What the link in asked for (lineSettingsHref); each test sets its own.
let search = "project=pr-1";
const listeners = new Set<() => void>();
const setAnswer = (v: unknown) => { answer = v; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
mock.module("../../../../hooks/useQueryNoThrow", () => ({
  useQueryNoThrow: (_q: unknown, args: any) => {
    const data = React.useSyncExternalStore(subscribe, () => answer);
    return { data: args && args !== "skip" && args.command_id ? data : undefined, error: undefined, retry() {} };
  },
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  usePathname: () => "/line/settings",
  useSearchParams: () => new URLSearchParams(search),
}));
// The Stations section is its own worker's (ct-56913); the slot is what this page owns.
mock.module("../LineStations", () => ({
  LineStations: ({ projectId, focusStation }: { projectId: string; focusStation?: string | null }) => React.createElement("div", { "data-stations-slot": projectId, "data-focus-station": focusStation ?? "" }),
}));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { LineSettingsPage } = await import("../LineSettingsPage");

const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const lineProfile = () => ({
  finders: [
    { id: "sentry-web", source: "sentry", kind: ["bug"], fingerprint: "sentry:<issue>" },
    { id: "evals", source: "evals", kind: ["regression"], fingerprint: "evals:<surface>", runs: "cast trigger tr-9" },
  ],
  root: "/src/codecast",
  default: true,
  changed_at: now - 30 * 86_400_000,
  team: null,
  project: "pr-1",
  principles: ["docs/principles.md"],
  prompting: "https://github.com/codecast-sh/codecast/blob/main/docs/prompting.md",
  size_budget: 300,
  watch_days: 7,
  commands: { check: "cast check", prove: null, eval: null, ship: null },
  caps: { cards: 5 },
  sources: { principles: "file", prompting: "default", size_budget: "file", watch_days: "default", "commands.check": "file", "commands.prove": "default", "commands.eval": "default", "commands.ship": "default", "caps.cards": "default", finders: "file" },
  notes: ["no prove command: the prove station passes with a note", "no eval command: the eval station passes with a note", "no ship command: the line's own merge step lands the change"],
  warnings: [],
  file: ".codecast/line.toml",
  device_id: "mac-1",
  published_at: now - 1000,
});

let sent: Array<{ projectId: string; edits: unknown[] }> = [];

function seed(online: boolean) {
  sent = [];
  setAnswer(undefined);
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [],
    teamMembers: [],
    machineRoster: [{ device_id: "mac-1", label: "Studio", platform: "darwin", online, last_seen: now, is_remote: false }],
    machineRosterLive: true,
    sessionCommands: {},
    projects: { p1: { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS, line_profile: lineProfile() } },
    tasks: { t1: { _id: "t1", short_id: "ct-1", title: "cause", status: "open", workspace: WS, project_id: "p1", created_at: now - 9e6, updated_at: now, cause: { signal_count: 1, first_seen: now - 9e6, last_seen: now } } },
    signals: { s1: { _id: "s1", short_id: "sg-1", source: "sentry", kind: "bug", title: "TypeError in header", subject: "web", observed_at: now - 3_600_000, created_at: now - 3_600_000, task_id: "t1", project_id: "p1", workspace: WS } },
    // The real action dispatches to the server; here it paints the same row and answers a command id.
    editLineProfile: (requestId: string, projectId: string, edits: any[]) => {
      sent.push({ projectId, edits });
      useInboxStore.setState((s: any) => ({ sessionCommands: { ...s.sessionCommands, [requestId]: { _id: requestId, command_id: "cmd-1", command: "line_profile_edit", kind: "line_edit", project_id: projectId, edits, keys: edits.map((e: any) => e.key ?? `finders.${e.finder?.id ?? e.id}`), requested_at: Date.now(), executed_at: null, result: null, error: null } } }));
      return Promise.resolve({ command_id: "cmd-1" });
    },
  } as any);
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LineSettingsPage)); });
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

const row = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>("[data-lset-row]")].find((r) => r.querySelector(".lset-label")?.textContent === label)!;

beforeEach(() => { document.body.innerHTML = ""; search = "project=pr-1"; });

test("the sections read in order, each value says where it came from, and the Stations slot gets the project", async () => {
  seed(true);
  const { host, unmount } = await mount();
  expect([...host.querySelectorAll("[data-lset-section]")].map((s) => s.getAttribute("data-lset-section"))).toEqual(["listens", "holds", "checks", "limits", "stations"]);
  expect(row(host, "Check").querySelector(".lset-value")!.textContent).toBe("cast check");
  expect(row(host, "Check").querySelector(".lset-src")!.textContent).toBe("file");
  expect(row(host, "Watch").querySelector(".lset-src")!.textContent).toBe("default");
  expect(row(host, "Reproduce").querySelector("[data-lset-note]")!.textContent).toBe("the prove station passes with a note");
  expect(row(host, "Check").querySelector("[data-lset-note]")).toBeNull();
  // Finder health from the Sense derivation: sentry filed an hour ago, evals never.
  const finders = [...host.querySelectorAll<HTMLElement>("[data-lset-finder]")];
  expect(finders.map((f) => f.getAttribute("data-lset-finder"))).toEqual(["sentry-web", "evals"]);
  expect(finders[0].querySelector("[data-lset-finder-health]")!.textContent).toMatch(/1 today · last (1h|59m) ago/);
  expect(finders[1].getAttribute("data-silent")).toBe("true");
  expect(finders[1].querySelector("[data-lset-finder-health]")!.textContent).toBe("silent 14d+");
  expect(host.querySelector("[data-stations-slot]")!.getAttribute("data-stations-slot")).toBe("p1");
  expect(host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate")).toBe("writable");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(/Studio/);
  await unmount();
});

test("an edit shows at once and waits on the machine; a daemon refusal stops showing it, with the loader's message", async () => {
  seed(true);
  const { host, unmount } = await mount();
  const button = row(host, "Size budget").querySelector<HTMLButtonElement>(".lset-value")!;
  await act(async () => { button.click(); });
  const input = row(host, "Size budget").querySelector<HTMLInputElement>("input")!;
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "120");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(sent).toEqual([{ projectId: "p1", edits: [{ op: "set", key: "size_budget", value: 120 }] }]);
  expect(row(host, "Size budget").querySelector(".lset-value")!.textContent).toBe("120");
  expect(row(host, "Size budget").querySelector(".lset-status")!.getAttribute("data-state")).toBe("waiting");

  // The daemon's refusal reaches the edit's row (the sessionCommands feed), wherever the page is.
  await act(async () => {
    const [id, r] = Object.entries((useInboxStore.getState() as any).sessionCommands)[0] as [string, any];
    useInboxStore.getState().syncTable("sessionCommands", [{ ...r, _id: id, executed_at: Date.now(), error: "/src/codecast/.codecast/line.toml: [line] size_budget must be at most 2000" }], { isDelta: true });
    // The store tells its subscribers on the next tick.
    await new Promise((r) => setTimeout(r, 20));
  });
  const status = row(host, "Size budget").querySelector(".lset-status")!;
  expect(status.getAttribute("data-state")).toBe("refused");
  expect(status.textContent).toMatch(/size_budget must be at most 2000/);
  expect(row(host, "Size budget").querySelector(".lset-value")!.textContent).toBe("300");
  await unmount();
});

test("a quiet machine still takes edits, and says how long one waits for it", async () => {
  seed(false);
  const { host, unmount } = await mount();
  expect(host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate")).toBe("writable");
  expect(host.querySelector("[data-lset-plate]")!.getAttribute("data-away")).toBe("true");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(/Studio has not checked in.*up to 5 minutes/);
  await unmount();
});

test("a teammate's machine makes the page read only and says why", async () => {
  seed(true);
  useInboxStore.setState({ machineRoster: [{ device_id: "someone-else", label: "Their Mac", platform: "darwin", online: true, last_seen: Date.now(), is_remote: false }] } as any);
  const { host, unmount } = await mount();
  expect(host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate")).toBe("read-only");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(/teammate's machine/);
  // Read only stays focusable for the arrow walk; nothing opens, and the key hints are gone.
  const value = row(host, "Check").querySelector<HTMLButtonElement>(".lset-value")!;
  expect(value.getAttribute("aria-disabled")).toBe("true");
  expect(value.disabled).toBe(false);
  await act(async () => { value.click(); });
  expect(row(host, "Check").querySelector("[data-lset-input]")).toBeNull();
  expect(host.querySelector("[data-lset-footer]")).toBeNull();
  expect(host.querySelector(".lset-add")).toBeNull();
  await unmount();
});

test("a link in lands on its section or station: scrolled to, and marked to flash once", async () => {
  seed(true);
  const scrolled: string[] = [];
  const prior = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.getAttribute("data-lset-section") ?? this.tagName); };
  try {
    search = "project=pr-1&section=limits";
    let m = await mount();
    expect([...m.host.querySelectorAll("[data-lset-target]")].map((s) => s.getAttribute("data-lset-section"))).toEqual(["limits"]);
    expect(scrolled).toEqual(["limits"]);
    await m.unmount();

    // A station goes to LineStations, which opens and scrolls its own panel.
    scrolled.length = 0;
    search = "project=pr-1&section=stations&station=verify";
    m = await mount();
    expect(m.host.querySelector("[data-stations-slot]")!.getAttribute("data-focus-station")).toBe("verify");
    expect(m.host.querySelectorAll("[data-lset-target]").length).toBe(0);
    expect(scrolled).toEqual([]);
    await m.unmount();
  } finally {
    dom.window.HTMLElement.prototype.scrollIntoView = prior;
  }
});
