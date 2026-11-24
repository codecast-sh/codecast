import { describe, expect, test } from "bun:test";
import { describePageAnchor, parsePageAnchor } from "./pageAnchor";

describe("describePageAnchor", () => {
  test("names the view a comment was made on, first", () => {
    const a = parsePageAnchor(JSON.stringify({ view: "take-it-over", sel: "#owners", snippet: "Remove" }));
    expect(describePageAnchor(a)).toEqual([
      "on view `?view=take-it-over`",
      "on element `#owners`",
      'on the words "Remove"',
    ]);
  });

  test("the landing view says nothing about a view", () => {
    expect(describePageAnchor(parsePageAnchor(JSON.stringify({ view: "", t: 14 })))).toEqual([
      "at 0:14 of the timeline",
    ]);
    expect(describePageAnchor(parsePageAnchor(JSON.stringify({ x: 0.2, y: 0.4 })))).toEqual([]);
  });
});
