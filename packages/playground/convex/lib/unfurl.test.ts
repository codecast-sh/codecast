import { describe, expect, test } from "bun:test";
import { unfurlFacts, unfurlHtml, unfurlSlug } from "./unfurl";

describe("link unfurls", () => {
  test("say how many people changed it and the live version", () => {
    expect(unfurlFacts({ name: "x", summary: null, version: 14, contributors: 38, image: null })).toBe("38 people changed it · v14");
    expect(unfurlFacts({ name: "x", summary: null, version: 1, contributors: 1, image: null })).toBe("1 person changed it · v1");
  });

  test("carry the app's own tags, escaped, and send people on to the app", () => {
    const html = unfurlHtml({ name: `Tom & "Jerry" <3`, summary: "Adds a moon", version: 3, contributors: 2, image: null }, "https://clayground.fun/tom-k3x9");
    expect(html).toContain(`<meta property="og:title" content="Tom &amp; &quot;Jerry&quot; &lt;3" />`);
    expect(html).toContain(`content="Adds a moon. 2 people changed it · v3"`);
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=https://clayground.fun/tom-k3x9" />`);
    expect(html).not.toContain("<3");
    expect(html).not.toContain("og:image");
  });

  test("show the app's still when a screen has taken one", () => {
    const html = unfurlHtml({ name: "Tom", summary: null, version: 3, contributors: 2, image: "https://x.convex.cloud/api/storage/abc" }, "https://clayground.fun/tom-k3x9");
    expect(html).toContain(`<meta property="og:image" content="https://x.convex.cloud/api/storage/abc" />`);
    expect(html).toContain(`content="summary_large_image"`);
  });

  test("an unfurler asking for an app link gets that app's preview; people get the shell", () => {
    const slack = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
    const imessage = "Mozilla/5.0 (Macintosh) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
    expect(unfurlSlug("/frog-choir-m6ub", slack)).toBe("frog-choir-m6ub");
    expect(unfurlSlug("/frog-choir-m6ub/v/12", imessage)).toBe("frog-choir-m6ub");
    expect(unfurlSlug("/frog-choir-m6ub", "Mozilla/5.0 (iPhone) Safari/604.1")).toBeNull();
    expect(unfurlSlug("/", slack)).toBeNull();
    expect(unfurlSlug("/src/main.tsx", slack)).toBeNull();
    expect(unfurlSlug("/frog-choir-m6ub", null)).toBeNull();
  });
});
