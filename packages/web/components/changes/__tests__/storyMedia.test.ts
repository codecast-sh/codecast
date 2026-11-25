import { describe, expect, test } from "bun:test";
import { extraScreens, leadMedia, mediaOf } from "../storyMedia";

import { story } from "./fixtures";

const shot = (n: number) => `![shot ${n}](https://convex.example/s${n}.png)`;

describe("mediaOf", () => {
  test("reads screenshots, published pages and canvases in article order", () => {
    const body = [
      "The lead.",
      shot(1),
      "https://codecast.sh/a/fee-report",
      "```cast-canvas\n<div>flow</div>\n```",
      "A link inside a sentence https://codecast.sh/a/inline stays prose.",
    ].join("\n\n");
    expect(mediaOf(body)).toEqual([
      { kind: "image", src: "https://convex.example/s1.png", alt: "shot 1" },
      { kind: "page", slug: "fee-report", url: "https://codecast.sh/a/fee-report" },
      { kind: "canvas", block: "```cast-canvas\n<div>flow</div>\n```" },
    ]);
  });
});

describe("leadMedia", () => {
  test("lifts the first screenshot or page out of the article, so it shows once", () => {
    const body = ["The lead.", shot(1), "More.", shot(2)].join("\n\n");
    expect(leadMedia(body)).toEqual({ lead: { kind: "image", src: "https://convex.example/s1.png", alt: "shot 1" }, rest: ["The lead.", "More.", shot(2)].join("\n\n") });
    expect(leadMedia("Text\n\nhttps://codecast.sh/a/fee-report\n\nEnd").lead).toEqual({ kind: "page", slug: "fee-report", url: "https://codecast.sh/a/fee-report" });
  });
  test("a canvas or plain prose leads with nothing", () => {
    expect(leadMedia("```cast-canvas\n<div/>\n```").lead).toBeNull();
    expect(leadMedia("Just words.")).toEqual({ lead: null, rest: "Just words." });
    expect(leadMedia(undefined)).toEqual({ lead: null, rest: "" });
  });
});

describe("extraScreens", () => {
  test("adds the sessions' screens the article did not place, pages by their slug", () => {
    const s = story("a", {
      body: `The lead.\n\n${shot(1)}`,
      screens: [
        { kind: "image", url: "https://convex.example/s1.png", at: 1 },
        { kind: "image", url: "https://convex.example/s9.png", at: 2, caption: "the header" },
        { kind: "page", url: "https://codecast.sh/a/fee-report", at: 3 },
      ],
    } as any);
    expect(extraScreens(s)).toEqual([
      { kind: "image", src: "https://convex.example/s9.png", alt: "the header" },
      { kind: "page", slug: "fee-report", url: "https://codecast.sh/a/fee-report" },
    ]);
    expect(extraScreens({ screens: [{ kind: "page", url: "https://codecast.sh/a/x", at: 1, caption: "Fee report" }] } as any)[0]).toMatchObject({ title: "Fee report" });
  });
});
