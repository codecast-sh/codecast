// The settings row that plays the walkie cues.
//
// It exists because every other sound in the app answers something a person
// did or something that arrived, so nobody ever hears one deliberately and
// nobody can tell whether it is right. That is how four cues stayed four times
// too quiet until the founder said "no sound that i started recording". This
// row is the one place a cue can be heard on demand, so what is worth testing
// is that it offers every cue and never offers a dead button.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The store is handed to the row rather than read from it — see
// mockInboxStore for why the substitution is needed and why it inherits the
// real state instead of inventing one.
let soundsEnabled = true;
const { mockInboxStore } = await import("./mockInboxStore");
mockInboxStore((s) => ({
  clientState: { ...s.clientState, ui: { ...s.clientState?.ui, sounds_enabled: soundsEnabled } },
}));

const { WalkieSoundsRow } = await import("../../app/settings/profile/page");
const { WALKIE_PREVIEWS } = await import("../../lib/sounds");

function renderWith(enabled: boolean) {
  soundsEnabled = enabled;
  try {
    return renderToStaticMarkup(<WalkieSoundsRow />);
  } finally {
    soundsEnabled = true;
  }
}

describe("the Walkie sounds row", () => {
  test("offers a preview for every cue", () => {
    const html = renderWith(true);
    expect(WALKIE_PREVIEWS).toHaveLength(6);
    for (const cue of WALKIE_PREVIEWS) expect(html).toContain(`>${cue.label}<`);
  });

  test("names itself and says what each button is", () => {
    const html = renderWith(true);
    expect(html).toContain("Walkie sounds");
    // The labels are one word each, so the row has to carry the meaning.
    expect(html).toContain("your own key going down");
    expect(html).toContain("nobody was live");
  });

  test("the buttons go dead when sound effects are off, and say why", () => {
    // A live button that makes no sound reads as a broken sound. The master
    // switch sits in the same card, so the row can point at it instead.
    //
    // Matching the attribute rather than the word: the button's class list
    // carries `disabled:opacity-50` whether or not it is disabled.
    const html = renderWith(false);
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(WALKIE_PREVIEWS.length);
    expect(html).toContain("Turn on sound effects above");
  });

  test("the buttons are live when sound effects are on", () => {
    expect(renderWith(true)).not.toContain('disabled=""');
  });

  test("plain buttons: no keycap, no emoji", () => {
    const html = renderWith(true);
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(html).not.toContain("kbd");
  });
});
