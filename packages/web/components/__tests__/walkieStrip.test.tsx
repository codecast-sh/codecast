import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { EngagementCard } from "../faces/EngagementCard";
import type { FaceCard } from "../../lib/faces/faceRow";
import { walkieStageWords } from "../../hooks/useWalkie";

// THE CARD, IN EVERY STATE IT HAS (pl-756 F3).
//
// A voice arriving out of nowhere is the biggest interruption this product
// makes, and the engagement card under the face row is the whole of the
// answer to it: what is happening, in one loud word, and the things a person
// does about it. The walkie strip that used to be that answer retired with
// this wave; the card wears the strip's skin (calls/walkie.css), so every
// state is rendered here as static markup and checked against the stylesheet
// that draws it. No store, no engine, no microphone: the model hands the card
// in, and the card decides no word of it.

const css = readFileSync(new URL("../calls/walkie.css", import.meta.url), "utf8");
const rowCss = readFileSync(new URL("../faces/faceRow.css", import.meta.url), "utf8");

/** One rule's declarations, by its exact selector. Comments dropped. */
function rule(selector: string, sheet: string = css): Record<string, string> {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, `${selector} is in the sheet`).toBeGreaterThan(-1);
  const body = sheet.slice(at + selector.length + 3, sheet.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, " ");
  }
  return out;
}

const ROOM = "dm:u-ann:u-me";
const NAME = "Riley Chen";
const noop = () => {};
const actions = { join: noop, snooze: noop, end: noop, mute: noop, answer: noop, decline: noop, cancel: noop };

function render(card: FaceCard, density: "bar" | "float" = "bar") {
  return renderToStaticMarkup(<EngagementCard card={card} density={density} actions={actions} />);
}

const words = (over: Partial<Parameters<typeof walkieStageWords>[0]> = {}) =>
  walkieStageWords({ sending: null, incoming: true, locked: false, muted: true, dropped: false, micDenied: false, name: NAME, ...over });

// `reply: false` here: the talk back key is a live control (usePushToTalk)
// and cannot be rendered to a string; the row's mount test draws it for real.
const incoming: FaceCard = { kind: "incoming", roomKey: ROOM, from: "u-ann", name: NAME, reply: false, join: true, snooze: true, words: words() };

