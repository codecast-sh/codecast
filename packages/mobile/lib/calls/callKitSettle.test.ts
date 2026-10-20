// A CallKit ring answered or declined on another device ends on the phone,
// even when the phone was woken locked and cannot read its sign-in.
// The fixture runs in its own process: it mocks react-native and the clock.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("a ring settled elsewhere ends the CallKit call, signed out too", async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/callKitSettle.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, output: stdout + stderr }).toMatchObject({ status: 0 });
}, 65_000);
