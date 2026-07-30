import { describe, expect, test } from "bun:test";
import { DispatchNotWiredError } from "@codecast/web/store/mutativeMiddleware";
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

  test("ordinary dispatch/storage failures stay visible", () => {
    expect(mobileCreateFailureDisposition(new Error("offline"))).toBe("retry");
  });
});
