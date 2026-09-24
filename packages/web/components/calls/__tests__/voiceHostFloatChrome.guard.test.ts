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
    for (const key of ["inCall", "onExpand: expand", "onClose: closeFloat", "closeWord", "closeTitle"]) {
      expect(float, key).toContain(key);
    }
    // Close puts a popped out row back; Hide dismisses an engagement's float
    // until the next one, and the view reads that flag.
    expect(src).toContain("floating.setFloating(false)");
    expect(src).toContain("setDismissed(true)");
    expect(src).toMatch(/voiceHostView\(\{[\s\S]*?dismissed,[\s\S]*?\}\)/);
  });
});
