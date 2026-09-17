import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { DiffView } from "../DiffView";

// Where the comment affordance lives. A surface that owns its comments (the
// pull request page) sits the diff flush inside a clipped card, so a handle
// hung in the margin outside the block is invisible there, which is how
// commenting on a line came to look impossible. Those rows carry their own
// "+" instead; a diff inside a message keeps the one handle in its gutter.
const client = new ConvexReactClient("https://example.convex.cloud");
const render = (el: React.ReactElement) => renderToStaticMarkup(<ConvexProvider client={client}>{el}</ConvexProvider>);
const count = (html: string, needle: string) => html.split(needle).length - 1;

const OLD = "one\ntwo\nthree";
const NEW = "one\n2\nthree";

describe("DiffView comment affordance", () => {
  test("a surface that owns the comments gets a + on every row and no margin handle", () => {
    const html = render(<DiffView oldStr={OLD} newStr={NEW} showLineNumbers onLineComment={() => {}} />);
    // one, -two, +2, three
    expect(count(html, 'class="cc-row-plus"')).toBe(4);
    expect(html).not.toContain("cc-diff-quote");
    expect(html).toContain('aria-label="Comment on this line"');
  });

  test("a diff inside a message keeps the single margin handle and no row buttons", () => {
    const html = render(
      <DiffView oldStr={OLD} newStr={NEW} showLineNumbers commentContext={{ conversationId: "c1", anchorKey: "m1", filePath: "a.ts" }} />,
    );
    expect(count(html, "cc-diff-quote")).toBe(1);
    expect(html).not.toContain("cc-row-plus");
  });

  test("an inert diff has neither", () => {
    const html = render(<DiffView oldStr={OLD} newStr={NEW} showLineNumbers />);
    expect(html).not.toContain("cc-row-plus");
    expect(html).not.toContain("cc-diff-quote");
  });
});
