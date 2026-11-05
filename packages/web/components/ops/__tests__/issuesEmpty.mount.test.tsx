// The Issues tab on a workspace with no issues, mounted without touching
// anyone's active team: no sources connected offers every provider; sources
// that sent nothing yet are listed with what each last did; a feed still
// reading or failed says so instead of "no issues".
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops/issues" });
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
  Event: dom.window.Event,
  requestAnimationFrame: (f: any) => setTimeout(f, 0),
  cancelAnimationFrame: clearTimeout,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { IssuesEmpty } = await import("../issueEmpty");
type Props = Parameters<typeof IssuesEmpty>[0];

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function mount(props: Props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><IssuesEmpty {...props} /></MemoryRouter>));
  return { container, done: () => { root.unmount(); container.remove(); } };
}

const ready = { ready: true } as unknown as Props["feed"];

test("no sources: every provider is one press away", async () => {
  const m = await mount({ feed: ready, sources: [] });
  expect(m.container.textContent).toContain("No sources connected");
  const providers = [...m.container.querySelectorAll(".iss-provider")].map((a) => a.getAttribute("data-provider"));
  expect(providers).toEqual(["sentry", "posthog", "app", "github", "sdk"]);
  for (const a of m.container.querySelectorAll<HTMLAnchorElement>(".iss-provider")) expect(a.getAttribute("href")).toBeTruthy();
  m.done();
});

test("sources that sent nothing yet are listed, never an all-clear", async () => {
  const source = { _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "sentry", name: "web-errors", keyed: false, promote: [], status: "active" } as unknown as Props["sources"][number];
  const m = await mount({ feed: ready, sources: [source] });
  expect(m.container.textContent).toContain("No issues yet");
  expect(m.container.textContent).toContain("web-errors");
  m.done();
});

test("a feed still reading is not called empty", async () => {
  const m = await mount({ feed: { ready: false } as unknown as Props["feed"], sources: [] });
  expect(m.container.textContent).not.toContain("No sources connected");
  m.done();
});
