import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const previous = new Map<string, { present: boolean; value: unknown }>();
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "https://local.codecast.sh/",
});

beforeAll(() => {
  const globals = globalThis as any;
  for (const key of ["window", "document", "navigator", "location", "localStorage", "sessionStorage", "Element", "HTMLElement", "Node", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"]) {
    previous.set(key, { present: key in globals, value: globals[key] });
  }
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.navigator = dom.window.navigator;
  globals.location = dom.window.location;
  globals.localStorage = dom.window.localStorage;
  globals.sessionStorage = dom.window.sessionStorage;
  globals.Element = dom.window.Element;
  globals.HTMLElement = dom.window.HTMLElement;
  globals.Node = dom.window.Node;
  globals.MutationObserver = dom.window.MutationObserver;
  globals.getComputedStyle = dom.window.getComputedStyle;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { ThemeProvider, useTheme } = await import("../ThemeProvider");
const { useInboxStore } = await import("../../store/inboxStore");
const { applyUpdatesToStore } = await import("../../store/syncReplication");
const { flushSyncPublishes } = await import("../../store/syncTransaction");
const act: <T>(callback: () => T | Promise<T>) => Promise<T> = (React as any).act;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe() {
  const { visualStyle, setVisualStyle } = useTheme();
  return <button onClick={() => setVisualStyle(visualStyle === "minimal" ? "classic" : "minimal")}>{visualStyle}</button>;
}

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return <button onClick={toggleTheme}>{theme}</button>;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  useInboxStore.setState({ clientState: {}, clientStateInitialized: true, pending: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    flushSyncPublishes();
    root.unmount();
  });
  host.remove();
});

afterAll(() => {
  const globals = globalThis as any;
  for (const [key, prior] of previous) {
    if (prior.present) globals[key] = prior.value;
    else delete globals[key];
  }
  closeDomWindow(dom);
});

describe("ThemeProvider shared dark mode", () => {
  test("uses the local cache until the user preference arrives, without writing it back", async () => {
    localStorage.setItem("codecast-theme", "dark");
    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));
    expect(host.textContent).toBe("dark");
    expect(useInboxStore.getState().clientState.ui?.theme).toBeUndefined();

    await act(async () => {
      useInboxStore.getState().syncTable("clientState", { ui: { theme: "light", "theme:ts": 100 } });
      flushSyncPublishes();
    });

    expect(host.textContent).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("codecast-theme")).toBe("light");
    expect((useInboxStore.getState().clientState.ui as Record<string, unknown>)["theme:ts"]).toBe(100);
  });

  test("the user preference beats a conflicting cache on mount", async () => {
    localStorage.setItem("codecast-theme", "light");
    useInboxStore.getState().syncTable("clientState", { ui: { theme: "dark", "theme:ts": 100 } });
    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));

    expect(host.textContent).toBe("dark");
    expect(localStorage.getItem("codecast-theme")).toBe("dark");
    expect((useInboxStore.getState().clientState.ui as Record<string, unknown>)["theme:ts"]).toBe(100);
  });

  test("toggles locally first and keeps the choice through an older server echo", async () => {
    await act(async () => root.render(<React.StrictMode><ThemeProvider><ThemeProbe /></ThemeProvider></React.StrictMode>));
    const before = Date.now();
    await act(async () => {
      host.querySelector("button")!.click();
      expect(useInboxStore.getState().clientState.ui?.theme).toBe("dark");
    });
    expect(host.textContent).toBe("dark");
    expect((useInboxStore.getState().clientState.ui as Record<string, unknown>)["theme:ts"]).toBeGreaterThanOrEqual(before);

    await act(async () => {
      useInboxStore.getState().syncTable("clientState", { ui: { theme: "light", "theme:ts": before - 1 } });
      flushSyncPublishes();
    });
    expect(host.textContent).toBe("dark");

    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toBe("light");
    expect(localStorage.getItem("codecast-theme")).toBe("light");
  });

  test("an open popup follows replicated changes in both directions without sending a new preference", async () => {
    useInboxStore.setState({ clientState: { ui: { theme: "light" } } });
    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));
    for (const [theme, stamp] of [["dark", 100], ["light", 200]] as const) {
      await act(async () => {
        applyUpdatesToStore([{ key: "clientState", hasValue: true, value: { ui: { theme, "theme:ts": stamp } } }]);
        flushSyncPublishes();
      });
      expect(host.textContent).toBe(theme);
      expect(document.documentElement.classList.contains(theme)).toBe(true);
      expect(localStorage.getItem("codecast-theme")).toBe(theme);
      expect((useInboxStore.getState().clientState.ui as Record<string, unknown>)["theme:ts"]).toBe(stamp);
    }
  });

  test("ignores an invalid cached theme", async () => {
    localStorage.setItem("codecast-theme", "invalid");
    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));
    expect(host.textContent).toBe("light");
    expect(document.documentElement.classList.contains("invalid")).toBe(false);
  });
});

describe("ThemeProvider Minimal style", () => {
  test("boots from local storage and switches back to Classic locally first", async () => {
    localStorage.setItem("codecast-visual-style", "minimal");
    await act(async () => root.render(<ThemeProvider><Probe /></ThemeProvider>));

    expect(host.textContent).toBe("minimal");
    expect(document.documentElement.classList.contains("minimal-style")).toBe(true);

    await act(async () => host.querySelector("button")!.click());

    expect(host.textContent).toBe("classic");
    expect(document.documentElement.classList.contains("minimal-style")).toBe(false);
    expect(localStorage.getItem("codecast-visual-style")).toBe("classic");
    expect(useInboxStore.getState().clientState.ui?.visual_style).toBe("classic");
  });

  test("adopts the stored client preference when this device has no choice yet", async () => {
    useInboxStore.setState({ clientState: { ui: { visual_style: "minimal" } }, clientStateInitialized: true });
    await act(async () => root.render(<ThemeProvider><Probe /></ThemeProvider>));

    expect(host.textContent).toBe("minimal");
    expect(localStorage.getItem("codecast-visual-style")).toBe("minimal");
    expect(document.documentElement.classList.contains("minimal-style")).toBe(true);
  });

  test("migrates the legacy Codex preference to Minimal", async () => {
    localStorage.setItem("codecast-visual-style", "codex");
    useInboxStore.setState({ clientState: { ui: { visual_style: "codex" } as any }, clientStateInitialized: true });
    await act(async () => root.render(<ThemeProvider><Probe /></ThemeProvider>));

    expect(host.textContent).toBe("minimal");
    expect(localStorage.getItem("codecast-visual-style")).toBe("minimal");
    expect(document.documentElement.classList.contains("minimal-style")).toBe(true);
    expect(document.documentElement.classList.contains("codex-style")).toBe(false);
    expect(useInboxStore.getState().clientState.ui?.visual_style).toBe("minimal");
  });
});
