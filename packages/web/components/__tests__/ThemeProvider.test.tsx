import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

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
const act: <T>(callback: () => T | Promise<T>) => Promise<T> = (React as any).act;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe() {
  const { visualStyle, setVisualStyle } = useTheme();
  return <button onClick={() => setVisualStyle(visualStyle === "minimal" ? "classic" : "minimal")}>{visualStyle}</button>;
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
  await act(async () => root.unmount());
  host.remove();
});

afterAll(() => {
  const globals = globalThis as any;
  for (const [key, prior] of previous) {
    if (prior.present) globals[key] = prior.value;
    else delete globals[key];
  }
  dom.window.close();
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
