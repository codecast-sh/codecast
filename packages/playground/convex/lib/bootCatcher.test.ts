import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { BOOT_CATCHER, PROTOCOL, SDK_LOADED_FLAG, withBootCatcher } from "./bootCatcher";

test("the catcher goes first inside <head>, or first of all", () => {
  expect(withBootCatcher("<!doctype html><html><head lang=x><title>a</title></head></html>")).toBe(
    `<!doctype html><html><head lang=x>${BOOT_CATCHER}<title>a</title></head></html>`,
  );
  expect(withBootCatcher("<p>hi</p>")).toBe(`${BOOT_CATCHER}<p>hi</p>`);
});

/** Run the catcher in a page whose parent records what it hears. */
function page() {
  const window = new Window({ url: "https://run.test/", settings: { disableJavaScriptFileLoading: true } });
  const heard: unknown[] = [];
  Object.defineProperty(window, "parent", { value: { postMessage: (m: unknown) => heard.push(m) } });
  const code = BOOT_CATCHER.replace(/^<script>|<\/script>$/g, "");
  // Run with the page's globals, as the browser would.
  new Function("window", "parent", "addEventListener", "HTMLScriptElement", "HTMLLinkElement", code)(
    window, window.parent, window.addEventListener.bind(window), window.HTMLScriptElement, window.HTMLLinkElement,
  );
  return { window, heard };
}

test("until the SDK runs, a script that failed to load and an uncaught error reach the shell", () => {
  const { window, heard } = page();
  const script = window.document.createElement("script");
  script.setAttribute("src", "src/main.jsx");
  window.document.head.appendChild(script);
  window.dispatchEvent(new window.ErrorEvent("error", { message: "boom", error: new Error("boom") }));
  expect(heard).toEqual([
    { protocol: PROTOCOL, type: "error", message: "Couldn't load src/main.jsx or a module it imports" },
    { protocol: PROTOCOL, type: "error", message: "boom" },
  ]);
});

test("once the SDK has taken over, the catcher stays quiet", () => {
  const { window, heard } = page();
  (window as unknown as Record<string, boolean>)[SDK_LOADED_FLAG] = true;
  window.dispatchEvent(new window.ErrorEvent("error", { message: "late" }));
  expect(heard).toEqual([]);
});
