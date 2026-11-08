import { afterEach, expect, test } from "bun:test";

// Hermes has no `crypto`; the shared store's sendEscape calls
// crypto.randomUUID() from the Stop press, which crashed the app.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function loadPolyfills() {
  const path = require.resolve("./polyfills");
  delete require.cache[path];
  require(path);
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "crypto", original);
});

test("installs crypto.randomUUID where the runtime has no crypto", () => {
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  loadPolyfills();
  const id = (globalThis as any).crypto.randomUUID();
  expect(id).toMatch(UUID_V4);
  expect((globalThis as any).crypto.randomUUID()).not.toBe(id);
});

test("adds randomUUID beside an existing getRandomValues", () => {
  let filled = 0;
  const partial = { getRandomValues: (b: Uint8Array) => { filled++; b.fill(7); return b; } };
  Object.defineProperty(globalThis, "crypto", { value: partial, configurable: true, writable: true });
  loadPolyfills();
  expect((globalThis as any).crypto).toBe(partial);
  expect((globalThis as any).crypto.randomUUID()).toMatch(UUID_V4);
  expect(filled).toBe(1);
});

test("leaves a native randomUUID alone", () => {
  const native = { randomUUID: () => "native" };
  Object.defineProperty(globalThis, "crypto", { value: native, configurable: true, writable: true });
  loadPolyfills();
  expect((globalThis as any).crypto.randomUUID()).toBe("native");
});
