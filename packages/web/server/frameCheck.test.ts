import { describe, expect, test } from "bun:test";
import { framingVerdict } from "./frameCheck";

const APP = "https://codecast.sh";
const v = (h: Record<string, string>, page = "https://example.com/x", app = APP) => framingVerdict(new Headers(h), page, app);

describe("framingVerdict", () => {
  test("no headers allows", () => expect(v({})).toBe("allows"));
  test("X-Frame-Options DENY refuses", () => expect(v({ "x-frame-options": "DENY" })).toBe("refuses"));
  test("SAMEORIGIN refuses another origin, allows its own", () => {
    expect(v({ "x-frame-options": "SAMEORIGIN" })).toBe("refuses");
    expect(v({ "x-frame-options": "sameorigin" }, "https://codecast.sh/a")).toBe("allows");
  });
  test("ALLOW-FROM is ignored", () => expect(v({ "x-frame-options": "ALLOW-FROM https://x.com" })).toBe("allows"));
  test("frame-ancestors overrides X-Frame-Options", () => {
    expect(v({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" })).toBe("allows");
    expect(v({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })).toBe("refuses");
    expect(v({ "content-security-policy": "frame-ancestors 'self'" })).toBe("refuses");
  });
  test("host sources", () => {
    expect(v({ "content-security-policy": "frame-ancestors https://*.codecast.sh" }, undefined, "https://local.codecast.sh")).toBe("allows");
    expect(v({ "content-security-policy": "frame-ancestors https://*.codecast.sh" })).toBe("refuses");
    expect(v({ "content-security-policy": "frame-ancestors codecast.sh" })).toBe("allows");
    expect(v({ "content-security-policy": "frame-ancestors https:" })).toBe("allows");
  });
  test("every policy must allow", () => {
    expect(v({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" })).toBe("refuses");
  });
  test("a policy without frame-ancestors does not restrict", () => {
    expect(v({ "content-security-policy": "script-src 'self'" })).toBe("allows");
  });
});
