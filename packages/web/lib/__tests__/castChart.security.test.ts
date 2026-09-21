import { expect, test } from "bun:test";

test("chart sanitizer pipeline in an isolated DOM", () => {
  const result = Bun.spawnSync([process.execPath, "test", new URL("./fixtures/castChart.security.ts", import.meta.url).pathname], { timeout: 90_000 });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 95_000);
