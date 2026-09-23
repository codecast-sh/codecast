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

  test("says who is talking to me in one plain sentence, and nothing under it", () => {
    // One line under the faces: the founder's "this is too much" was the loud
    // word, the caption plate and the stacked buttons of the corner strip.
    expect(html).toContain("walkie-stage-incoming");
    expect(html).toContain(`${NAME} is talking to you`);
    expect(html).not.toContain("INCOMING");
    expect(html).not.toContain("TALK to answer");
  });

  test("offers both answers as words beside the line", () => {
    expect(html).toContain("Join live");
    expect(html).toContain(">Snooze<");
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
  test("as wide as its words and buttons, never wider than the window, riding in the band under the row", () => {
    const card = rule(".engagement-card", rowCss);
    expect(card.width).toBe("max-content");
    expect(card["max-width"]).toBe("min(500px, calc(100vw - 2rem))");
    expect(card.display).toBe("flex");
    expect(card["border-radius"]).toBe("999px");
    // The band (.face-row-below) is what hangs from the row, at both
    // densities (faces/__tests__/faceRowLayout pins it); the card stays in
    // flow inside it, so it never wraps the seats and never hangs twice.
    expect(rule('.engagement-card[data-density="bar"]', rowCss).position).toBe("relative");
    expect(rule('.engagement-card[data-density="float"]', rowCss).position).toBe("relative");
  });

  test("the answers are pills in a row beside the words, the strip's colours kept", () => {
    const actions = rule(".engagement-card .walkie-strip-actions,\n.engagement-card .ring-card-actions", rowCss);
    expect(actions["flex-direction"]).toBe("row");
    expect(actions.margin).toBe("0");
    const pill = rule(".engagement-card :is(.walkie-strip-end, .walkie-strip-mute, .walkie-strip-join, .walkie-strip-snooze, .ring-card-join, .ring-card-decline)", rowCss);
    expect(pill.width).toBe("auto");
    expect(pill.height).toBe("26px");
    expect(pill["border-radius"]).toBe("999px");
    // The colours still say what they said on the strip.
    expect(rule(".walkie-strip-join").background).toBe("var(--walkie-tx)");
    expect(rule(".walkie-strip-end").background).toBe("var(--sol-red)");
    // No caption plate under the line.
    expect(rule(".engagement-card .walkie-strip-hint", rowCss).background).toBe("none");
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
    expect(html).toContain(">Mic off<");
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
    expect(html).toContain(">Talking<");
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
    expect(html).toContain(">Both talking<");
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

  test("the badge says so, and End and Mute are both there, beside it", () => {
    expect(html).toContain("walkie-stage-locked");
    expect(html).toContain(">On the line<");
    expect(html).toContain("End</button>");
    expect(html).toContain("Mute</button>");
    expect(rule(".engagement-card .walkie-strip-mute,\n.engagement-card .walkie-strip-snooze,\n.engagement-card .ring-card-decline", rowCss).background).toBe("transparent");
  });

  test("muted says so on the button, once", () => {
    const muted = render(live({ mute: true, muted: true, words: words({ locked: true, muted: true, incoming: false }) }));
    // The red Unmute button is the muted mark; the line does not say it twice.
    expect(muted).not.toContain("muted");
    expect(muted).toContain(">On the line<");
    expect(muted).toContain("Unmute</button>");
    expect(muted).toContain("walkie-strip-mute-on");
    expect(rule(".engagement-card .walkie-strip-mute-on", rowCss).color).toBe("var(--sol-red)");
  });
});

describe("in a huddle", () => {
  const html = render(live({ title: "#design", mute: true, hearing: { state: "hearing", text: "Riley hears you" } as any }));

  test("the room's name leads, the roster's word on who hears me follows, End and Mute close it", () => {
    expect(html).toContain("engagement-card-title");
    expect(html).toContain("#design");
    expect(html).toContain("Riley hears you");
    expect(html.indexOf("engagement-card-title")).toBeLessThan(html.indexOf("Riley hears you"));
    expect(html).toContain("End</button>");
    expect(html).toContain("Mute</button>");
    // No walkie word on an ordinary huddle: the room's name is the line.
    expect(html).not.toContain("walkie-stage-badge");
  });
});

describe("somebody stepped in", () => {
  const html = render({ kind: "joined-notice", roomKey: ROOM, text: "Riley Chen joined, it is a call now", end: true, mute: true, muted: false });

  test("the card says it in words, with the live controls still under it", () => {
    expect(html).toContain("Riley Chen joined, it is a call now");
    expect(html).toContain("walkie-strip-headline-lead");
    expect(html).toContain("walkie-strip-joined");
    expect(html).toContain("End</button>");
  });

  test("and it is violet, the call's colour, which the line held open after it shares", () => {
    // Violet is what a call is everywhere else in the product: the seats on
    // the row wear it, so the joined notice and ON THE LINE under them do too.
    const edge = rule(".walkie-strip-joined,\n.walkie-strip-call");
    expect(edge["border-color"]).toContain("var(--sol-violet)");
    expect(rule(".walkie-stage-locked   ")["--stage-tone"]).toBe("var(--sol-violet)");
  });
});

describe("on the line, the card is the seats' violet", () => {
  const html = render(live({ mute: true, words: words({ locked: true, muted: false, incoming: false }) }));

  test("the edge is the call's, not the warm one a burst wears", () => {
    expect(html).toContain("walkie-strip-call");
    expect(html).not.toContain("walkie-strip-tx");
  });
});

describe("a ring", () => {
  test("in: who, the word, and the two answers in the ring card's own buttons", () => {
    const html = render({ kind: "ring-in", roomKey: ROOM, from: "u-ann", name: NAME, answer: true, decline: true });
    expect(html).toContain(`${NAME}</span> is calling`);
    expect(html).toContain("ring-card-join");
    expect(html).toContain("ring-card-decline");
  });

  test("out: who, the status, and a cancel in the ring card's own button", () => {
    const html = render({ kind: "ring-out", roomKey: ROOM, to: "u-ann", name: NAME, cancel: true, status: "ringing" });
    expect(html).toContain(NAME);
    expect(html).toContain("Ringing");
    expect(html).toContain(">Cancel<".replace(">", ""));
    expect(html).toContain('data-card-action="cancel"');
    // The two phone cards share one button family: Cancel is Decline's
    // button, not the walkie strip's Snooze plate.
    expect(html).toContain("ring-card-decline");
    expect(html).not.toContain("walkie-strip-snooze");
  });
});

describe("nothing", () => {
  test("renders nothing at all", () => {
    expect(render({ kind: "none" })).toBe("");
  });
});
