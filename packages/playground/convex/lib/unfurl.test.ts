import { describe, expect, test } from "bun:test";
import { unfurlFacts, unfurlHtml } from "./unfurl";

describe("link unfurls", () => {
  test("say how many people changed it and the live version", () => {
    expect(unfurlFacts({ name: "x", summary: null, version: 14, contributors: 38 })).toBe("38 people changed it · v14");
    expect(unfurlFacts({ name: "x", summary: null, version: 1, contributors: 1 })).toBe("1 person changed it · v1");
  });

  test("carry the app's own tags, escaped, and send people on to the app", () => {
    const html = unfurlHtml({ name: `Tom & "Jerry" <3`, summary: "Adds a moon", version: 3, contributors: 2 }, "https://clayground.fun/tom-k3x9");
    expect(html).toContain(`<meta property="og:title" content="Tom &amp; &quot;Jerry&quot; &lt;3" />`);
    expect(html).toContain(`content="Adds a moon. 2 people changed it · v3"`);
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=https://clayground.fun/tom-k3x9" />`);
    expect(html).not.toContain("<3");
  });
});
