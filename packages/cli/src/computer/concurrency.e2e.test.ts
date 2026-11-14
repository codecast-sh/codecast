/**
 * One app that stopped answering must not hold up a read of another (ct-94267).
 *
 * The helper used to take one lock for every request, and accessibility waits
 * six seconds per unanswered request by default, so a hung app stalled every
 * agent's computer calls on the machine for as long as its walk ran. Now each
 * app has its own lane and an unanswered app fails fast.
 *
 * Needs a helper with Accessibility. By default that is the installed one;
 * `CODECAST_COMPUTER_TEST_HELPER=<exe>` runs a build in place instead, which
 * borrows the grants of the terminal that launched the test. It self-skips off
 * macOS, without a helper, and without the grant.
 *
 *   CODECAST_COMPUTER_TEST_HELPER=native/computer-use-macos/.build/release/codecast-computer \
 *     bun test ./src/computer/concurrency.e2e.test.ts --isolate --path-ignore-patterns=''
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { helperExecutablePath } from "./helperApp.js";
import { ComputerError } from "./errors.js";
import { fixtureClient, launchFixture, type Fixture } from "../test-helpers/computerBenchFixture.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import type { ComputerClient } from "./client.js";

const inPlace = process.env.CODECAST_COMPUTER_TEST_HELPER;

let client: ComputerClient;
let live: Fixture;
let hung: Fixture;

const reason = await (async (): Promise<string | null> => {
  if (process.platform !== "darwin") return "not macOS";
  if (!fs.existsSync(inPlace ?? helperExecutablePath())) return `no helper at ${inPlace ?? helperExecutablePath()}`;
  client = fixtureClient(inPlace);
  live = await launchFixture();
  const probe = await client.getAppState({ app: `pid:${live.pid}`, noScreenshot: true }).catch((e: unknown) => e);
  if (probe instanceof ComputerError && probe.code === "permission_denied") return "Accessibility is not granted to the helper under test";
  hung = await launchFixture(["--barren", "--hang"]);
  await pollUntil(() => hung.output().includes("HUNG"), "the fixture to hang");
  return null;
})();

afterAll(() => {
  live?.child.kill();
  hung?.child.kill("SIGKILL");
  client?.shutdown();
  for (const f of [live?.statusFile, hung?.statusFile]) if (f) fs.rmSync(f, { force: true });
});

(reason ? test.skip : test)(
  `a read of one app is answered while another app hangs${reason ? ` (skipped: ${reason})` : ""}`,
  async () => {
    const startedAt = performance.now();
    const stalled = client.getAppState({ app: `pid:${hung.pid}`, noScreenshot: true }).then(
      () => null,
      (e: unknown) => ({ error: e as ComputerError, ms: performance.now() - startedAt }),
    );
    await Bun.sleep(100);

    const readAt = performance.now();
    const read = await client.getAppState({ app: `pid:${live.pid}`, windowId: live.windows["Bench Form"], noScreenshot: true });
    const readMs = performance.now() - readAt;
    expect(read.snapshot.treeText).toContain("Subscribe");
    // Far under the hung app's own timeout: the read never waited behind it.
    expect(readMs).toBeLessThan(1_500);

    const outcome = await stalled;
    expect(outcome).not.toBeNull();
    expect(outcome!.error.code).toBe("action_timeout");
    expect(outcome!.error.message).toContain("did not answer");
    // One read timeout, not one per request of a walk.
    expect(outcome!.ms).toBeLessThan(8_000);
  },
  60_000,
);
