// The transcript's virtual rows are placed by `top`, never by a 3D transform.
// @tanstack/react-virtual's direct DOM mode defaults to translate3d, which makes
// every visible row its own compositor layer; the browser then re-layers the
// page on each frame that moves the caret, so every keystroke in the composer
// paid for every visible message.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("ConversationView's virtualizer writes row positions as top, not translate3d", () => {
  const src = readFileSync(new URL("../ConversationView.tsx", import.meta.url), "utf8");
  const call = src.slice(src.indexOf("useVirtualizer({"), src.indexOf("useVirtualizer({") + 600);
  expect(call).toContain("directDomUpdates: true");
  expect(call).toContain('directDomUpdatesMode: "position"');
});
