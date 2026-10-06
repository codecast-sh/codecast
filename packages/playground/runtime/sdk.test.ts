import { expect, test } from "bun:test";
import { GENERATED_PATH, bundleSdk, generatedSource } from "../scripts/build-sdk";

test("the served SDK bundle is built from the current source", async () => {
  expect(await Bun.file(GENERATED_PATH).text()).toBe(await generatedSource());
});

test("the bundle leaves only React to the import map", async () => {
  const code = await bundleSdk();
  const bare = [...code.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("."));
  expect([...new Set(bare)]).toEqual(["react"]);
});
