import { expect, test } from "bun:test";
import { signCallerAddress, verifyCallerAddress } from "./agentAccess";

test("a caller address signed with the shared secret verifies, and nothing else does", async () => {
  const sig = await signCallerAddress("s3cret", "203.0.113.9");
  expect(await verifyCallerAddress("s3cret", "203.0.113.9", sig)).toBe(true);
  expect(await verifyCallerAddress("s3cret", "198.51.100.1", sig)).toBe(false);
  expect(await verifyCallerAddress("other", "203.0.113.9", sig)).toBe(false);
  expect(await verifyCallerAddress("s3cret", "203.0.113.9", "")).toBe(false);
});
