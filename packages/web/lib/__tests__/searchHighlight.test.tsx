import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightMatch, getSnippet } from "../searchHighlight";

const marks = (text: string, query: string) =>
  [...renderToStaticMarkup(<>{highlightMatch(text, query)}</>).matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1]);

// The marks are drawn from the terms the server ranked by: "k pop warm intro
// video" used to light up every "k" on the page ("ask", "look", "backend").
describe("highlightMatch", () => {
  test("a dropped letter is not marked inside other words", () => {
    expect(marks("ask about the backend look", "k pop warm intro video")).toEqual([]);
    expect(marks("the K-pop warm intro video", "k pop warm intro video")).toEqual(["K-pop warm intro video"]);
  });

  test("stop-words are not marked, the words that searched are", () => {
    expect(marks("the intro to the video", "the intro to the video")).toEqual(["intro", "video"]);
  });

  test("text around the marks is kept as written", () => {
    const html = renderToStaticMarkup(<>{highlightMatch("a Warm start", "warm")}</>);
    expect(html.replace(/<[^>]+>/g, "")).toBe("a Warm start");
  });
});

describe("getSnippet", () => {
  test("a short text is shown whole, a long one around the query", () => {
    expect(getSnippet("warm intro", "intro")).toBe("warm intro");
    const long = `${"x ".repeat(500)}the warm intro video${" y".repeat(500)}`;
    const snippet = getSnippet(long, "warm intro video", 120);
    expect(snippet).toContain("warm intro video");
    expect(snippet.startsWith("...") && snippet.endsWith("...")).toBe(true);
  });
});
