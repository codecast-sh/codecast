// The call settings panel: one body for the people window's sheet and the
// settings modal's Calls section. What is worth pinning is that every switch
// reads the same source the joins read (absent = on), that the sheet is a
// labelled dialog with one way out, and that nothing in it is desktop-only
// except the meeting block, which renders nothing in a browser.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mockInboxStore } from "./mockInboxStore";

let ui: Record<string, unknown> = {};
mockInboxStore((real: any) => ({ clientState: { ...(real.clientState ?? {}), ui } }));
const { CallSettings, CallSettingsSheet } = await import("../calls/CallSettings");

function switches(html: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of html.matchAll(/<button[^>]*role="switch"[^>]*>/g)) {
    const label = /aria-label="([^"]+)"/.exec(m[0])?.[1] ?? "";
    out[label] = /aria-checked="true"/.test(m[0]);
  }
  return out;
}

describe("call settings", () => {
  test("camera and mic read as ON when nothing was chosen", () => {
    ui = {};
    const sw = switches(renderToStaticMarkup(<CallSettings />));
    expect(sw["Camera on when I join"]).toBe(true);
    expect(sw["Microphone on when I join"]).toBe(true);
    expect(sw["Sound effects"]).toBe(true);
  });

  test("an explicit off is shown off", () => {
    ui = { call_camera_on: false, call_mic_on: false, sounds_enabled: false };
    const sw = switches(renderToStaticMarkup(<CallSettings />));
    expect(sw["Camera on when I join"]).toBe(false);
    expect(sw["Microphone on when I join"]).toBe(false);
    expect(sw["Sound effects"]).toBe(false);
  });

  test("carries every block: join, devices, walkie, sounds", () => {
    ui = {};
    const html = renderToStaticMarkup(<CallSettings />);
    for (const t of ["When I join a call", "Devices", "Walkie", "Sounds", "Let teammates talk to me"]) {
      expect(html).toContain(t);
    }
    // The meeting block is the desktop's; in a browser it renders nothing.
    expect(html).not.toContain("When a meeting starts");
  });

  test("the sheet is a labelled dialog with a close", () => {
    ui = {};
    const html = renderToStaticMarkup(<CallSettingsSheet onClose={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="call-settings-heading"');
    expect(html).toContain("Call settings");
    expect(html).toContain('aria-label="Close call settings"');
  });
});
