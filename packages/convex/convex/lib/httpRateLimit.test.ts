import { describe, expect, test } from "bun:test";
import { clientIp } from "./httpRateLimit";

const req = (headers: Record<string, string>) => new Request("https://x.test/", { headers });

describe("clientIp", () => {
  test("takes the address our own proxy appended (rightmost), never one the client wrote", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });
  test("ignores headers the client can set freely when the proxy's address is there", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "6.6.6.6", "x-real-ip": "7.7.7.7" }))).toBe("203.0.113.9");
  });
});
