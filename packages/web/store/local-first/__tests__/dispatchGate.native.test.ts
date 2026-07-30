import { afterEach, describe, expect, test } from "bun:test";
import {
  capturePrincipalDispatchAuthorization,
  getPrincipalDispatchCorrelationEpoch,
  isPrincipalDispatchAuthorizationCurrent,
  subscribePrincipalDispatchCorrelation,
  updatePrincipalDispatchCorrelation,
} from "../dispatchGate.native";

const flushNotification = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(async () => {
  updatePrincipalDispatchCorrelation(null);
  await flushNotification();
});

describe("native principal dispatch correlation", () => {
  test("changes the allowed snapshot identity when correlation epoch changes", () => {
    updatePrincipalDispatchCorrelation(10);
    const accountA = getPrincipalDispatchCorrelationEpoch();
    updatePrincipalDispatchCorrelation(11);
    const accountB = getPrincipalDispatchCorrelationEpoch();

    expect(accountA).not.toBeNull();
    expect(accountB).not.toBeNull();
    expect(accountB).not.toBe(accountA);
  });

  test("subject changes deny stale work immediately and notify mounted consumers", async () => {
    updatePrincipalDispatchCorrelation(10);
    await flushNotification();
    const accountA = capturePrincipalDispatchAuthorization();
    expect(accountA?.principalEpoch).toBe(10);

    let notifications = 0;
    const unsubscribe = subscribePrincipalDispatchCorrelation(() => { notifications++; });
    updatePrincipalDispatchCorrelation(11);
    expect(isPrincipalDispatchAuthorizationCurrent(accountA!)).toBe(false);
    expect(notifications).toBe(0);

    const accountB = capturePrincipalDispatchAuthorization();
    expect(accountB?.principalEpoch).toBe(11);
    await flushNotification();
    expect(notifications).toBe(1);

    updatePrincipalDispatchCorrelation(null);
    expect(capturePrincipalDispatchAuthorization()).toBeNull();
    expect(isPrincipalDispatchAuthorizationCurrent(accountB!)).toBe(false);
    await flushNotification();
    expect(notifications).toBe(2);
    unsubscribe();
  });
});
