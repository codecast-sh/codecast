import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("mobile channel huddles confirm before ringing or opening the call screen", async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/channelHuddle.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, output: stdout + stderr }).toMatchObject({ status: 0 });
}, 65_000);
