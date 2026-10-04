// Mounts /line/settings in jsdom on a project whose line profile the store
// holds (plan pl-838): the sections read in order with each value's source,
// an unset command says what its station does, the finders show their health
// from the same Sense derivation the line page uses, the Stations slot gets
// the project, an edit paints at once and a daemon refusal puts it back with
// the loader's message, and a machine that is offline makes the page read only.
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
// The daemon's answer to the page's edit command; nothing else is queried here.
// A live query pushes its answer; this one pushes when the test sets it.
let answer: unknown = undefined;
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
  useSearchParams: () => new URLSearchParams("project=pr-1"),
}));
// The Stations section is its own worker's (ct-56913); the slot is what this page owns.
mock.module("../LineStations", () => ({
  LineStations: ({ projectId }: { projectId: string }) => React.createElement("div", { "data-stations-slot": projectId }),
}));

const { useInboxStore } = await import("../../../../store/inboxStore");
const { applyLineEdits } = await import("../../../../lib/lineSettings");
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
  changed_at: now - 1000,
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
    projects: { p1: { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS, line_profile: lineProfile() } },
    tasks: { t1: { _id: "t1", short_id: "ct-1", title: "cause", status: "open", workspace: WS, project_id: "p1", created_at: now - 9e6, updated_at: now, cause: { signal_count: 1, first_seen: now - 9e6, last_seen: now } } },
    signals: { s1: { _id: "s1", short_id: "sg-1", source: "sentry", kind: "bug", title: "TypeError in header", subject: "web", observed_at: now - 3_600_000, created_at: now - 3_600_000, task_id: "t1", project_id: "p1", workspace: WS } },
    // The real action dispatches to the server; here it paints the same way and answers a command id.
    editLineProfile: (projectId: string, edits: any[]) => {
      sent.push({ projectId, edits });
      useInboxStore.setState((s: any) => {
        const lp = structuredClone(s.projects[projectId].line_profile);
        applyLineEdits(lp, edits);
        return { projects: { ...s.projects, [projectId]: { ...s.projects[projectId], line_profile: lp } } };
      });
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

beforeEach(() => { document.body.innerHTML = ""; });

test("the sections read in order, each value says where it came from, and the Stations slot gets the project", async () => {
  seed(true);
  const { host, unmount } = await mount();
  expect([...host.querySelectorAll("[data-lset-section]")].map((s) => s.getAttribute("data-lset-section"))).toEqual(["listens", "holds", "checks", "limits", "stations"]);
  expect(row(host, "check").querySelector(".lset-value")!.textContent).toBe("cast check");
  expect(row(host, "check").querySelector(".lset-src")!.textContent).toBe("file");
  expect(row(host, "Watch").querySelector(".lset-src")!.textContent).toBe("default");
  expect(row(host, "prove").querySelector("[data-lset-note]")!.textContent).toBe("the prove station passes with a note");
  expect(row(host, "check").querySelector("[data-lset-note]")).toBeNull();
  // Finder health from the Sense derivation: sentry filed an hour ago, evals never.
  const finders = [...host.querySelectorAll<HTMLElement>("[data-lset-finder]")];
  expect(finders.map((f) => f.getAttribute("data-lset-finder"))).toEqual(["sentry-web", "evals"]);
  expect(finders[0].querySelector("[data-lset-finder-health]")!.textContent).toMatch(/1 today · last 1h ago/);
  expect(finders[1].getAttribute("data-silent")).toBe("true");
  expect(finders[1].querySelector("[data-lset-finder-health]")!.textContent).toMatch(/silent, nothing in 14 days/);
  expect(host.querySelector("[data-stations-slot]")!.getAttribute("data-stations-slot")).toBe("p1");
  expect(host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate")).toBe("writable");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(/Studio/);
  await unmount();
});

test("an edit paints at once and waits on the machine; a daemon refusal puts the value back with the loader's message", async () => {
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

  await act(async () => { setAnswer({ executed_at: Date.now(), error: "/src/codecast/.codecast/line.toml: [line] size_budget must be at most 2000" }); });
  const status = row(host, "Size budget").querySelector(".lset-status")!;
  expect(status.getAttribute("data-state")).toBe("refused");
  expect(status.textContent).toMatch(/size_budget must be at most 2000/);
  expect(row(host, "Size budget").querySelector(".lset-value")!.textContent).toBe("300");
  await unmount();
});

test("an offline machine makes the page read only and says why", async () => {
  seed(false);
  const { host, unmount } = await mount();
  expect(host.querySelector("[data-lset-gate]")!.getAttribute("data-lset-gate")).toBe("read-only");
  expect(host.querySelector("[data-lset-plate]")!.textContent).toMatch(/Studio is offline/);
  expect(row(host, "check").querySelector<HTMLButtonElement>(".lset-value")!.disabled).toBe(true);
  expect(host.querySelector(".lset-add")).toBeNull();
  await unmount();
});
