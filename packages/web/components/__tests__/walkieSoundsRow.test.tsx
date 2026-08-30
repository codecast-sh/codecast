// The settings block that plays the walkie cues (Sounds panel).
//
// It exists because every other sound in the app answers something a person
// did or something that arrived, so nobody ever hears one deliberately and
// nobody can tell whether it is right. That is how four cues stayed four times
// too quiet until the founder said "no sound that i started recording". This
// block is the one place a cue can be heard on demand, so what is worth
// testing is that it offers every cue and that every button is live — a
// preview click is explicit intent to hear, so no switch may deaden it.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { WalkieCuesBlock } = await import("../../app/settings/sounds/page");
const { WALKIE_PREVIEWS } = await import("../../lib/sounds");

function render() {
  return renderToStaticMarkup(<WalkieCuesBlock />);
}

describe("the walkie cues block", () => {
  test("offers a preview for every cue", () => {
    const html = render();
    expect(WALKIE_PREVIEWS).toHaveLength(6);
    for (const cue of WALKIE_PREVIEWS) expect(html).toContain(`>${cue.label}<`);
  });

  test("says what each button means", () => {
    const html = render();
    // The labels are one word each, so the block has to carry the meaning.
    expect(html).toContain("your own key going down");
    expect(html).toContain("nobody was live");
  });

  test("every button is live — previews are never gated", () => {
    expect(render()).not.toContain('disabled=""');
  });

  test("plain buttons: no keycap, no emoji", () => {
    const html = render();
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(html).not.toContain("kbd");
  });
});
