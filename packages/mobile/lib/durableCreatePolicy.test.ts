import { describe, expect, test } from "bun:test";
import { DispatchNotWiredError, StaleDispatchBindingError } from "@codecast/web/store/mutativeMiddleware";
import { mobileCreateFailureDisposition } from "./durableCreatePolicy";

describe("mobile create failure policy", () => {
  test("a durably parked create may continue as pending", () => {
    expect(
      mobileCreateFailureDisposition(
        new DispatchNotWiredError("createSession", true),
      ),
    ).toBe("accepted-pending");
  });

  test("parked:false is a retryable failure, never accepted", () => {
    expect(
      mobileCreateFailureDisposition(
        new DispatchNotWiredError("createSession", false),
      ),
    ).toBe("retry");
  });

  // A cold start rewires the dispatch binding while the first writes are in
  // flight; their outbox rows redeliver under the new binding.
  test("a stale dispatch binding is still on its way", () => {
    expect(
      mobileCreateFailureDisposition(new StaleDispatchBindingError()),
    ).toBe("accepted-pending");
  });

  test("a transient failure stays queued, not refused", () => {
    expect(mobileCreateFailureDisposition(new Error("offline"))).toBe("accepted-pending");
  });
});
