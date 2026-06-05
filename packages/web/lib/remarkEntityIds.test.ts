import { test, expect, describe } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { entityRemarkPlugins } from "./remarkEntityIds";

const render = (md: string) =>
  renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: entityRemarkPlugins }, md),
  );

describe("entityRemarkPlugins strikethrough handling", () => {
  // Regression: agents use "~" as an "approximately" sign. Two of them on one
  // line (e.g. "~$1,084/mo ... ~$5/mo") must NOT be paired into a <del> span.
  test("lone tildes used as approximately-signs render literally, not struck", () => {
    const html = render(
      "release those Mac hosts (~$1,084/mo) and snapshot (~$5/mo) now",
    );
    expect(html).not.toContain("<del>");
    expect(html).toContain("~$1,084/mo");
    expect(html).toContain("~$5/mo");
  });

  test("a single approximately-sign elsewhere stays literal", () => {
    const html = render("down from ~$360/mo, saving ~$290/mo");
    expect(html).not.toContain("<del>");
    expect(html).toContain("~$360/mo");
  });

  // Intentional strikethrough still works with the GitHub-standard double tilde.
  test("double tilde still renders real strikethrough", () => {
    const html = render("this is ~~deleted~~ text");
    expect(html).toContain("<del>deleted</del>");
  });
});
