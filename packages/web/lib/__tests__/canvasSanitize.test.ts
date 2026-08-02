// Regression: DOMPurify's default allowlist rejects SVG <use>, which silently
// blanked every canvas that deduplicates geometry through <defs> + <use>
// (e.g. a logo stamped five times). The policy re-allows <use> but only for
// same-document references — an external href is how <use> becomes dangerous.

import { test, expect, describe, beforeAll } from "bun:test";
import { JSDOM } from "jsdom";

beforeAll(() => {
  // jsdom, not happy-dom: DOMPurify silently mis-sanitizes on happy-dom's DOM
  // (kept <script>, dropped <b>) while still reporting isSupported.
  (globalThis as Record<string, unknown>).window = new JSDOM("").window;
});

async function sanitize(html: string): Promise<string> {
  // Imported after the DOM global exists — DOMPurify binds to window at import time.
  const { sanitizeCanvasHtml } = await import("../canvasSanitize");
  return sanitizeCanvasHtml(html);
}

describe("sanitizeCanvasHtml", () => {
  test("keeps <use> with a same-document href", async () => {
    const out = await sanitize(
      '<svg viewBox="0 0 10 10"><defs><path id="p" d="M0 0h10"/></defs><use href="#p" fill="red"/></svg>',
    );
    expect(out).toContain("<use");
    expect(out).toContain('href="#p"');
    expect(out).toContain("<defs>");
  });

  test("strips <use> that references an external URL", async () => {
    const out = await sanitize('<svg><use href="https://evil.example/sprite.svg#x"/></svg>');
    expect(out).not.toContain("<use");
  });

  test("strips <use> with an xlink:href external reference", async () => {
    const out = await sanitize(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="//evil.example/s.svg#x"/></svg>',
    );
    expect(out).not.toContain("<use");
  });

  test("still strips scripts and event handlers", async () => {
    const out = await sanitize('<div onclick="x()"><script>bad()</script><b>ok</b></div>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("<b>ok</b>");
  });

  test("forces links to open in a new tab", async () => {
    const out = await sanitize('<a href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
});
