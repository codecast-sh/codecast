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

describe("entityRemarkPlugins doc references", () => {
  // Docs have no short id, so the convex id must survive in the link *text*
  // (react-markdown strips the entity:// href). EntityAwareLink reads that
  // carrier and renders a doc pill — the previous code dropped the id and
  // rendered a dead "@title" mention.
  const DOC_ID = "jh7d8k2m9n4p6q1r3s5t7v9w0";

  test("@[Title doc:<id>] keeps the doc id as the link carrier", () => {
    const html = render(`see @[My Design doc:${DOC_ID}] for details`);
    expect(html).toContain(`>doc:${DOC_ID}</a>`);
    // The id must not be lost in favor of a plain, link-less mention.
    expect(html).not.toContain("@My Design");
  });

  test("a bare doc:<id> in prose is linkified, like ct-/jx ids", () => {
    const html = render(`the spec is in doc:${DOC_ID} now`);
    expect(html).toContain(`>doc:${DOC_ID}</a>`);
  });

  test("a too-short doc:<word> is left as plain text (not a convex id)", () => {
    const html = render("see doc:short now");
    expect(html).not.toContain("<a");
    expect(html).toContain("doc:short");
  });

  test("existing ct-/jx carriers are unaffected", () => {
    expect(render("see ct-abc123 now")).toContain(">ct-abc123</a>");
    expect(render("see @[Sess jx7abc12] now")).toContain(">jx7abc12</a>");
  });
});

describe("entityRemarkPlugins bare convex ids", () => {
  // Docs have no short id, so agents reference them by the raw 32-char Convex
  // id. That must linkify like ct-/jx short ids do; EntityIdPill resolves the
  // table server-side and falls back to plain text for non-entity ids.
  const CONVEX_ID = "s97f0jvy02p54v6as7gnfkegrs8aps7a";

  test("a bare 32-char convex id in prose is linkified", () => {
    const html = render(`market analysis doc ${CONVEX_ID}, plan pl-170`);
    expect(html).toContain(`>${CONVEX_ID}</a>`);
    expect(html).toContain(">pl-170</a>");
  });

  test("@[Title <convexId>] mentions carry the id as the link", () => {
    const html = render(`see @[Market Analysis ${CONVEX_ID}] for details`);
    expect(html).toContain(`>${CONVEX_ID}</a>`);
    expect(html).not.toContain("@Market Analysis");
  });

  test("an uppercase 32-char hash lookalike stays plain text", () => {
    const upper = "D41D8CD98F00B204E9800998ECF8427E";
    const html = render(`md5 is ${upper} here`);
    expect(html).not.toContain("<a");
    expect(html).toContain(upper);
  });

  test("31- and 33-char tokens are not treated as convex ids", () => {
    expect(render(`x ${CONVEX_ID.slice(0, 31)} y`)).not.toContain("<a");
    expect(render(`x ${CONVEX_ID}0 y`)).not.toContain("<a");
  });
});
