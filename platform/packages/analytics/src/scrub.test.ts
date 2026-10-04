import { describe, expect, it } from "bun:test";
import { runScrub, scrubPosthogEvent, scrubSentryBreadcrumb, scrubSentryEvent } from "./scrub";
import { createCodecastSink } from "./codecast";

// What an app passes as config.scrubUrl: its secret paths, rewritten wherever
// they appear in a string.
const scrub = (text: string) => text.replace(/\/(share\/[a-z]+|meet)\/[^/?#\s"']+/g, "/$1/:token");

describe("scrubPosthogEvent", () => {
  it("rewrites the page, the referrer, element hrefs and the person's first URL", () => {
    const event = scrubPosthogEvent(
      {
        event: "$pageview",
        properties: {
          $current_url: "https://app.test/share/call/k3y?t=12",
          $pathname: "/share/call/k3y",
          $referrer: "https://app.test/meet/g0lden",
          $elements_chain: 'a:href="/share/doc/d0c"nth-child="1"',
          $elements: [{ tag_name: "a", attr__href: "/meet/g0lden" }],
          $set_once: { $initial_current_url: "https://app.test/meet/g0lden" },
          count: 3,
        },
        $set: { $current_url: "https://app.test/share/call/k3y" },
      },
      scrub,
    );
    const text = JSON.stringify(event);
    expect(text).not.toContain("k3y");
    expect(text).not.toContain("g0lden");
    expect(text).not.toContain("d0c");
    expect(event.properties?.$current_url).toBe("https://app.test/share/call/:token?t=12");
    expect(event.properties?.count).toBe(3);
  });

  it("leaves an event with nothing secret as the same objects, and passes null through", () => {
    const props = { $current_url: "https://app.test/inbox" };
    const event = scrubPosthogEvent({ properties: props }, scrub);
    expect(event.properties).toBe(props);
    expect(scrubPosthogEvent(null, scrub)).toBeNull();
  });

  it("never loses the event to a rewrite that throws", () => {
    const event = scrubPosthogEvent({ properties: { $current_url: "/meet/x" } }, () => {
      throw new Error("bad rule");
    });
    expect(event.properties?.$current_url).toBe("/meet/x");
  });
});

describe("Sentry", () => {
  it("rewrites the request URL, the referrer header, the transaction and every crumb", () => {
    const event = scrubSentryEvent(
      {
        request: { url: "https://app.test/meet/g0lden", headers: { Referer: "https://app.test/share/call/k3y" } },
        transaction: "/share/call/k3y",
        breadcrumbs: [{ category: "navigation", data: { from: "/inbox", to: "/share/call/k3y" } }],
      },
      scrub,
    );
    expect(JSON.stringify(event)).not.toMatch(/k3y|g0lden/);
    expect(event.breadcrumbs?.[0]?.data?.from).toBe("/inbox");
  });

  it("rewrites a crumb's message and fetch url as it is recorded", () => {
    const crumb = scrubSentryBreadcrumb({ message: "GET /meet/g0lden", data: { url: "/meet/g0lden" } }, scrub);
    expect(crumb).toEqual({ message: "GET /meet/:token", data: { url: "/meet/:token" } });
  });
});

describe("the codecast sink", () => {
  it("reports an error on a secret page by the page's shape", () => {
    const sink = createCodecastSink({
      ingestKey: "cc_ing_x",
      endpoint: "https://ingest.test/cli/ingest",
      scrubUrl: scrub,
      fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const urls: Array<string | undefined> = [];
    sink.onError((item) => urls.push(item.url));
    sink.captureError(new Error("boom"), { url: "https://app.test/share/call/k3y" });
    sink.close();
    expect(urls).toEqual(["https://app.test/share/call/:token"]);
    expect(sink.scrubUrl("/meet/g0lden")).toBe("/meet/:token");
  });

  it("runs no rewrite when none is configured", () => {
    expect(runScrub(undefined, "/meet/g0lden")).toBe("/meet/g0lden");
  });
});
