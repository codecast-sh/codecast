import { POSTS, type BlogPost } from "../app/(marketing)/blog/posts";
import { SITE_URL, seoFor } from "./seoRoutes";

/**
 * The blog's RSS 2.0 feed, built from posts.ts so a new post reaches
 * subscribers with no second edit. scripts/prerender.mjs writes it to
 * dist/blog/rss.xml next to the sitemap; index.html advertises it.
 */

export const BLOG_FEED_PATH = "/blog/rss.xml";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

export function buildBlogFeed(posts: BlogPost[] = POSTS): string {
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));
  const items = sorted
    .map((p) => {
      const url = `${SITE_URL}/blog/${p.slug}`;
      return [
        "    <item>",
        `      <title>${xmlEscape(p.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <description>${xmlEscape(p.dek)}</description>`,
        `      <dc:creator>${xmlEscape(p.author)}</dc:creator>`,
        `      <pubDate>${rfc822(p.date)}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");
  const lastBuild = sorted[0] ? `\n    <lastBuildDate>${rfc822(sorted[0].date)}</lastBuildDate>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Codecast blog</title>
    <link>${SITE_URL}/blog</link>
    <description>${xmlEscape(seoFor("/blog")?.description ?? "")}</description>
    <language>en</language>
    <atom:link href="${SITE_URL}${BLOG_FEED_PATH}" rel="self" type="application/rss+xml" />${lastBuild}
${items}
  </channel>
</rss>
`;
}
