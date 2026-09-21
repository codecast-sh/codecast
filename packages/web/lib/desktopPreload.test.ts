import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { HANDOFF_MIRROR_KEY, runPreBootHandoff } from "./desktopHandoff";

const keys = ["window", "document", "localStorage", "sessionStorage", "navigator"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://codecast.sh/conversation/session",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  Object.defineProperty(dom.window.document, "hasFocus", { value: () => true });
  for (const key of keys) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  dom.window.close();
  for (const key of keys) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
});

const preload = () => {
  runPreBootHandoff(["/boot.js", "/shared.js"], ["/share.js"], ["/conversation.js", "/shared.js"]);
  return [...dom.window.document.querySelectorAll('link[rel="modulepreload"]')].map((link) => link.getAttribute("href"));
};

describe("conversation preloads", () => {
  test.each(["/inbox", "/inbox/", "/conversation/session", "/conversation/session/diff"])("warms %s without duplicate shared modules", (path) => {
    dom.reconfigure({ url: `https://codecast.sh${path}` });
    expect(preload()).toEqual(["/boot.js", "/shared.js", "/conversation.js"]);
  });

  test.each(["/", "/org", "/chat", "/inbox-example"])("does not warm the conversation on %s", (path) => {
    dom.reconfigure({ url: `https://codecast.sh${path}` });
    expect(preload()).toEqual(["/boot.js", "/shared.js"]);
  });

  test("keeps share pages on their standalone graph", () => {
    dom.reconfigure({ url: "https://codecast.sh/share/message/token" });
    expect(preload()).toEqual(["/share.js"]);
  });

  test("fetches no app or conversation modules during a desktop handoff", () => {
    dom.window.localStorage.setItem(HANDOFF_MIRROR_KEY, "1");
    expect(preload()).toEqual([]);
  });
});
