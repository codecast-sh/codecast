// ct-73198: a VITE_CONVEX_URL that is set but not an absolute http(s) URL must
// fall back, because the Convex client opens its WebSocket from it.
import { afterEach, expect, test } from "bun:test";
import { getConvexUrl } from "../convexUrl";

const saved = process.env.VITE_CONVEX_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.VITE_CONVEX_URL;
  else process.env.VITE_CONVEX_URL = saved;
});

for (const bad of ["convex.codecast.sh", "", "   ", "ws:/broken"]) {
  test(`VITE_CONVEX_URL=${JSON.stringify(bad)} falls back`, () => {
    process.env.VITE_CONVEX_URL = bad;
    expect(getConvexUrl()).toBe("https://convex.codecast.sh");
  });
}

test("a valid absolute URL is kept", () => {
  process.env.VITE_CONVEX_URL = "https://happy-otter-123.convex.cloud";
  expect(getConvexUrl()).toBe("https://happy-otter-123.convex.cloud");
  process.env.VITE_CONVEX_URL = "http://127.0.0.1:3210";
  expect(getConvexUrl()).toBe("http://127.0.0.1:3210");
});
