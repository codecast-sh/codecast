// THE FLOAT HAS ITS CONTROLS. The voice window hosts the floating row, and
// the row draws Move, Open and Close or Hide only when its host hands them
// in. On 2026-09-23 the row grew the chrome and the host never passed it, so
// the founder's float had no way to move or close. A source read, because
// mounting the host needs the shell, the store and a room; the row's own
// mount test proves the chrome it is given renders and works.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "VoiceHostPanel.tsx"), "utf8");

describe("the voice window's float", () => {
  test("hands the row its chrome: a way to move, open the call and put it away", () => {
    const float = src.slice(src.indexOf("<FloatingFaceRow"), src.indexOf("</FloatingFaceRow>"));
    expect(float).toContain("chrome={{");
    for (const key of ["onExpand: openCall", "onClose: closeFloat", "closeWord", "closeTitle"]) {
      expect(float, key).toContain(key);
    }
    // Open follows the row's call, not this window's slice: a call another
    // window holds draws a live card here with this window's slice idle
    // (2026-10-03, Open missing beside a live huddle). Held nowhere on this
    // machine, it raises the window that has it or comes here.
    expect(src).toContain("const rowCall = callRoomOf(row)");
    const open = src.slice(src.indexOf("const openCall"), src.indexOf("const ringIn"));
    expect(open).toContain("showCallPanel()");
    expect(open).toContain("takeOverCall(");
    // Close puts a popped out row back; Hide dismisses an engagement's float
    // until the next one, and the view reads that flag.
    expect(src).toContain("floating.setFloating(false)");
    expect(src).toContain("setDismissed(true)");
    expect(src).toMatch(/voiceHostView\(\{[\s\S]*?dismissed: dismissed \|\| docking,[\s\S]*?\}\)/);
  });

  test("docking holds the float down until the app has focus, from either window", () => {
    // The Dock click focuses the voice window, not the app, so a call in
    // progress read as "happening while the app is behind" and the float
    // stayed up under the pointer that had just docked it (founder,
    // 2026-09-28: "i can't minimize it back into the header"). The host
    // watches the pop out flag fall, so the header's chip docks the same way.
    // Only until the app has focus: after that, leaving the app mid-call
    // brings the float back as it always did.
    const dock = src.slice(src.indexOf("const [docking"), src.indexOf("const closeFloat"));
    expect(dock).toContain("setDocking(true)");
    expect(dock).toMatch(/role\.appFocused && docking\) setDocking\(false\)/);
    expect(src).toContain("dismissed: dismissed || docking");
    const float = src.slice(src.indexOf("<FloatingFaceRow"), src.indexOf("</FloatingFaceRow>"));
    expect(float).toContain("docks: floating.floating");
  });

  test("expand from any window is the float's own Expand, and it raises the stage", () => {
    // The call card's expand reaches the host as a command. It runs openCall,
    // so a call this window does not hold is taken over the same way, and it
    // bumps the raise: expanding a stage already open behind the app changed
    // no state, so nothing moved and the button read as dead (2026-10-05).
    expect(src).toContain("onHostExpand(() => openCallRef.current())");
    const open = src.slice(src.indexOf("const openCall"), src.indexOf("const ringIn"));
    expect(open).toContain("setRaised((n) => n + 1)");
    expect(src).toMatch(/if \(raised && view === "panel"\) void showCallPanel\(\);\n {2}\}, \[view, raised\]\);/);
  });

  test("the stage has one way back, shrink", () => {
    expect(src).toContain("<CallStage panel onShrink={shrink} />");
  });
});
