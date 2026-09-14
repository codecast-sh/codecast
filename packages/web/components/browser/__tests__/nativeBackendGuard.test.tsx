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

/** The shell's event callback, captured so a test can deliver one. */
let deliver: ((e: Record<string, unknown>) => void) | null = null;

mock.module("../../../lib/desktop", () => ({
  browserPaneBridge: () =>
    hasBridge
      ? {
          send: async (cmd: string, payload: Record<string, unknown> = {}) => {
            sent.push({ cmd, payload });
            return { ok: true };
          },
          on: (cb: (e: Record<string, unknown>) => void) => {
            deliver = cb;
            return () => {
              deliver = null;
            };
          },
        }
      : null,
}));
mock.module("../../../hooks/useNativeBrowserPane", () => ({
  useNativeBrowserPane: () => available,
}));
mock.module("../../../lib/tabParams", () => ({ useTabContext: () => ({ leafId: "leaf-1", isActive: true }) }));
mock.module("../../../lib/stage", () => ({ stageFocus: () => {} }));

const URL_UNDER_TEST = "https://github.com/";

async function mount(overrides: { focused?: boolean } = {}) {
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
          focused: overrides.focused ?? true,
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
  deliver = null;
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

describe("a native pane that is on screen but not focused", () => {
  test("stays shown, because the person is reading it beside their work", async () => {
    // The stage marks every leaf but the focused one inactive, so a pane
    // beside the conversation being typed into mounts with focused=false.
    // It is still on screen, and the page must stay visible there. Only an
    // empty rect hides the view: a background tab is display:none.
    available = true;
    const proto = (window as any).HTMLElement.prototype;
    const realRect = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: Element) {
      return this.hasAttribute("data-native-pane")
        ? { left: 600, top: 32, right: 1100, bottom: 700, width: 500, height: 668, x: 600, y: 32, toJSON() {} }
        : realRect.call(this);
    };
    try {
      const { root, act } = await mount({ focused: false });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      const bounds = sent.filter((s) => s.cmd === "bounds");
      expect(bounds.length).toBeGreaterThan(0);
      expect(bounds[bounds.length - 1].payload.visible).toBe(true);
      await act(async () => root.unmount());
    } finally {
      proto.getBoundingClientRect = realRect;
    }
  });

  test("a pane with no area is hidden, which is how a background tab hides", async () => {
    available = true;
    const { root, act } = await mount({ focused: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // jsdom lays nothing out, so this div measures 0x0 like a display:none tab.
    const bounds = sent.filter((s) => s.cmd === "bounds");
    expect(bounds.length).toBeGreaterThan(0);
    expect(bounds[bounds.length - 1].payload.visible).toBe(false);
    await act(async () => root.unmount());
  });
});

describe("keys the page was not allowed to keep", () => {
  test("come back as the app's own keystroke, so the palette still opens", async () => {
    // A native view holds keyboard focus, so the app never sees Cmd+K. The
    // shell forwards it (browserPanes.js) and the pane re-raises it here.
    // The app's shortcut listener is on window, in the capture phase, and
    // matches on event.key — so that is exactly what has to arrive.
    available = true;
    const { root, act } = await mount();
    const seen: Array<{ key: string; meta: boolean; ctrl: boolean }> = [];
    const onKey = (e: KeyboardEvent) => seen.push({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey });
    window.addEventListener("keydown", onKey, true);
    try {
      expect(deliver).not.toBeNull();
      await act(async () => {
        deliver!({ paneId: (sent[0].payload as any).paneId, event: "chord", key: "k" });
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].key).toBe("k");
      // One modifier, the platform's own: both would match nothing.
      expect(seen[0].meta || seen[0].ctrl).toBe(true);
      expect(seen[0].meta && seen[0].ctrl).toBe(false);
    } finally {
      window.removeEventListener("keydown", onKey, true);
      await act(async () => root.unmount());
    }
  });

  test("reload is the pane's own: it goes to the view, not to the app", async () => {
    available = true;
    const { root, act } = await mount();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey, true);
    try {
      // Addressed to THIS pane: the component ignores another pane's events.
      const paneId = (sent[0].payload as any).paneId;
      sent = [];
      await act(async () => {
        deliver!({ paneId, event: "chord", key: "r" });
      });
      expect(seen).toEqual([]);
      expect(sent.map((s) => s.cmd)).toContain("reload");
    } finally {
      window.removeEventListener("keydown", onKey, true);
      await act(async () => root.unmount());
    }
  });
});
