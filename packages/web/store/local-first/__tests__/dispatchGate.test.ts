import { afterEach, describe, expect, test } from "bun:test";
import {
  capturePrincipalDispatchAuthorization,
  isPrincipalDispatchAuthorizationCurrent,
  registerPrincipalDispatchRuntime,
  subscribePrincipalDispatchCorrelation,
  updatePrincipalDispatchCorrelation,
} from "../dispatchGate";

const flushNotification = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(async () => {
  updatePrincipalDispatchCorrelation(null);
  registerPrincipalDispatchRuntime(null);
  await flushNotification();
});

describe("web principal dispatch correlation", () => {
  test("revokes captures synchronously and publishes the hook update after render", async () => {
    registerPrincipalDispatchRuntime({
      canDispatch: true,
      dispatchPrincipalEpoch: 1,
      subscribe: () => () => {},
    });
    updatePrincipalDispatchCorrelation(1);
    await flushNotification();

    const accountA = capturePrincipalDispatchAuthorization();
    expect(accountA).not.toBeNull();
    let notifications = 0;
    const unsubscribe = subscribePrincipalDispatchCorrelation(() => { notifications++; });

    updatePrincipalDispatchCorrelation(2);
    // Correctness does not wait for a React effect or external-store callback.
    expect(isPrincipalDispatchAuthorizationCurrent(accountA!)).toBe(false);
    expect(notifications).toBe(0);
    const accountB = capturePrincipalDispatchAuthorization();
    expect(accountB?.principalEpoch).toBe(2);

    await flushNotification();
    expect(notifications).toBe(1);
    expect(isPrincipalDispatchAuthorizationCurrent(accountB!)).toBe(true);
    unsubscribe();
  });
});
