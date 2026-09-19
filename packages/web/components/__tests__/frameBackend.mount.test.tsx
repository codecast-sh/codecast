import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { FrameBackend } from "../browser/backends/FrameBackend";
import type { BrowserPaneState } from "../browser/backends/types";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
let answer: "refuse" | "answer" = "refuse";
const fetched: string[] = [];
let permissionState = "prompt";
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: Object.assign(Object.create(dom.window.navigator), {
    permissions: {
      query: async ({ name }: { name: string }) => {
        if (name !== "loopback-network") throw new TypeError("unknown permission");
        return { state: permissionState };
      },
    },
  }),
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  fetch: (url: string) => {
    fetched.push(url);
    return answer === "answer" ? Promise.resolve({}) : Promise.reject(new TypeError("Failed to fetch"));
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function mount(url: string) {
  const states: BrowserPaneState[] = [];
  const titles: (string | null)[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    source: { kind: "url" as const, url },
    focused: true,
    reloadToken: 0,
    onTitle: (t: string | null) => titles.push(t),
    onUrl: () => {},
    onState: (s: BrowserPaneState) => states.push(s),
  };
  return { states, titles, container, root, render: () => act(() => root.render(<FrameBackend {...props} />)) };
}

test("a dead address polls, and flips to the page when a server comes up", async () => {
  answer = "refuse";
  permissionState = "prompt";
  fetched.length = 0;
  const pane = mount("http://localhost:8766/");
  try {
    await pane.render();
    await wait(50);
    expect(pane.states.at(-1)).toEqual({ kind: "unreachable", loopback: true });
    const firstFrame = pane.container.querySelector("iframe");
    // HEAD, then GET: both failed before the verdict.
    expect(fetched).toHaveLength(2);

    answer = "answer";
    await wait(3400);
    // The poll found the server: the frame remounts and loading starts over.
    expect(pane.states.at(-1)).toEqual({ kind: "loading" });
    expect(pane.container.querySelector("iframe") === firstFrame).toBe(false);

    const afterRevival = fetched.length;
    await wait(3400);
    expect(fetched.length).toBe(afterRevival);
  } finally {
    await act(() => pane.root.unmount());
  }
}, 15000);

test("Chrome's local network denial is named, and not polled", async () => {
  answer = "refuse";
  permissionState = "denied";
  fetched.length = 0;
  const pane = mount("http://localhost:8767/");
  try {
    await pane.render();
    await wait(50);
    expect(pane.states.at(-1)).toEqual({ kind: "blocked", reason: "local-network" });
    const probes = fetched.length;
    await wait(3400);
    expect(fetched.length).toBe(probes);
  } finally {
    await act(() => pane.root.unmount());
    permissionState = "prompt";
  }
}, 10000);

test("a same-origin page that retitles itself is followed until it unloads", async () => {
  answer = "answer";
  const pane = mount("http://localhost:3000/");
  try {
    await pane.render();
    await wait(50);
    const frame = pane.container.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    // jsdom loads nothing for an http src and leaves the frame document empty,
    // so the test builds the page a same-origin server would have sent.
    if (!doc.documentElement) {
      const html = doc.createElement("html");
      html.appendChild(doc.createElement("head"));
      html.appendChild(doc.createElement("body"));
      doc.appendChild(html);
    }
    doc.title = "First";
    await act(() => {
      frame.dispatchEvent(new dom.window.Event("load"));
    });
    expect(pane.states.at(-1)).toEqual({ kind: "ready", opaque: false });
    expect(pane.titles.at(-1)).toBe("First");

    await act(async () => {
      doc.title = "Second";
      await Promise.resolve();
    });
    expect(pane.titles.at(-1)).toBe("Second");

    const count = pane.titles.length;
    await act(async () => {
      frame.contentWindow!.dispatchEvent(new dom.window.Event("pagehide"));
      doc.title = "After unload";
      await Promise.resolve();
    });
    expect(pane.titles.length).toBe(count);
  } finally {
    await act(() => pane.root.unmount());
  }
});

test("a codecast address is framed as a pane's page; every other address as it stands", async () => {
  // The app inside the frame reads this flag once, at boot, and draws the
  // route without its own nav rail, tab bar and session rail (PANE_EMBED).
  answer = "refuse";
  const app = mount("https://codecast.sh/inbox");
  try {
    await app.render();
    await wait(50);
    expect(app.container.querySelector("iframe")!.getAttribute("src")).toBe(
      "https://codecast.sh/inbox?embed=1",
    );
  } finally {
    await act(() => app.root.unmount());
  }

  const site = mount("https://github.com/codecast?tab=readme");
  try {
    await site.render();
    await wait(50);
    expect(site.container.querySelector("iframe")!.getAttribute("src")).toBe(
      "https://github.com/codecast?tab=readme",
    );
  } finally {
    await act(() => site.root.unmount());
  }
}, 10000);

test("the probe runs once per address, however often the pane re-renders", async () => {
  // A pane re-renders for reasons that have nothing to do with the page: a
  // title arriving, a strip verb, the machine roster. If the probe keyed on
  // the callbacks it reports through, a parent that hands over fresh ones on
  // each render would loop: probe, report, re-render, new callback, probe.
  answer = "answer";
  fetched.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const renderWith = (url: string) =>
    act(() =>
      root.render(
        <FrameBackend
          source={{ kind: "url", url }}
          focused
          reloadToken={0}
          // Deliberately fresh on every render.
          onTitle={() => {}}
          onUrl={() => {}}
          onState={() => {}}
        />,
      ),
    );
  try {
    await renderWith("http://localhost:8770/");
    await wait(50);
    // The server answered HEAD: one request, no GET.
    expect(fetched).toEqual(["http://localhost:8770/"]);
    for (let i = 0; i < 5; i++) await renderWith("http://localhost:8770/");
    await wait(50);
    expect(fetched).toHaveLength(1);

    await renderWith("http://localhost:8771/");
    await wait(50);
    expect(fetched).toEqual(["http://localhost:8770/", "http://localhost:8771/"]);
  } finally {
    await act(() => root.unmount());
  }
});

test("the poll stops when the pane goes away", async () => {
  answer = "refuse";
  permissionState = "prompt";
  fetched.length = 0;
  const pane = mount("http://localhost:8772/");
  await pane.render();
  await wait(50);
  expect(pane.states.at(-1)).toEqual({ kind: "unreachable", loopback: true });
  const beforeUnmount = fetched.length;
  const statesBefore = pane.states.length;
  await act(() => pane.root.unmount());
  // Two whole poll intervals: nothing asks, and nothing reports to a pane
  // that no longer exists.
  await wait(6500);
  expect(fetched.length).toBe(beforeUnmount);
  expect(pane.states.length).toBe(statesBefore);
}, 12000);
