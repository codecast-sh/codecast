import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { WalkieSnoozedNote, WalkieStripView } from "../calls/WalkieDock";
import { HOME_CORNER } from "../calls/callSurfacePlacement";

// THE STRIP, IN EVERY STATE IT HAS.
//
// A voice arriving out of nowhere is the biggest interruption this product
// makes, and this surface is the whole of the answer to it: who, what they are
// saying, and the two things a person does about it. So every state is rendered
// here as static markup and checked against the stylesheet that draws it —
// which is why WalkieStripView takes props and reads no store: each state is a
// combination of them, and none of them needs an engine to exist.
//
// No effect runs, no portal opens and no microphone is asked for. The questions
// are which words the card carries, which classes it puts them in, and what the
// stylesheet then does with those classes.

const css = readFileSync(new URL("../calls/walkie.css", import.meta.url), "utf8");
// WHERE the card sits belongs to the surface root now (ct-46671): the strip,
// the pill and the dock are three contents of one node, so the corner and the
// width are that node's and this file's rules are the card's alone.
const surfaceCss = readFileSync(new URL("../calls/callSurface.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../calls/WalkieDock.tsx", import.meta.url), "utf8");

/** One rule's declarations, by its exact selector. Comments dropped. */
function rule(selector: string, sheet: string = css): Record<string, string> {
  const css = sheet;
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

const noop = () => {};

const BASE = {
  name: "Riley Chen",
  stage: "incoming" as const,
  badge: "INCOMING",
  hint: "Riley Chen is talking to you. HOLD their face to reply.",
  headline: "Riley Chen is talking",
  locked: false,
  together: false,
  muted: true,
  words: "",
  face: { image: undefined, name: "Riley Chen" },
  tx: false,
  rx: false,
  hotMic: false,
  micDenied: false,
  quiet: false,
  joined: false,
  actions: true,
  onMute: noop,
  onJoin: noop,
  onSnooze: noop,
  onOpenDm: noop,
  onLeave: noop,
};

function render(over: Partial<typeof BASE> & { replyKey?: any } = {}) {
  return renderToStaticMarkup(<WalkieStripView {...BASE} {...over} />);
}

/** The key is a child the strip is handed, so the states below stand it in
 *  rather than opening a microphone to draw one. */
const key = <button type="button" className="walkie-ptt walkie-key walkie-key-lg" />;
const heldKey = <button type="button" className="walkie-ptt walkie-key walkie-key-lg walkie-ptt-on" />;

describe("a teammate is talking to me", () => {
  const html = render({
    rx: true,
    words: "so I pushed the fix and the deploy is green",
    replyKey: key,
  });

  test("says who, what is happening, and what they are saying", () => {
    expect(html).toContain("Riley Chen");
    expect(html).toContain("Riley Chen is talking");
    expect(html).toContain("so I pushed the fix and the deploy is green");
  });

  test("offers both answers in full words", () => {
    expect(html).toContain("Join live");
    expect(html).toContain("Snooze 1h");
  });

  test("wears the incoming colour and not the outgoing one", () => {
    expect(html).toContain("walkie-strip-rx");
    expect(html).not.toContain("walkie-strip-tx");
  });

  test("carries the face, the two tools and the key — each tool with its word", () => {
    expect(html).toContain("walkie-strip-face");
    expect(html).toContain('aria-label="Open the chat with them"');
    expect(html).toContain(">Chat<");
    expect(html).toContain('aria-label="Close this and leave the room"');
    expect(html).toContain(">Close<");
    expect(html).toContain("walkie-strip-reply");
  });

  test("says its state in one loud word, and what the hands do next", () => {
    // The founder's rule: bang me over the head. The badge is the first line
    // of the card and the hint is always there, whatever else the card says.
    expect(html).toContain("walkie-stage-incoming");
    expect(html).toContain(">INCOMING<");
    expect(html).toContain("walkie-strip-hint");
    expect(html).toContain("HOLD their face to reply");
  });

  test("and no emoji anywhere in it", () => {
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the card is the size of what it is saying", () => {
  test("420 wide, and never wider than the window", () => {
    const host = rule('.call-surface-root[data-shape="walkie"]', surfaceCss);
    expect(host.width).toBe("420px");
    expect(host["max-width"]).toBe("calc(100vw - 2rem)");
    // The corner is unchanged: this stands in for the dock, and the eye must
    // not have to move when a burst becomes a huddle. It is a number rather
    // than a rule now, because the dock can be dragged off it and the strip
    // cannot — 1rem in and 5rem up, as it always was.
    expect(HOME_CORNER).toEqual({ right: 16, bottom: 80 });
  });

  test("the name and the headline are 15px, not 12", () => {
    expect(rule(".walkie-strip-name")["font-size"]).toBe("15px");
    expect(rule(".walkie-strip-headline")["font-size"]).toBe("15px");
  });

  test("the words are 15px, two lines, and the LAST two", () => {
    const words = rule(".walkie-strip-words");
    expect(words["font-size"]).toBe("15px");
    expect(words["max-height"]).toBe("2.8em");
    expect(words.overflow).toBe("hidden");
    // Bottom anchored: a burst is a sentence still being spoken, so the newest
    // words are the ones that must survive the clip.
    expect(words["justify-content"]).toBe("flex-end");
    // And the beginning fades rather than being cut mid letter.
    expect(words["mask-image"]).toContain("linear-gradient");
  });

  test("both answers are full width and stacked, warm first", () => {
    const actions = rule(".walkie-strip-actions");
    expect(actions["flex-direction"]).toBe("column");
    const join = rule(".walkie-strip-join");
    expect(join.width).toBe("100%");
    expect(join.background).toBe("var(--walkie-tx)");
    const snooze = rule(".walkie-strip-snooze");
    expect(snooze.width).toBe("100%");
    expect(snooze.background).toBe("var(--sol-bg-highlight)");
  });

  test("every colour comes from a token", () => {
    const region = css.slice(css.indexOf(".walkie-strip {"), css.indexOf("/* ── The chord hint"));
    const declarations = region.replace(/\/\*[\s\S]*?\*\//g, "");
    // Black shadows are the one raw colour, and they are opacity on nothing.
    const raw = declarations.match(/#[0-9a-fA-F]{3,8}\b|\brgb\((?!0 0 0)/g);
    expect(raw).toBe(null);
  });
});

describe("the face is the first thing the eye lands on", () => {
  test("and it breathes with the voice inside it", () => {
    const face = rule(".walkie-strip-face");
    // The ring's thickness and its glow are both the level, written onto this
    // element by the engine rather than by a render.
    expect(face["--level"]).toBe("0");
    expect(face["box-shadow"]).toContain("var(--level)");
    expect(face["box-shadow"]).toContain("var(--walkie-rx)");
  });

  test("without motion for anybody who asked for none", () => {
    const reduced = css.slice(css.indexOf(".walkie-strip-face"));
    const block = reduced.slice(0, reduced.indexOf("/* ── The hot microphone"));
    expect(block).toContain("@media (prefers-reduced-motion: reduce)");
    // Still the level, carried by brightness instead of by growth.
    expect(block).toContain("calc(40% + var(--level) * 50%)");
  });

  test("at 56px, from the component and not from the stylesheet", () => {
    expect(source).toContain("const FACE = 56");
    expect(source).toContain("size={FACE}");
  });
});

describe("my microphone is open and I did not open it", () => {
  const html = render({ rx: true, hotMic: true, replyKey: key });

  test("says so at the top, with the way out beside it", () => {
    expect(html).toContain("Your mic is open, Riley Chen can hear you");
    expect(html).toContain("Mute");
    expect(html).toContain("walkie-strip-hot");
  });

  test("and one click is the whole of the way out", () => {
    // No menu, no settings page: the button is on the line that alarmed you.
    const line = html.slice(html.indexOf("walkie-hot"), html.indexOf("walkie-strip-head"));
    expect(line).toContain("walkie-hot-mute");
    expect((line.match(/<button/g) ?? []).length).toBe(1);
  });

  test("in the outgoing colour, because the voice is going OUT", () => {
    expect(rule(".walkie-hot").background).toContain("var(--walkie-tx)");
    expect(rule(".walkie-hot-mute").background).toBe("var(--walkie-tx)");
  });
});

describe("there is no microphone at all", () => {
  const html = render({
    rx: true,
    micDenied: true,
    headline: "You can hear Riley Chen — your mic is off (permission denied)",
    replyKey: key,
  });

  test("the hot line is gone: there is no open mic to warn about", () => {
    expect(html).not.toContain("walkie-hot");
    expect(html).not.toContain("Your mic is open");
  });

  test("and the headline says it instead, in the engine's own words", () => {
    expect(html).toContain("your mic is off (permission denied)");
    expect(html).toContain("walkie-strip-denied");
  });

  test("nothing on the card is warm, because nothing is going out", () => {
    expect(rule(".walkie-strip-denied")["border-color"]).toContain("var(--sol-text)");
    expect(rule(".walkie-strip-denied")["border-color"]).not.toContain("walkie-tx");
  });
});

describe("both keys are down", () => {
  const html = render({
    tx: true,
    rx: true,
    headline: "You and Riley Chen are both talking",
    replyKey: heldKey,
  });

  test("the card wears both directions rather than picking one", () => {
    expect(html).toContain("walkie-strip-tx");
    expect(html).toContain("walkie-strip-rx");
  });

  test("their cool ring on the face, my warm one on the key", () => {
    expect(html).toContain("walkie-strip-face");
    expect(html).toContain("walkie-ptt-on");
    expect(rule(".walkie-strip-face")["box-shadow"]).toContain("var(--walkie-rx)");
  });

  test("and Join live is still offered: this is exactly the moment for it", () => {
    // The old strip hid every answer while my own key was down, which took the
    // upgrade away at the one moment two people were already talking.
    expect(html).toContain("Join live");
  });

  test("while my own burst alone offers nothing to join", () => {
    const mine = render({ tx: true, actions: false, headline: "Recording — Riley Chen gets it" });
    expect(mine).not.toContain("Join live");
    expect(mine).not.toContain("Snooze 1h");
  });

  test("the stylesheet draws the pair, not one over the other", () => {
    const both = rule(".walkie-strip-tx.walkie-strip-rx");
    expect(both["border-color"]).toContain("var(--walkie-rx)");
    expect(both["box-shadow"]).toContain("var(--walkie-tx)");
  });
});

describe("somebody stepped in", () => {
  const html = render({
    rx: true,
    joined: true,
    headline: "Riley Chen joined — it's a call now",
    replyKey: key,
  });

  test("the card says it in words for the four seconds it is news", () => {
    expect(html).toContain("Riley Chen joined — it&#x27;s a call now");
    expect(html).toContain("walkie-strip-joined");
  });

  test("and it is the one violet moment on a warm and cool surface", () => {
    // Violet is what a call is everywhere else in the product, and the sentence
    // on the card at this instant is that a burst just became one.
    expect(rule(".walkie-strip-joined")["border-color"]).toContain("var(--sol-violet)");
  });

  test("read from the announcement both surfaces share", () => {
    // Never a second copy of the words: the dock says the same thing when it
    // takes over a moment later (lib/calls/joinAnnounce).
    expect(source).toContain("joinTitle(announcement, target.roomKey");
  });
});

describe("snoozed", () => {
  const html = renderToStaticMarkup(
    <WalkieSnoozedNote until={new Date("2026-08-28T15:12:00").getTime()} />,
  );

  test("says until when, and where the message went", () => {
    expect(html).toContain("Snoozed until");
    expect(html).toContain("3:12");
    expect(html).toContain("The message is in the DM");
  });

  test("wearing the strip's own skin, in the strip's own corner", () => {
    expect(html).toContain("walkie-strip walkie-strip-note");
    expect(rule(".walkie-strip-note").width).toBe("420px");
  });

  test("and the voice stops before the note is written", () => {
    // The order in the handler is the promise: the mic closes and the seat goes
    // back FIRST, then the hour is confirmed. A note that came first would be
    // three seconds of somebody still being able to hear you.
    const at = (needle: string) => source.indexOf(needle, source.indexOf("function snoozeWalkie"));
    expect(at("setMuted(true)")).toBeLessThan(at("toast.custom"));
    expect(at("shutWalkieDoor()")).toBeLessThan(at("toast.custom"));
    // And the hour itself is written through the store, which is what carries
    // it to the server and to every other window.
    expect(at("snoozeWalkie(until)")).toBeGreaterThan(-1);
  });
});

describe("the live words come from the burst, not from the open channel", () => {
  test("the strip draws whatever it is handed, with no store behind it", () => {
    // The rendered proof: these words reached the screen through props alone.
    expect(render({ rx: true, words: "the words" })).toContain("the words");
  });

  test("and the burst's own row is what is subscribed", () => {
    // The regression this replaces: the tail read the chat store, which syncs
    // per OPEN channel, so a voice arriving from a DM nobody had open showed no
    // words at all — the one case where the words were the whole point.
    expect(source).toContain("api.chat.getMessage");
    expect(source).toContain("{ message_id: messageId }");
    // Keyed on the BURST's id, so the subscription ends when the burst does.
    expect(source).toContain("useLiveWords(incoming?.messageId)");
  });

  test("cut from the front, so the newest words are the ones kept", () => {
    expect(source).toContain("`…${text.slice(-TAIL)}`");
  });
});

describe("on the line, hands free", () => {
  const html = render({
    stage: "locked",
    badge: "ON THE LINE",
    hint: "Hands free. Riley Chen hears everything you say. Press END to hang up.",
    headline: "Riley Chen hears you",
    locked: true,
    muted: false,
    actions: false,
    myFace: { image: undefined, name: "Me" },
    onMuteToggle: noop,
    onFloat: noop,
  } as any);

  test("the badge burns warm and the End button says what it does", () => {
    expect(html).toContain("walkie-stage-locked");
    expect(html).toContain(">ON THE LINE<");
    expect(html).toContain("End — hang up");
    expect(html).toContain("Float faces over my work");
  });

  test("one door: the top-right Close goes, End is the way out", () => {
    expect(html).not.toContain('aria-label="Close this and leave the room"');
  });

  test("my own face is on the card, warm, and pops in", () => {
    expect(html).toContain("walkie-strip-face-tx");
    expect(html).toContain("walkie-face-pop");
  });
});
