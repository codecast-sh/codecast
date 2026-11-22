// ONE PRESS OF BACK IS ONE STEP BACK (ct-98092).
//
// In the desktop app, Back (⌘[ on a Mac, Alt+← elsewhere) walks Modern's nav
// trail. A key held a moment past the system's key-repeat delay sends a
// second keydown with `repeat: true`. Nothing swallowed that repeat, so one
// press from a chat opened over conversation A went back to A and then, 0.3s
// later, on to B, the conversation before it (replay rp-16212 at 4:33: nav
// /inbox?s=A, /conversation/A, /conversation/B, one window keydown).
//
// The handler here walks the real trail the way goBackInTrail does: Back
// goes to the entry below the place on screen, and arriving there pops it.
// Run: cd packages/web && bun test shortcuts/__tests__/navBackHeld.test.ts
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/chat/hx7chat" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage });
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const { createKeydownHandler, ShortcutDispatcher } = await import("@platform/keys");
const { shortcutCatalog } = await import("../registry");
const { KEY_OWNERSHIP } = await import("../keyOwnership");
const { backEntry, recordTrail, trailOf, _resetTrailForTests } = await import("../../lib/navTrail");

const A = "/inbox?s=jx765h5n77wmm0jk9z72at93kn8jgx9y";
const B = "/inbox?s=jx7etyd2b961e2wzxx7zvs2ss98gzxh9";
const CHAT = "/chat/hx7tv3hz9553rss8zvkqc2dbx58j48bd";
const TAB = "tab_main";

// The Back key's own chord on this platform, as a keydown.
function backKey(repeat: boolean): KeyboardEvent {
  const def = shortcutCatalog.shortcuts.find((d) => d.action === "nav.back")!;
  const chord = (shortcutCatalog.isMac ? def.mac ?? def.key : def.key).split("+");
  const key = chord.pop()!;
  return new dom.window.KeyboardEvent("keydown", {
    key: key === "arrowleft" ? "ArrowLeft" : key,
    metaKey: chord.includes("meta"),
    altKey: chord.includes("alt"),
    ctrlKey: chord.includes("ctrl"),
    shiftKey: chord.includes("shift"),
    repeat,
    bubbles: true,
    cancelable: true,
  }) as unknown as KeyboardEvent;
}

test("Back held past the key-repeat delay takes one step, not two", () => {
  dom.window.sessionStorage.clear();
  _resetTrailForTests();
  // Conversation B, then A (B stashed, the inbox moved on to A), then the
  // Line lead's chat opened from the rail.
  recordTrail(TAB, B, "push");
  recordTrail(TAB, A, "push");
  recordTrail(TAB, CHAT, "push");

  let shown = CHAT;
  const dispatcher = new ShortcutDispatcher<string>();
  dispatcher.setContext("desktop", true);
  dispatcher.register("nav.back", () => {
    const dest = backEntry(trailOf(TAB), shown);
    if (!dest) return;
    recordTrail(TAB, dest.path, "back");
    shown = dest.path;
  });
  const handle = createKeydownHandler(shortcutCatalog as any, dispatcher, KEY_OWNERSHIP as any);

  // One press: the keydown, then the auto-repeat the held key sends.
  handle(backKey(false));
  expect(shown).toBe(A);
  handle(backKey(true));

  expect(shown).toBe(A);
  expect(trailOf(TAB).map((e) => e.path)).toEqual([B, A]);
});
