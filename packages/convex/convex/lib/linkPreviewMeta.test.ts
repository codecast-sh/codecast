import { describe, expect, test } from "bun:test";
import { linkPreviewStale, parseLinkPreviewMeta } from "./linkPreviewMeta";

describe("parseLinkPreviewMeta", () => {
  test("Open Graph wins over the plain tags, relative URLs resolve, entities decode", () => {
    const html = `<html><head>
      <title>Plain title</title>
      <meta name="description" content="plain">
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;page&quot;">
      <meta content="The OG description" property="og:description" />
      <meta property='og:image' content='/img/share.png'>
      <meta property="og:site_name" content="Example">
      <link rel="shortcut icon" href="/fav.png">
    </head><body><meta property="og:title" content="body lies"></body></html>`;
    expect(parseLinkPreviewMeta(html, "https://example.com/a/b")).toEqual({
      title: `Tom & Jerry's "page"`,
      description: "The OG description",
      image: "https://example.com/img/share.png",
      site_name: "Example",
      favicon: "https://example.com/fav.png",
    });
  });

  test("falls back to twitter tags, then <title> and meta description", () => {
    const meta = parseLinkPreviewMeta(`<head><title> A\n title </title><meta name="description" content="d"><meta name="twitter:image" content="https://cdn.x/i.png"></head>`, "https://x.com/");
    expect(meta.title).toBe("A title");
    expect(meta.description).toBe("d");
    expect(meta.image).toBe("https://cdn.x/i.png");
    expect(meta.favicon).toBe("https://x.com/favicon.ico");
  });

  test("an http image is dropped (mixed content on an https app)", () => {
    expect(parseLinkPreviewMeta(`<head><meta property="og:image" content="http://x.com/i.png"></head>`, "http://x.com/").image).toBeUndefined();
  });
});

describe("linkPreviewStale", () => {
  const now = 10 * 24 * 3600_000;
  test("a missing row, an old ok row and a stalled fetch refetch; a fresh or in-flight one does not", () => {
    expect(linkPreviewStale(null, now)).toBe(true);
    expect(linkPreviewStale({ status: "ok", requested_at: 0, fetched_at: now - 3600_000 }, now)).toBe(false);
    expect(linkPreviewStale({ status: "ok", requested_at: 0, fetched_at: 0 }, now)).toBe(true);
    expect(linkPreviewStale({ status: "pending", requested_at: now - 5_000 }, now)).toBe(false);
    expect(linkPreviewStale({ status: "pending", requested_at: now - 120_000 }, now)).toBe(true);
    expect(linkPreviewStale({ status: "failed", requested_at: 0, fetched_at: now - 3600_000 }, now)).toBe(false);
  });
});
