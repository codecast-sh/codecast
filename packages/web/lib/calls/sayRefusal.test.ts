// A refused press is said where the window can show it: a toast in the app,
// a system banner on the desktop float, which hides its toaster under the
// same html class sayRefusal reads.
// Run: bun test --timeout 120000 lib/calls/sayRefusal.test.ts
import { beforeAll, beforeEach, expect, mock, test } from "bun:test";

const toasts: string[] = [];
const banners: Array<{ title: string; body: string; key?: string }> = [];
mock.module("sonner", () => ({ toast: Object.assign(() => {}, { error: (m: string) => toasts.push(m) }) }));
mock.module("../desktop", () => ({
  notifyNative: async (title: string, body: string, data?: { key?: string }) => (banners.push({ title, body, key: data?.key }), true),
}));

let sayRefusal: typeof import("./sayRefusal").sayRefusal;
let TOASTLESS_WINDOW_CLASS: string;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true, writable: true });
  ({ sayRefusal, TOASTLESS_WINDOW_CLASS } = await import("./sayRefusal"));
});

beforeEach(() => {
  toasts.length = 0;
  banners.length = 0;
  document.documentElement.classList.remove(TOASTLESS_WINDOW_CLASS);
});

test("in a window with toasts, the reason is a toast", () => {
  sayRefusal("Could not stop the recording")("Only someone in the call can stop it");
  expect(toasts).toEqual(["Only someone in the call can stop it"]);
  expect(banners).toEqual([]);
});

test("on the float, which hides its toaster, the reason goes up as a system banner", () => {
  document.documentElement.classList.add(TOASTLESS_WINDOW_CLASS);
  sayRefusal("Could not stop the recording")("Could not confirm with the server");
  sayRefusal("Could not remove Ann")("Could not remove them");
  expect(toasts).toEqual([]);
  expect(banners.map(({ title, body }) => ({ title, body }))).toEqual([
    { title: "Could not stop the recording", body: "Could not confirm with the server" },
    { title: "Could not remove Ann", body: "Could not remove them" },
  ]);
  expect(banners[0].key).toBeTruthy();
});

test("the class is the one voiceHost.css hides the toaster under", async () => {
  const css = await Bun.file(new URL("../../components/calls/voiceHost.css", import.meta.url)).text();
  expect(css).toContain(`.${TOASTLESS_WINDOW_CLASS} [data-sonner-toaster]`);
});
