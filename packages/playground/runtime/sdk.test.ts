import { expect, test } from "bun:test";
import { GENERATED_PATH, bundleSdk, generatedSource } from "../scripts/build-sdk";

// One bundle for both checks: a second Bun.build in a test process that has
// already loaded convex's own modules fails to read them.
const bundle = bundleSdk();

test("the served SDK bundle is built from the current source", async () => {
  expect(await Bun.file(GENERATED_PATH).text()).toBe(await generatedSource(await bundle));
});

test("the bundle leaves only React to the import map", async () => {
  const code = await bundle;
  const bare = [...code.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("."));
  expect([...new Set(bare)]).toEqual(["react"]);
});
