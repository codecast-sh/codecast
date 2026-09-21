import { expect, test } from "bun:test";

test("task evidence opens the shared gallery and isolates images by task", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./components/__tests__/fixtures/taskEvidenceGallery.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 45_000,
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
}, 50_000);
