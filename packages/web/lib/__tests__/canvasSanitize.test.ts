// Regression: DOMPurify's default allowlist rejects SVG <use>, which silently
// blanked every canvas that deduplicates geometry through <defs> + <use>
// (e.g. a logo stamped five times). The policy re-allows <use> but only for
// same-document references — an external href is how <use> becomes dangerous.
// The egress tests pin the second invariant: a canvas synced to teammates must
// not phone home (no remote images, no CSS url() fetches, no @import).

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";

const g = globalThis as Record<string, unknown>;
const hadWindow = "window" in g;

beforeAll(() => {
  // jsdom, not happy-dom: DOMPurify silently mis-sanitizes on happy-dom's DOM
  // (kept <script>, dropped <b>) while still reporting isSupported.
  g.window = new JSDOM("").window;
});

afterAll(() => {
  // Bun runs all test files in one process — don't leak a window global into
  // test files that branch on typeof window.
  if (!hadWindow) delete g.window;
});

async function sanitize(html: string): Promise<string> {
  // canvasSanitize binds DOMPurify to window lazily, at first sanitize call.
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

  // No network egress: a canvas synced to teammates must not phone home.

  test("removes remote images, keeps data: images", async () => {
    const out = await sanitize(
      '<img src="https://evil.example/pixel.png"><img src="data:image/png;base64,iVBOR" alt="ok">',
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain('src="data:image/png');
  });

  test("neutralizes remote url() in style attributes, keeps local and data:", async () => {
    const out = await sanitize(
      '<div style="background:url(https://evil.example/x.png);color:red">a</div>' +
        "<div style=\"background:url(data:image/gif;base64,R0l);mask:url(#m)\">b</div>",
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color:red");
    expect(out).toContain("url(data:image/gif");
    expect(out).toContain("url(#m)");
  });

  test("neutralizes remote url() and @import inside <style> blocks", async () => {
    const out = await sanitize(
      "<style>@import url(https://evil.example/a.css); .x{background:url('https://evil.example/b.png')} .y{clip-path:url(#c)}</style><div class=x>t</div>",
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
    expect(out).toContain("url(#c)");
  });

  test("scrubs remote references from svg mask/filter attributes", async () => {
    const out = await sanitize(
      '<svg><rect mask="url(https://evil.example/m.svg#m)" filter="url(#f)" width="5" height="5"/></svg>',
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain('filter="url(#f)"');
  });

  test("keeps a leading top-level <style> block (FORCE_BODY)", async () => {
    const out = await sanitize('<style>.x{color:red}</style><div class="x">t</div>');
    expect(out).toContain(".x{color:red}");
  });

  test("removes remote svg <image>, keeps data: <image>", async () => {
    const out = await sanitize(
      '<svg><image href="https://evil.example/x.png"/><image href="data:image/png;base64,iVBOR"/></svg>',
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain('href="data:image/png');
  });
});
