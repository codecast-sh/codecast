import { describe, expect, test } from "bun:test";
import { buildBlogFeed } from "../blogFeed";
import { POSTS } from "../../app/(marketing)/blog/posts";
import { SITE_URL } from "../seoRoutes";

describe("blog feed", () => {
  const xml = buildBlogFeed();

  test("has one item per post, newest first", () => {
    const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]);
    const expected = [...POSTS].sort((a, b) => b.date.localeCompare(a.date)).map((p) => `${SITE_URL}/blog/${p.slug}`);
    expect(links).toEqual(expected);
  });

  test("escapes markup in post text", () => {
    const out = buildBlogFeed([{ ...POSTS[0], title: "A & B <c>", dek: `"q" & 'a'` }]);
    expect(out).toContain("<title>A &amp; B &lt;c&gt;</title>");
    expect(out).toContain("<description>&quot;q&quot; &amp; &apos;a&apos;</description>");
  });

  test("dates are RFC 822", () => {
    expect(xml).toMatch(/<pubDate>\w{3}, \d{2} \w{3} \d{4} 00:00:00 GMT<\/pubDate>/);
  });
});
