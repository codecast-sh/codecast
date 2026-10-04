// Mounts the Line page in jsdom with the evals finder and one other finder in
// the Sense station (evals-ui.md section 8, U16): the evals row opens the
// Evals area on the surface its newest signal names, a subject that is not a
// surface name opens the wall, and any other source still opens its cause.
import { afterAll, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/line?project=p1", pretendToBeVisual: true });
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
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom lays nothing out and has no scrollTo; the switcher centers its pill with it.
dom.window.HTMLElement.prototype.scrollTo = () => {};
const { createRoot } = await import("react-dom/client");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

// The feeders are live Convex subscriptions; the page paints from the store,
// so the generic feeder is a no-op and the store is seeded directly.
mock.module("../../../hooks/useSyncCollection", () => ({
  useSyncCollection: () => ({ ready: true }),
  useFeederError: () => {},
  entityIdArgs: () => "skip",
  applyCollectionFeed: () => {},
  keyRowsBy: (rows: any[]) => rows ?? [],
}));
mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {} }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams("project=p1"),
}));

const { useInboxStore } = await import("../../../store/inboxStore");
const { LinePage } = await import("../LinePage");

const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const signal = (id: string, source: string, subject: string, task: string, ago: number) => ({
  _id: id, short_id: `sg-${id}`, source, kind: "regression", title: `${source} ${subject} fell`, subject, observed_at: now - ago, created_at: now - ago, task_id: task, project_id: "p1", workspace: WS,
});
const cause = (id: string, short: string) => ({
  _id: id, short_id: short, title: `cause ${short}`, status: "open", workspace: WS, project_id: "p1", created_at: now - 9e6, updated_at: now - 1000,
  cause: { signal_count: 1, first_seen: now - 9e6, last_seen: now - 1000 },
});

function seed(evalsSubject: string) {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" },
    clientStateInitialized: true,
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: {} },
    teams: [],
    teamMembers: [],
    projects: { p1: { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: WS } },
    tasks: { t1: cause("t1", "ct-1"), t2: cause("t2", "ct-2") },
    signals: {
      // The older evals signal names another surface: the row follows the newest.
      s0: signal("s0", "evals", "title", "t1", 7_200_000),
      s1: signal("s1", "evals", evalsSubject, "t1", 3_600_000),
      s2: signal("s2", "sentry", "web", "t2", 1_800_000),
    },
  } as any);
}

async function senseHrefs(evalsSubject: string): Promise<Record<string, string | null>> {
  seed(evalsSubject);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(LinePage)); });
  const rows = [...host.querySelectorAll<HTMLAnchorElement>("a[data-line-row]")];
  const out: Record<string, string | null> = {};
  for (const source of ["evals", "sentry"]) {
    const row = rows.find((a) => a.querySelector("span")?.textContent === source);
    out[source] = row ? row.getAttribute("href") : null;
  }
  await act(async () => { root.unmount(); });
  host.remove();
  return out;
}

test("the evals Sense row opens the surface its newest signal names; other finders open their cause", async () => {
  const hrefs = await senseHrefs("settle");
  expect(hrefs.evals).toBe("/evals/s/settle");
  expect(hrefs.sentry).toMatch(/ct-2|t2/);
});

test("a subject that is not a surface name opens the Evals wall", async () => {
  const hrefs = await senseHrefs("../settle");
  expect(hrefs.evals).toBe("/evals");
});
