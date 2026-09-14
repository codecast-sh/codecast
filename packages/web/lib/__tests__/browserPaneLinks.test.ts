import { describe, expect, it } from "bun:test";
import { pageAddressLabel, loopbackLinkUrl, typedAddress } from "../browserPaneLinks";

describe("loopbackLinkUrl", () => {
  it("takes every address only this machine can serve", () => {
    expect(loopbackLinkUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(loopbackLinkUrl("http://127.0.0.1:5173/inbox")).toBe("http://127.0.0.1:5173/inbox");
    expect(loopbackLinkUrl("http://127.0.0.2:8080/")).toBe("http://127.0.0.2:8080/");
    expect(loopbackLinkUrl("http://localhost/health")).toBe("http://localhost/health");
    expect(loopbackLinkUrl("https://localhost:8443/")).toBe("https://localhost:8443/");
    expect(loopbackLinkUrl("http://app.localhost:3000/")).toBe("http://app.localhost:3000/");
  });

  it("leaves every other link alone", () => {
    expect(loopbackLinkUrl("https://codecast.sh/a/xyz")).toBeNull();
    expect(loopbackLinkUrl("http://192.168.1.9:3000")).toBeNull();
    expect(loopbackLinkUrl("/tasks/ct-1")).toBeNull();
    expect(loopbackLinkUrl("mailto:a@b.com")).toBeNull();
    expect(loopbackLinkUrl(undefined)).toBeNull();
    expect(loopbackLinkUrl("")).toBeNull();
  });

  // A scheme-less string never arrives as an href, and guessing one would
  // turn a relative path into a page nobody linked to.
  it("refuses anything without an explicit http scheme", () => {
    expect(loopbackLinkUrl("localhost:3000")).toBeNull();
    expect(loopbackLinkUrl("javascript:alert(1)")).toBeNull();
    expect(loopbackLinkUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("pageAddressLabel", () => {
  it("reads as host, port and path", () => {
    expect(pageAddressLabel("http://localhost:3000/")).toBe("localhost:3000");
    expect(pageAddressLabel("http://localhost:3000/inbox")).toBe("localhost:3000/inbox");
    expect(pageAddressLabel("http://127.0.0.1:5173/a/?q=1")).toBe("127.0.0.1:5173/a?q=1");
  });

  it("keeps both ends of a long path", () => {
    const label = pageAddressLabel("http://localhost:3000/a/very/long/path/that/keeps/going/report.html");
    expect(label.length).toBeLessThanOrEqual(38);
    expect(label.startsWith("localhost:3000/")).toBe(true);
    expect(label.endsWith("ort.html")).toBe(true);
  });
});

describe("typedAddress", () => {
  it("takes what a person clearly meant as an address", () => {
    expect(typedAddress("localhost:3000")).toBe("http://localhost:3000/");
    expect(typedAddress("http://127.0.0.1:5173/inbox")).toBe("http://127.0.0.1:5173/inbox");
    expect(typedAddress("github.com/anthropics")).toBe("https://github.com/anthropics");
    expect(typedAddress("  codecast.sh  ")).toBe("https://codecast.sh/");
  });

  // Every keystroke in the palette is also a search; a bare word is a search.
  it("leaves ordinary palette queries alone", () => {
    expect(typedAddress("tasks")).toBeNull();
    expect(typedAddress("ct-4102")).toBeNull();
    expect(typedAddress("open the browser pane")).toBeNull();
    expect(typedAddress("dev-box")).toBeNull();
    expect(typedAddress("1.5")).toBeNull();
    expect(typedAddress("")).toBeNull();
  });

  it("still refuses a scheme a pane must never load", () => {
    expect(typedAddress("javascript:alert(1)")).toBeNull();
    expect(typedAddress("file:///etc/passwd")).toBeNull();
  });
});
