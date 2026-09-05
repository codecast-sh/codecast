import { describe, expect, test } from "bun:test";
import { renderMarkdownBody, renderMarkdownDocument, slugify } from "./artifactMarkdown";

describe("artifactMarkdown", () => {
  test("headings get stable GitHub-style ids with a self link", async () => {
    const html = await renderMarkdownBody("# Hello, World!\n\n## Hello, World!\n\n### Ünïcode & <tags>");
    expect(html).toContain('<h1 id="hello-world">');
    expect(html).toContain('<h2 id="hello-world-1">');
    expect(html).toContain('<h3 id="ünïcode">');
    expect(html).toContain('<a class="anchor" href="#hello-world"');
  });

  test("slugify is unique per render and never empty", () => {
    const seen = new Map<string, number>();
    expect(slugify("!!!", seen)).toBe("section");
    expect(slugify("!!!", seen)).toBe("section-1");
  });

  test("fenced code is highlighted server-side and labelled with its language", async () => {
    const html = await renderMarkdownBody("```ts\nconst x: number = 1;\n```");
    expect(html).toContain('<pre data-lang="ts"><code class="language-ts">');
    expect(html).toContain('class="hljs-keyword">const</span>');
  });

  test("unknown languages fall back to escaped text, and html in code never leaks", async () => {
    const html = await renderMarkdownBody("```nope-lang\n<script>alert(1)</script>\n```");
    expect(html).toContain('<pre data-lang="nope-lang">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("tables are wrapped for horizontal scroll and keep alignment", async () => {
    const html = await renderMarkdownBody("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(html).toContain('<div class="tbl"><table><thead>');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  test("the document shell carries the theme, the title, and the copy script", async () => {
    const html = await renderMarkdownDocument("# T", "A <title>");
    expect(html).toContain("<title>A &lt;title&gt;</title>");
    expect(html).toContain('<main class="md">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("fonts.googleapis.com/css2?family=Hanken+Grotesk");
    expect(html).toContain('querySelectorAll(".md pre")');
  });
});
