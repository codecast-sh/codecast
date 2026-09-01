import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { FaceCircle } from "../calls/FaceCircle";
import { CHROME_BUTTON, CHROME_BUTTON_W, TIER_DIAMETER, type FacePerson } from "../../lib/calls/faceCrop";

// The circles are the call as most people will see it most of the time: a face
// floating over their work. What makes that read as a person rather than as a
// widget is what the circle does NOT draw — so the absence is what is pinned
// here, in the markup and in the stylesheet that decides it.
//
// Static markup and CSS text, deliberately. No effect runs, no video attaches
// and no detector is asked for: the questions are which attributes the circle
// carries and which rules the stylesheet applies to them.

const riley: FacePerson = {
  id: "riley",
  name: "Riley Chen",
  image: undefined,
  isLocal: false,
  muted: false,
  hasVideo: false,
};

const noop = () => {};

function render(person: FacePerson, speaking: boolean) {
  return renderToStaticMarkup(
    <FaceCircle
      person={person}
      diameter={TIER_DIAMETER.row}
      speaking={speaking}
      shown
      onPointerDown={noop}
      onPointerUp={noop}
    />,
  );
}

const css = readFileSync(new URL("../calls/faces.css", import.meta.url), "utf8");

/** One rule's declarations, by its exact selector. Comments dropped. */
function rule(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const body = css.slice(at + selector.length + 3, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, " ");
  }
  return out;
}

describe("a circle at rest", () => {
  const html = render(riley, false);

  test("carries no ring, no shadow and no speaking mark", () => {
    expect(html).not.toContain("data-speaking");
    expect(html).not.toContain("face--speaking");
    expect(html).not.toContain("box-shadow");
    // The class list is the circle, whether it is shown, and nothing else.
    expect(html).toContain('class="face face--shown"');
    // The slot is the circle's square and nothing more.
    expect(html).toContain('class="face-slot"');
  });

  test("and the stylesheet gives that class nothing to draw with", () => {
    const face = rule(".face");
    expect(face["box-shadow"]).toBeUndefined();
    expect(face.border).toBeUndefined();
    expect(face.outline).toBeUndefined();
  });
});

describe("a circle whose person is talking", () => {
  const html = render(riley, true);

  test("says so as an attribute", () => {
    expect(html).toContain('data-speaking="true"');
  });

  test("and that attribute is what the cyan ring and its glow hang on", () => {
    const speaking = rule('.face[data-speaking="true"]');
    expect(speaking["box-shadow"]).toContain("0 0 0 3px var(--sol-cyan)");
    expect(speaking["box-shadow"]).toContain(
      "0 0 14px color-mix(in srgb, var(--sol-cyan) 40%, transparent)",
    );
    // Fast in, slow out: the ring lands on the first syllable and does not
    // flicker through the gaps between words.
    expect(speaking.transition).toContain("box-shadow 120ms ease");
    expect(rule(".face").transition).toContain("box-shadow 400ms ease");
  });

  test("and reduced motion keeps the ring but drops the easing", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain('.face[data-speaking="true"]');
    expect(reduced).toContain("transition: none");
  });
});

describe("the name", () => {
  const html = render(riley, false);

  test("is in the markup so hovering costs no re-render", () => {
    expect(html).toContain('<span class="face-name">Riley</span>');
  });

  test("but is invisible until the pointer is on that face", () => {
    expect(rule(".face-name").opacity).toBe("0");
    expect(rule(".face-slot:hover .face-name").opacity).toBe("1");
  });

  test("and sits under the circle, never on it", () => {
    // `top: 100%` of the slot is the first pixel below the face. This is why
    // the slot exists: inside the circle the name would be clipped by the disc,
    // and printed across the chin it would be a caption on somebody's face.
    expect(rule(".face-name").top).toBe("calc(100% + 4px)");
  });

  test("and never sits on a permanent gradient plate", () => {
    expect(rule(".face-name").background).not.toContain("linear-gradient");
  });
});

describe("muted", () => {
  test("is a badge on the person, never a second ring", () => {
    const html = render({ ...riley, muted: true }, false);
    expect(html).toContain('class="face-mute"');
    expect(html).not.toContain("data-speaking");
    const mute = rule(".face-mute");
    expect(mute.bottom).toBe("5%");
    expect(mute.right).toBe("5%");
  });
});

describe("camera off", () => {
  test("shows the avatar cropped to the same circle", () => {
    const html = render({ ...riley, image: "https://example.com/riley.png" }, true);
    expect(html).toContain('class="face-avatar-img"');
    // Same circle, same ring: a person with their camera off is still somebody
    // you are talking to.
    expect(html).toContain('data-speaking="true"');
    expect(rule(".face-avatar-img,\n.face-avatar-fallback")["object-fit"]).toBe("cover");
  });
});

describe("the hover chrome", () => {
  test("reserves nothing, and sits in a row under the circles", () => {
    const chrome = rule(".faces-chrome");
    expect(chrome.position).toBe("absolute");
    expect(chrome.opacity).toBe("0");
    // Anchored to the bottom of the window, which hovering has just grown by
    // HOVER_ROWS — so the row is under the faces rather than over them.
    expect(chrome.bottom).toBe("8px");
    expect(rule(".faces-window--hover .faces-chrome").opacity).toBe("1");
  });

  test("and the circles stay at the top while the window grows under them", () => {
    expect(rule(".faces-window")["justify-content"]).toBe("flex-start");
  });

  // The shell sizes the window from these constants BEFORE the chrome is
  // drawn, so a stylesheet that disagrees with them clips the buttons.
  test("its buttons are exactly the size the window is sized for", () => {
    expect(rule(".faces-btn").width).toBe(`${CHROME_BUTTON_W}px`);
    expect(rule(".faces-btn").height).toBe(`${CHROME_BUTTON}px`);
  });

  test("and every button carries its word, not just an icon", () => {
    // A circle floating over somebody's work has nowhere else to say what a
    // button does, so the word is part of the button rather than a tooltip.
    expect(rule(".faces-btn-word")["font-size"]).toBeDefined();
    expect(rule(".faces-btn-word")["white-space"]).toBe("nowrap");
  });
});

describe("the tracking line the settings show", () => {
  test("says centered where the browser has no detector", async () => {
    // bun is such a browser, which is exactly the case worth pinning: the two
    // pictures look alike at a glance, so the honest line is the whole feature.
    const { faceTrackingNote } = await import("../calls/useFaceCrop");
    expect(faceTrackingNote()).toBe("Face tracking: centered (detector unavailable)");
  });
});
