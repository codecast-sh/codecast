import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("channel huddle warning, cancellation, start and occupied-room behavior", async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/channelHuddle.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, output: stdout + stderr }).toMatchObject({ status: 0 });
}, 65_000);
