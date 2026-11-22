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

  test("recording a run throws, and overwrites nothing, when another process holds the checkout", async () => {
    await claimCheckoutRun(gitDir, async () => false, DEAD);
    expect(() => recordCheckoutRun(gitDir, "run-2", "ct-10", process.pid)).toThrow(CheckoutRunHeld);
    expect(holdOf()).toEqual({ pid: DEAD, at: expect.any(Number) });
  });

  test("two passes that both judge one stale hold: one takes the checkout, the other is refused", async () => {
    fs.mkdirSync(path.join(gitDir, "codecast"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "codecast", "checkout-run.json"), JSON.stringify({ pid: DEAD, run_id: "run-old", at: 1 }));
    // Both read the stale hold and ask after its run before either moves it.
    let asked = 0;
    let release!: () => void;
    const together = new Promise<void>((r) => { release = r; });
    const runLive = async () => { if (++asked === 2) release(); await together; return false; };
    const [first, second] = await Promise.allSettled([claimCheckoutRun(gitDir, runLive, process.pid), claimCheckoutRun(gitDir, runLive, process.ppid)]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const lost = (first.status === "rejected" ? first : second) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(CheckoutRunHeld);
    expect(lost.reason.message).toContain("is starting a pass");
    expect(holdOf().pid).toBe(first.status === "fulfilled" ? process.pid : process.ppid);
    expect(fs.readdirSync(path.join(gitDir, "codecast"))).toEqual(["checkout-run.json"]);
  });

  test("a hold still starting after five minutes is a reused pid's, and is taken over", async () => {
    fs.mkdirSync(path.join(gitDir, "codecast"), { recursive: true });
    // process.ppid is alive, as a reused pid would be.
    fs.writeFileSync(path.join(gitDir, "codecast", "checkout-run.json"), JSON.stringify({ pid: process.ppid, at: Date.now() - 4 * 60_000 }));
    await expect(claimCheckoutRun(gitDir, async () => true, process.pid)).rejects.toThrow("is starting a pass");
    fs.writeFileSync(path.join(gitDir, "codecast", "checkout-run.json"), JSON.stringify({ pid: process.ppid, at: Date.now() - 6 * 60_000 }));
    await claimCheckoutRun(gitDir, async () => true, process.pid);
    expect(holdOf().pid).toBe(process.pid);
  });
});
