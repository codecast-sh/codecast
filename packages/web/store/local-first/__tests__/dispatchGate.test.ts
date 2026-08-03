import { expect, test } from "bun:test";
import {
  capturePrincipalDispatchAuthorization,
  getPrincipalDispatchCorrelationEpoch,
  isPrincipalDispatchAuthorizationCurrent,
  registerPrincipalDispatchRuntime,
  updatePrincipalDispatchCorrelation,
} from "../dispatchGate";

// Dispatch is wired unconditionally: no runtime registration or correlation
// state may ever withhold authorization.

test("authorization is always available, before any registration", () => {
  const capture = capturePrincipalDispatchAuthorization();
  expect(capture).not.toBeNull();
  expect(isPrincipalDispatchAuthorizationCurrent(capture!)).toBe(true);
  expect(getPrincipalDispatchCorrelationEpoch()).not.toBeNull();
});

test("registration and correlation churn cannot revoke authorization", () => {
  const capture = capturePrincipalDispatchAuthorization()!;
  registerPrincipalDispatchRuntime(null);
  updatePrincipalDispatchCorrelation(null);
  updatePrincipalDispatchCorrelation(42);
  registerPrincipalDispatchRuntime({ canDispatch: false, subscribe: () => () => {} });
  expect(isPrincipalDispatchAuthorizationCurrent(capture)).toBe(true);
  expect(capturePrincipalDispatchAuthorization()).not.toBeNull();
  expect(getPrincipalDispatchCorrelationEpoch()).not.toBeNull();
});

test("a capture taken at any time stays current forever", () => {
  const early = capturePrincipalDispatchAuthorization()!;
  updatePrincipalDispatchCorrelation(7);
  const late = capturePrincipalDispatchAuthorization()!;
  expect(isPrincipalDispatchAuthorizationCurrent(early)).toBe(true);
  expect(isPrincipalDispatchAuthorizationCurrent(late)).toBe(true);
});
