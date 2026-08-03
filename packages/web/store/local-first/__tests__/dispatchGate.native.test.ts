import { expect, test } from "bun:test";
import {
  capturePrincipalDispatchAuthorization,
  getPrincipalDispatchCorrelationEpoch,
  isPrincipalDispatchAuthorizationCurrent,
  registerPrincipalDispatchRuntime,
  updatePrincipalDispatchCorrelation,
} from "../dispatchGate.native";

// Native twin: dispatch is wired unconditionally, mirroring the web module.

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
});
