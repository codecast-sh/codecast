// One pass through a flow per shared checkout (ship-checkout.md): a second
// `cast flow run --checkout` is refused while the first run is live, and a hold
// whose starter died or whose run ended is taken over.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckoutRunHeld, claimCheckoutRun, recordCheckoutRun } from "./checkoutRunHold";

let gitDir = "";
beforeEach(() => { gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-checkout-hold-")); });
afterEach(() => fs.rmSync(gitDir, { recursive: true, force: true }));

const holdOf = () => JSON.parse(fs.readFileSync(path.join(gitDir, "codecast", "checkout-run.json"), "utf-8"));
// A pid no process has: far above any this machine hands out.
const DEAD = 2 ** 22 + 12345;

describe("the checkout's pass hold", () => {
  test("a second pass is refused while the first run is live, naming it, and goes once that run has ended", async () => {
    const status: Record<string, boolean | null> = { "run-1": true };
    const runLive = async (id: string) => (id in status ? status[id] : false);
    await claimCheckoutRun(gitDir, runLive, process.pid);
    recordCheckoutRun(gitDir, "run-1", "ct-9", process.pid);
    expect(holdOf()).toMatchObject({ run_id: "run-1", task: "ct-9" });

    // Another invocation (its own pid) while run-1 is live.
    const second = claimCheckoutRun(gitDir, runLive, DEAD);
    await expect(second).rejects.toBeInstanceOf(CheckoutRunHeld);
    await expect(claimCheckoutRun(gitDir, runLive, DEAD)).rejects.toThrow("already live in this checkout: run run-1 on ct-9");

    // Unreadable is not over.
    status["run-1"] = null;
    await expect(claimCheckoutRun(gitDir, runLive, DEAD)).rejects.toThrow("cannot be read");

    status["run-1"] = false;
    await claimCheckoutRun(gitDir, runLive, DEAD);
    expect(holdOf()).toMatchObject({ pid: DEAD });
    expect(holdOf().run_id).toBeUndefined();
  });

  test("a pass still starting holds the checkout while its process lives; a dead starter's hold is taken over", async () => {
    const runLive = async () => true;
    // This test's own process is a live starter that has not made its run yet.
    await claimCheckoutRun(gitDir, runLive, process.pid);
    await expect(claimCheckoutRun(gitDir, runLive, DEAD)).rejects.toThrow(`(pid ${process.pid}) is starting a pass`);

    fs.writeFileSync(path.join(gitDir, "codecast", "checkout-run.json"), JSON.stringify({ pid: DEAD, at: 1 }));
    await claimCheckoutRun(gitDir, runLive, process.pid);
    expect(holdOf().pid).toBe(process.pid);
  });

  test("recording a run never overwrites a hold another process took", async () => {
    await claimCheckoutRun(gitDir, async () => false, DEAD);
    recordCheckoutRun(gitDir, "run-2", "ct-10", process.pid);
    expect(holdOf()).toEqual({ pid: DEAD, at: expect.any(Number) });
  });
});
