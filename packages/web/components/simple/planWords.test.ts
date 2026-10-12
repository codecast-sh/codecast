import { describe, expect, test } from "bun:test";
import { TYPICAL_REQUEST_USD } from "@codecast/shared/contracts/assistant";
import { requestsLeftWords } from "./planWords";

describe("requestsLeftWords", () => {
  test("counts what is left in everyday requests, rounded down", () => {
    expect(requestsLeftWords(87 * TYPICAL_REQUEST_USD)).toBe("About 80 requests left this month");
    expect(requestsLeftWords(312 * TYPICAL_REQUEST_USD)).toBe("About 300 requests left this month");
    expect(requestsLeftWords(1 * TYPICAL_REQUEST_USD)).toBe("About 1 request left this month");
  });

  test("under one request says so rather than promising one", () => {
    expect(requestsLeftWords(0.001)).toBe("Less than one request left this month");
  });
});
