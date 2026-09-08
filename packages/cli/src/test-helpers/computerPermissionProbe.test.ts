// The gate that decides whether the `cast computer` granted suite runs. Three
// outcomes, and the third one is the whole point: a probe that could not ask
// must be loud. It used to fold into `no-answer`, the suite skipped itself, and
// on a loaded run `0 pass 12 skip 0 fail` read as a pass on a Mac that had
// every grant (ct-49883, same shape as ct-49770).
//
// No helper is launched here: the probe is injected, so every case is instant
// and none of them touches this machine's TCC.

import { describe, expect, test } from "bun:test";
import { probeHelperPermissions, type ProbeRoute } from "./computerPermissionProbe.js";
import type { ComputerPermissionStatus, ComputerPermissionStatusResult } from "../computer/types.js";

const answered = (
  accessibility: ComputerPermissionStatus,
  screenshots: ComputerPermissionStatus,
): ComputerPermissionStatusResult => ({
  platform: "darwin",
  helperAppPath: "/Applications/codecast computer.app",
  helperUnavailableReason: null,
  permissions: [
    { id: "accessibility", status: accessibility },
    { id: "screenshots", status: screenshots },
  ],
});

/** What `getPermissionStatus` returns when the helper is not at the fixed path:
 *  both ids read `not-granted`, but nothing was asked. */
const helperMissing = (): ComputerPermissionStatusResult => ({
  ...answered("not-granted", "not-granted"),
  helperUnavailableReason: "the helper executable was not found",
});

const wedged = () => {
  throw new Error("timed out checking permissions");
};

const noSleep = async (): Promise<void> => {};

describe("probeHelperPermissions", () => {
  test("a granted machine reports both grants", async () => {
    const status = async () => answered("granted", "granted");
    expect(await probeHelperPermissions("disclaimed", { status, sleep: noSleep })).toEqual({
      accessibility: "granted",
      screenshots: "granted",
    });
  });

  test("a definite not-granted is returned, because that skip is the honest one", async () => {
    // This is the answer the granted suite is allowed to skip on, so it must
    // stay a plain return rather than a throw.
    const status = async () => answered("not-granted", "granted");
    expect(await probeHelperPermissions("disclaimed", { status, sleep: noSleep })).toEqual({
      accessibility: "not-granted",
      screenshots: "granted",
    });
  });

  test("a probe that never answers throws, naming every attempt", async () => {
    let attempts = 0;
    const status = async () => { attempts++; return wedged(); };
    await expect(probeHelperPermissions("disclaimed", { status, sleep: noSleep })).rejects.toThrow(
      /cannot tell what `codecast computer` is granted[\s\S]*attempt 1: timed out checking permissions[\s\S]*attempt 2:/,
    );
    expect(attempts).toBe(2);
  });

  test("a momentary failure is retried, not turned into a skip", async () => {
    let attempts = 0;
    const status = async () => (++attempts < 3 ? wedged() : answered("granted", "granted"));
    expect(await probeHelperPermissions("disclaimed", { status, attempts: 3, sleep: noSleep })).toEqual({
      accessibility: "granted",
      screenshots: "granted",
    });
    expect(attempts).toBe(3);
  });

  test("a helper that was not there to answer is could-not-ask, not not-granted", async () => {
    // The result carries `not-granted` for both ids, and reading it that way
    // would skip the suite with a reason that sends the reader to System
    // Settings for a helper that is simply not installed.
    await expect(
      probeHelperPermissions("disclaimed", { status: async () => helperMissing(), sleep: noSleep }),
    ).rejects.toThrow(/the helper executable was not found/);
  });

  test("the route the caller named is the route that is probed, and it is in the failure", async () => {
    const seen: ProbeRoute[] = [];
    const status = async (route: ProbeRoute) => { seen.push(route); return wedged(); };
    await expect(probeHelperPermissions("open", { status, sleep: noSleep })).rejects.toThrow(
      /over the open route/,
    );
    expect(seen).toEqual(["open", "open"]);
  });

  test("the backoff grows, and nothing sleeps after the last attempt", async () => {
    const slept: number[] = [];
    const status = async () => wedged();
    await expect(
      probeHelperPermissions("disclaimed", {
        status,
        attempts: 3,
        delayMs: 10,
        sleep: async (ms) => void slept.push(ms),
      }),
    ).rejects.toThrow();
    expect(slept).toEqual([10, 20]);
  });
});
