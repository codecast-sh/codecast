import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { PublishedPageEmbed } from "../PublishedPageEmbed";

const client = new ConvexReactClient("https://example.convex.cloud");

function render(slug = "abc") {
  return renderToStaticMarkup(
    <ConvexProvider client={client}>
      <PublishedPageEmbed slug={slug} />
    </ConvexProvider>,
  );
}

function titleOrder(html: string): string[] {
  return [...html.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
}

describe("PublishedPageEmbed header actions", () => {
  test("copy link to the published page is first, then collapse, then open in a pane", () => {
    const titles = titleOrder(render("my-page"));
    const copy = titles.indexOf("Copy link to published page");
    const expand = titles.indexOf("Expand");
    const pane = titles.indexOf("Open beside your work, as a pane");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(expand).toBeGreaterThan(copy);
    expect(pane).toBeGreaterThan(expand);
  });

  test("open points at the public share URL, not the serving origin", () => {
    const html = render("my-page");
    expect(html).toContain('href="https://codecast.sh/a/my-page"');
    expect(html).toContain("Copy link to published page");
  });
});