describe("a teammate is talking to me", () => {
  const html = render(incoming);

  test("says its state in one loud word, and what the hands do next", () => {
    // The founder's rule: bang me over the head. The badge is the first line
    // of the card and the hint is always there, whatever else the card says.
    expect(html).toContain("walkie-stage-incoming");
    expect(html).toContain(">INCOMING<");
    expect(html).toContain("walkie-strip-hint");
    expect(html).toContain("TALK to answer");
  });

  test("offers both answers in full words", () => {
    expect(html).toContain("Join live");
    expect(html).toContain("Snooze for an hour");
    expect(html).toContain('data-card-action="join"');
    expect(html).toContain('data-card-action="snooze"');
  });

  test("wears the incoming colour and not the outgoing one", () => {
    expect(html).toContain("walkie-strip-rx");
    expect(html).not.toContain("walkie-strip-tx");
  });

  test("and no emoji anywhere in it", () => {
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the card is the size of what it is saying", () => {
  test("320 wide in the header, never wider than the window, riding in the band under the row", () => {
    const card = rule(".engagement-card", rowCss);
    expect(card.width).toBe("320px");
    expect(card["max-width"]).toBe("calc(100vw - 2rem)");
    // The band (.face-row-below) is what hangs from the row, at both
    // densities (faces/__tests__/faceRowLayout pins it); the card stays in
    // flow inside it, so it never wraps the seats and never hangs twice.
    expect(rule('.engagement-card[data-density="bar"]', rowCss).position).toBe("relative");
    expect(rule('.engagement-card[data-density="float"]', rowCss).position).toBe("relative");
  });

  test("the answers are full width and stacked, warm first", () => {
    const actions = rule(".walkie-strip-actions");
    expect(actions["flex-direction"]).toBe("column");
    const join = rule(".walkie-strip-join");
    expect(join.width).toBe("100%");
    expect(join.background).toBe("var(--walkie-tx)");
    const snooze = rule(".walkie-strip-snooze");
    expect(snooze.width).toBe("100%");
    expect(snooze.background).toBe("var(--sol-bg-highlight)");
    const end = rule(".walkie-strip-end");
    expect(end.width).toBe("100%");
    expect(end.background).toBe("var(--sol-red)");
  });

  test("every colour comes from a token", () => {
    const region = css.slice(css.indexOf(".walkie-strip {"), css.indexOf("/* ── The chord hint"));
    const declarations = region.replace(/\/\*[\s\S]*?\*\//g, "");
    // Black shadows are the one raw colour, and they are opacity on nothing.
    const raw = declarations.match(/#[0-9a-fA-F]{3,8}\b|\brgb\((?!0 0 0)/g);
    expect(raw).toBe(null);
  });

  test("the strip's own furniture is gone with it: no face, no words, no tools", () => {
    for (const dead of [".walkie-strip-face", ".walkie-strip-words", ".walkie-strip-tools", ".walkie-strip-head", ".walkie-hot", ".walkie-strip-note", ".walkie-strip-float", ".walkie-strip-stop"]) {
      expect(css, `${dead} retired`).not.toContain(`\n${dead} {`);
    }
    // The pop the row plays when somebody steps in stays.
    expect(css).toContain("@keyframes walkie-face-pop");
  });
});

describe("there is no microphone at all", () => {
  const html = render({ ...incoming, words: words({ micDenied: true }) });

  test("the badge says it, in the engine's own words, and nothing warm is on the card", () => {
    expect(html).toContain(">MIC OFF<");
    expect(html).toContain("walkie-strip-denied");
    expect(html).not.toContain("walkie-strip-tx");
    expect(rule(".walkie-strip-denied")["border-color"]).toContain("var(--sol-text)");
    expect(rule(".walkie-strip-denied")["border-color"]).not.toContain("walkie-tx");
  });

  test("and nothing to answer with: no key", () => {
    expect(html).not.toContain("walkie-ptt");
  });
});

const live = (over: Partial<Extract<FaceCard, { kind: "live" }>> = {}): FaceCard => ({
  kind: "live", roomKey: ROOM, title: NAME, end: true, mute: false, muted: false, words: null, hearing: null, ...over,
});

describe("talking, one way", () => {
  const html = render(live({ words: words({ sending: { live: true, heardLive: true }, incoming: false }) }));

  test("the badge burns warm and the card carries End", () => {
    expect(html).toContain(">TALKING<");
    expect(html).toContain("walkie-strip-tx");
    expect(html).not.toContain("walkie-strip-rx");
    expect(html).toContain(">End<");
    expect(html).toContain("walkie-strip-end");
  });

  test("a burst offers nothing to join and no mute: my own key is the only control", () => {
    expect(html).not.toContain("Join live");
    expect(html).not.toContain("walkie-strip-mute");
  });
});

describe("both keys are down", () => {
  const html = render(live({ words: words({ sending: { live: true, heardLive: true }, incoming: true }) }));

  test("the card wears both directions rather than picking one", () => {
    expect(html).toContain(">BOTH TALKING<");
    expect(html).toContain("walkie-strip-tx");
    expect(html).toContain("walkie-strip-rx");
  });

  test("the stylesheet draws the pair, not one over the other", () => {
    const both = rule(".walkie-strip-tx.walkie-strip-rx");
    expect(both["border-color"]).toContain("var(--walkie-rx)");
    expect(both["box-shadow"]).toContain("var(--walkie-tx)");
  });
});

describe("on the line, hands free", () => {
  const html = render(live({ mute: true, words: words({ locked: true, muted: false, incoming: false }) }));

  test("the badge says so, and End and Mute are both there, full width", () => {
    expect(html).toContain("walkie-stage-locked");
    expect(html).toContain(">ON THE LINE<");
    expect(html).toContain(">End<");
    expect(html).toContain(">Mute<");
    expect(rule(".walkie-strip-mute").width).toBe("100%");
  });

  test("muted says so on the badge and on the button", () => {
    const muted = render(live({ mute: true, muted: true, words: words({ locked: true, muted: true, incoming: false }) }));
    expect(muted).toContain("MUTED");
    expect(muted).toContain(">Unmute<");
    expect(muted).toContain("walkie-strip-mute-on");
    expect(rule(".walkie-strip-mute-on").color).toBe("var(--sol-red)");
  });
});

describe("in a huddle", () => {
  const html = render(live({ title: "#design", mute: true, hearing: { state: "hearing", text: "Riley hears you" } as any }));

  test("the room's name leads, the roster's word on who hears me follows, End and Mute close it", () => {
    expect(html).toContain("engagement-card-title");
    expect(html).toContain("#design");
    expect(html).toContain("Riley hears you");
    expect(html).toContain(">End<");
    expect(html).toContain(">Mute<");
    // No walkie stage on an ordinary huddle: the room's name is the headline.
    expect(html).not.toContain("walkie-stage-badge");
  });
});

describe("somebody stepped in", () => {
  const html = render({ kind: "joined-notice", roomKey: ROOM, text: "Riley Chen joined, it is a call now", end: true, mute: true, muted: false });

  test("the card says it in words, with the live controls still under it", () => {
    expect(html).toContain("Riley Chen joined, it is a call now");
    expect(html).toContain("walkie-strip-headline-lead");
    expect(html).toContain("walkie-strip-joined");
    expect(html).toContain(">End<");
  });

  test("and it is the one violet moment on a warm and cool surface", () => {
    // Violet is what a call is everywhere else in the product, and the sentence
    // on the card at this instant is that a burst just became one.
    expect(rule(".walkie-strip-joined")["border-color"]).toContain("var(--sol-violet)");
  });
});

describe("a ring", () => {
  test("in: who, the word, and the two answers in the ring card's own buttons", () => {
    const html = render({ kind: "ring-in", roomKey: ROOM, from: "u-ann", name: NAME, answer: true, decline: true });
    expect(html).toContain(NAME);
    expect(html).toContain("Incoming huddle");
    expect(html).toContain("ring-card-join");
    expect(html).toContain("ring-card-decline");
  });

  test("out: who, the status, and a cancel", () => {
    const html = render({ kind: "ring-out", roomKey: ROOM, to: "u-ann", name: NAME, cancel: true, status: "ringing" });
    expect(html).toContain(NAME);
    expect(html).toContain("Ringing");
    expect(html).toContain(">Cancel<".replace(">", ""));
    expect(html).toContain('data-card-action="cancel"');
  });
});

describe("nothing", () => {
  test("renders nothing at all", () => {
    expect(render({ kind: "none" })).toBe("");
  });
});
