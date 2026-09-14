// THE NATIVE PANE ASKS A SHELL THAT CAN ANSWER, OR IT ASKS NOTHING.
//
// The route carries the choice of backend (`/browser?u=…&native=1`), so this
// component can mount on a build that has no native view at all: an older
// desktop shell, or a plain browser tab where someone opened a saved link.
// The bridge existing proves nothing there — every desktop build carries the
// generic app IPC call, and one without the view simply rejects the name — so
// the component waits for the shell's own capability answer, which lands a
// tick after boot.
//
// Ungated, two things go wrong, and both are visible to a person: the pane
// sends `create` to a shell that cannot honour it, and the address strip grows
// back, forward and devtools buttons sitting above a card that says the view
// is unavailable.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const hadGlobals = new Map<string, { had: boolean; was: unknown }>();

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://local.codecast.sh/",
  });
  const g = globalThis as any;
  for (const k of ["window", "document", "navigator", "location", "localStorage", "sessionStorage", "Element", "HTMLElement", "Node", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
    hadGlobals.set(k, { had: k in g, was: g[k] });
  }
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.location = dom.window.location;
  g.localStorage = dom.window.localStorage;
  g.sessionStorage = dom.window.sessionStorage;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.MutationObserver = dom.window.MutationObserver;
  // jsdom has no layout and no ResizeObserver; the pane only measures itself
  // here, and a rect of zeros is the honest answer for an unlaid-out div.
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.getComputedStyle = dom.window.getComputedStyle;
  g.requestAnimationFrame = (fn: FrameRequestCallback) => dom.window.setTimeout(() => fn(0), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  const g = globalThis as any;
  for (const [k, { had, was }] of hadGlobals) {
    if (had) g[k] = was;
    else delete g[k];
  }
});

/** What the shell was asked, in order. The whole point of the guard is that
 *  this stays EMPTY until the capability answer arrives. */
let sent: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
/** What the capability probe currently answers. */
let available = false;
/** Whether this build exposes the app IPC at all (a browser tab does not). */
let hasBridge = true;

mock.module("../../../lib/desktop", () => ({
  browserPaneBridge: () =>
    hasBridge
      ? {
          send: async (cmd: string, payload: Record<string, unknown> = {}) => {
            sent.push({ cmd, payload });
            return { ok: true };
          },
          on: () => () => {},
        }
      : null,
}));
mock.module("../../../hooks/useNativeBrowserPane", () => ({
  useNativeBrowserPane: () => available,
}));
mock.module("../../../lib/tabParams", () => ({ useTabContext: () => ({ leafId: "leaf-1", isActive: true }) }));
mock.module("../../../lib/stage", () => ({ stageFocus: () => {} }));

const URL_UNDER_TEST = "https://github.com/";

async function mount() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NativeBackend } = await import("../backends/NativeBackend");

  const actions: unknown[][] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(
        React.createElement(NativeBackend, {
          source: { kind: "url", url: URL_UNDER_TEST },
          focused: true,
          reloadToken: 0,
          onTitle: () => {},
          onUrl: () => {},
          onState: () => {},
          onActions: (a: unknown[]) => actions.push(a),
        } as any),
      );
    });
  };
  await render();
  return { host, root, render, actions, act };
}

beforeEach(() => {
  sent = [];
  available = false;
  hasBridge = true;
});

describe("the native pane before the shell has answered", () => {
  test("asks for nothing while the capability probe is still out", async () => {
    const { host, root, act } = await mount();
    expect(sent).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    // And no hole for a view that is not coming.
    expect(host.querySelector("[data-native-pane]")).toBeNull();
    await act(async () => root.unmount());
  });

  test("asks for nothing when the shell answered that it has no view", async () => {
    // The route forced this backend (`&native=1`) onto a build without one.
    // The answer is already in and it is no, which must be as quiet as
    // "not yet" — an older desktop must never be sent a create it will reject.
    available = false;
    const { host, root, act } = await mount();
    expect(sent.map((s) => s.cmd)).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    await act(async () => root.unmount());
  });

  test("puts no back, forward or devtools in the strip it cannot drive", async () => {
    const { root, actions, act } = await mount();
    // It still REPORTS, so a strip left over from another backend is cleared;
    // what it reports is an empty set of verbs.
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.length === 0)).toBe(true);
    await act(async () => root.unmount());
  });

  test("a browser tab, with no app IPC at all, is the same quiet", async () => {
    hasBridge = false;
    available = false;
    const { host, root, act } = await mount();
    expect(sent).toEqual([]);
    expect(host.textContent).toContain("needs the desktop app");
    await act(async () => root.unmount());
  });
});

describe("once the shell answers that it has the view", () => {
  test("the pane creates it, at the address the route named", async () => {
    available = true;
    const { host, root, act } = await mount();
    const create = sent.find((s) => s.cmd === "create");
    expect(create).toBeDefined();
    expect(create!.payload.url).toBe(URL_UNDER_TEST);
    // Born hidden: the first measured rect reveals it, never the create.
    expect(create!.payload.visible).toBe(false);
    expect(host.querySelector("[data-native-pane]")).not.toBeNull();
    await act(async () => root.unmount());
  });

  test("an answer that lands after mount still opens the view", async () => {
    // The real sequence: the probe is a call into another process, so the
    // first render always happens without an answer.
    const { render, root, act } = await mount();
    expect(sent).toEqual([]);
    available = true;
    await render();
    expect(sent.map((s) => s.cmd)).toContain("create");
    await act(async () => root.unmount());
  });

  test("the verbs appear only with a view to drive", async () => {
    available = true;
    const { actions, root, act } = await mount();
    const last = actions[actions.length - 1] as Array<{ label: string }>;
    expect(last.map((a) => a.label)).toEqual([
      "Back to the previous page",
      "Forward to the next page",
      "Open developer tools for this pane",
    ]);
    await act(async () => root.unmount());
  });

  test("unmounting takes the view down with it", async () => {
    available = true;
    const { root, act } = await mount();
    sent = [];
    await act(async () => root.unmount());
    expect(sent.map((s) => s.cmd)).toContain("destroy");
  });
});
