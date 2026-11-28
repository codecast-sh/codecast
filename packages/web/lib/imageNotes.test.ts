import { describe, expect, test } from "bun:test";
import { hideMarkerPoints, messageImageNotes, parseImageNotes } from "./imageNotes";
import { formatPendingComments } from "./quoteFormat";
import { markerLayout } from "./markedImage";

const pin = (id: string, src: string, x: number, y: number, body: string, quote = "") => ({
  id, quote, body, image: { src, point: { x, y } },
});

describe("parseImageNotes", () => {
  test("reads back what a send wrote: each picture's notes, numbers and points", () => {
    const comments = [
      pin("a", "blob:one", 0.26, 0.4, "make this bigger", "Image returned by your Read call"),
      pin("b", "blob:one", 0.9, 0.05, "wrong color\nshould be blue"),
      pin("c", "blob:two", 0.5, 0.5, "cut this"),
    ];
    const text = formatPendingComments(comments, new Map([["a", 1], ["b", 1], ["c", 2]]), new Map([["a", 1], ["b", 2], ["c", 1]]));
    const notes = parseImageNotes(`${text}\n\nand also fix the header`);
    expect(notes.get(1)).toEqual([
      { number: 1, body: "make this bigger", point: { x: 0.26, y: 0.4 } },
      { number: 2, body: "wrong color\nshould be blue", point: { x: 0.9, y: 0.05 } },
    ]);
    // The last note stops where the person's own reply begins.
    expect(notes.get(2)).toEqual([{ number: 1, body: "cut this", point: { x: 0.5, y: 0.5 } }]);
  });

  test("a note runs to the next quote, paragraphs and all", () => {
    const text = "> [Image 1] at marker 1 (10% from the left, 20% from the top)\n\nfirst\n\nsecond\n\n> some other quote\n\nreply";
    expect(parseImageNotes(text).get(1)).toEqual([{ number: 1, body: "first\n\nsecond", point: { x: 0.1, y: 0.2 } }]);
  });

  test("a message sent before points were written gives its notes without one", () => {
    expect(parseImageNotes("> [Image 2] at marker 3\n\nold note").get(2)).toEqual([{ number: 3, body: "old note" }]);
  });

  test("other quotes and plain text give nothing", () => {
    expect(parseImageNotes("> a paragraph quote\n\nmy reply").size).toBe(0);
    expect(parseImageNotes("look at [Image 1] at marker 2 please").size).toBe(0);
  });
});

test("a point near the edge reads back close enough to put the hover area on the badge's side", () => {
  const text = formatPendingComments([pin("a", "blob:one", 0.9294, 0.0731, "edge")], new Map([["a", 1]]), new Map([["a", 1]]));
  expect(text).toStartWith("> [Image 1] at marker 1 (92.9% from the left, 7.3% from the top)");
  const back = parseImageNotes(text).get(1)![0].point!;
  for (const [w, h] of [[1000, 1000], [1600, 900], [400, 2000]]) {
    const drawn = markerLayout({ x: 0.9294, y: 0.0731 }, w, h);
    const hover = markerLayout(back, w, h);
    expect([hover.dx, hover.dy]).toEqual([drawn.dx, drawn.dy]);
    expect(Math.abs(hover.bx - drawn.bx)).toBeLessThan(drawn.r);
  }
});

describe("messageImageNotes", () => {
  const message = {
    content: "> [Image 2] at marker 1 (50% from the left, 50% from the top)\n\nthis one",
    images: [
      { storage_id: "tool", tool_use_id: "t1" },
      { storage_id: "s1" },
      { storage_id: "s2" },
    ],
  };
  test("finds a picture's notes by its stored file, counting only attached pictures", () => {
    expect(messageImageNotes(message, "s2")).toEqual([{ number: 1, body: "this one", point: { x: 0.5, y: 0.5 } }]);
    expect(messageImageNotes(message, "s1")).toEqual([]);
    expect(messageImageNotes(message, undefined)).toEqual([]);
    expect(messageImageNotes(undefined, "s2")).toEqual([]);
  });
});

describe("markerLayout", () => {
  test("the badge sits up and right of the point, flipped at the top and right edges", () => {
    const mid = markerLayout({ x: 0.5, y: 0.5 }, 1000, 1000);
    expect(mid.r).toBe(22);
    expect([mid.bx, mid.by]).toEqual([544, 456]);
    const corner = markerLayout({ x: 0.99, y: 0.01 }, 1000, 1000);
    expect([corner.dx, corner.dy]).toEqual([-1, 1]);
  });
});

describe("hideMarkerPoints", () => {
  test("the reader sees only the marker; the point stays for the agent and the hover areas", () => {
    const text = "> [Image 1] at marker 2 (26% from the left, 40% from the top)\n> Image from your message\n\nnote";
    expect(hideMarkerPoints(text)).toBe("> [Image 1] at marker 2\n> Image from your message\n\nnote");
    expect(hideMarkerPoints("> [Image 1] at marker 1 (5% from the left, 6% from the top)\n\nnote")).toBe("> [Image 1] at marker 1\n\nnote");
    expect(hideMarkerPoints("at 26% from the left, 40% from the top")).toBe("at 26% from the left, 40% from the top");
  });
});
