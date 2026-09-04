// The call settings panel: one body for the people window's sheet and the
// settings modal's Calls section. What is worth pinning is that every switch
// reads the same source the joins read (absent = on), that the sheet is a
// labelled dialog with one way out, and that nothing in it is desktop-only
// except the meeting block, which renders nothing in a browser.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";

let ui: Record<string, unknown> = {};
const { CallSettings, CallSettingsSheet } = await import("../calls/CallSettings");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let root: Root | undefined;
const clientState = useInboxStore.getState().clientState;
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  useInboxStore.setState({ clientState });
});
afterAll(() => {
  dom.window.close();
  restoreGlobals();
});
async function renderToMarkup(children: ReactNode): Promise<string> {
  useInboxStore.setState({ clientState: { ...clientState, ui } });
  const container = document.createElement("div");
  root = createRoot(container);
  await act(() => root!.render(children));
  return container.innerHTML;
}

function switches(html: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button[^>]*role="switch"[^>]*>/g)) {
    const label = /aria-label="([^"]+)"/.exec(m[0])?.[1] ?? "";
    out[label] = /aria-checked="true"/.test(m[0]);
  }
  return out;
}

describe("call settings", () => {
  test("camera and mic read as ON when nothing was chosen", async () => {
    ui = {};
    const sw = switches(await renderToMarkup(<CallSettings />));
    expect(sw["Camera on when I join"]).toBe(true);
    expect(sw["Microphone on when I join"]).toBe(true);
    expect(sw["Sound effects"]).toBe(true);
  });

  test("an explicit off is shown off", async () => {
    ui = { call_camera_on: false, call_mic_on: false, sounds_enabled: false };
    const sw = switches(await renderToMarkup(<CallSettings />));
    expect(sw["Camera on when I join"]).toBe(false);
    expect(sw["Microphone on when I join"]).toBe(false);
    expect(sw["Sound effects"]).toBe(false);
  });

  test("carries every block: join, devices, walkie, sounds", async () => {
    ui = {};
    const html = await renderToMarkup(<CallSettings />);
    for (const t of ["When I join a call", "Devices", "Walkie", "Sounds", "Let teammates talk to me"]) {
      expect(html).toContain(t);
    }
    // The meeting block is the desktop's; in a browser it renders nothing.
    expect(html).not.toContain("When a meeting starts");
  });

  test("the sheet is a labelled dialog with a close", async () => {
    ui = {};
    const html = await renderToMarkup(<CallSettingsSheet onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="call-settings-heading"');
    expect(html).toContain("Call settings");
    expect(html).toContain('aria-label="Close call settings"');
  });
});
