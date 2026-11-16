import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { dropStylePreloads } from "../stylePreloads";

function page(head: string): Document {
  return new JSDOM(`<!doctype html><html><head>${head}</head><body></body></html>`).window.document;
}

describe("dropStylePreloads", () => {
  test("removes the boot script's stylesheet preloads and leaves the stylesheets", () => {
    const doc = page(
      `<link rel="preload" as="style" crossorigin href="/assets/boot-TV9iaPDc.css">`
        + `<link rel="preload" as="style" crossorigin href="/assets/index-B7OyO0dK.css">`
        + `<link rel="stylesheet" href="/assets/boot-TV9iaPDc.css">`,
    );
    expect(dropStylePreloads(doc)).toBe(2);
    expect(Array.from(doc.querySelectorAll("link")).map((l) => `${l.rel}:${l.getAttribute("href")}`)).toEqual(["stylesheet:/assets/boot-TV9iaPDc.css"]);
  });

  test("removes a preload rrweb would wait on even without as=style: any .css href", () => {
    const doc = page(`<link rel="preload" href="https://cdn.example/app.css?v=3#x"><link rel="PRELOAD" as="STYLE" href="/sheet">`);
    expect(dropStylePreloads(doc)).toBe(2);
    expect(doc.querySelectorAll("link").length).toBe(0);
  });

  test("leaves every other link alone", () => {
    const doc = page(
      `<link rel="modulepreload" href="/assets/boot.js">`
        + `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/sans.woff2">`
        + `<link rel="preload" as="script" href="/assets/vendor.js">`
        + `<link rel="preconnect" href="https://fonts.gstatic.com">`
        + `<link rel="icon" href="/favicon.ico">`
        + `<link rel="stylesheet" href="/assets/index.css">`,
    );
    expect(dropStylePreloads(doc)).toBe(0);
    expect(doc.querySelectorAll("link").length).toBe(6);
  });

  test("does nothing when there is no document", () => {
    expect(dropStylePreloads(undefined)).toBe(0);
  });
});
