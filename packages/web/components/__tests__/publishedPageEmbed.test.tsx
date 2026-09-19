import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { renderToStaticMarkup } from "react-dom/server";
import { replaceGlobals } from "../../test-helpers/globals";
import { PublishedPageEmbed } from "../PublishedPageEmbed";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const client = new ConvexReactClient("https://example.convex.cloud");

function markup(slug = "abc") {
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
    const titles = titleOrder(markup("my-page"));
    const copy = titles.indexOf("Copy link to published page");
    const expand = titles.indexOf("Expand");
    const pane = titles.indexOf("Open beside your work, as a pane");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(expand).toBeGreaterThan(copy);
    expect(pane).toBeGreaterThan(expand);
  });

  test("open points at the public share URL, not the serving origin", () => {
    const html = markup("my-page");
    expect(html).toContain('href="https://codecast.sh/a/my-page"');
    expect(html).toContain("Copy link to published page");
  });
});

const written: string[] = [];
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: Object.assign(dom.window.navigator, {
    clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
  }),
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

describe("PublishedPageEmbed copy", () => {
  test("the copy button writes the public share URL", async () => {
    written.length = 0;
    mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {} } }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(() =>
      root.render(
        <ConvexProvider client={client}>
          <PublishedPageEmbed slug="my-page" />
        </ConvexProvider>,
      ),
    );
    const btn = container.querySelector('[aria-label="Copy link to published page"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(() => btn.click());
    expect(written).toEqual(["https://codecast.sh/a/my-page"]);
    await act(() => root.unmount());
  });
});

