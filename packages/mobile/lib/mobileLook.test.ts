import { expect, test } from "bun:test";
import { mobileLookSource, resolveMobileLook } from "./mobileLook";

test("a phone that never chose follows the web's Modern switch", () => {
  expect(resolveMobileLook({ modern_style: true })).toBe("modern");
  expect(resolveMobileLook({ modern_style: false })).toBe("classic");
  expect(mobileLookSource({ modern_style: true })).toBe("web");
});

test("Modern when neither the phone nor the web has chosen", () => {
  expect(resolveMobileLook(undefined)).toBe("modern");
  expect(resolveMobileLook(null)).toBe("modern");
  expect(resolveMobileLook({})).toBe("modern");
  // An old Minimal choice on the web, made before Modern existed, stays off Modern.
  expect(resolveMobileLook({ visual_style: "minimal" })).toBe("classic");
});

test("the phone's own choice wins over the web's, either way", () => {
  // Modern in a browser, Classic chosen on this phone: the phone stays Classic.
  expect(resolveMobileLook({ modern_style: true, mobile_modern_style: false })).toBe("classic");
  expect(resolveMobileLook({ modern_style: false, mobile_modern_style: true })).toBe("modern");
  expect(resolveMobileLook({ mobile_modern_style: true })).toBe("modern");
  expect(mobileLookSource({ modern_style: true, mobile_modern_style: false })).toBe("phone");
});

test("a cleared or malformed phone choice means follow the web", () => {
  // "Same as web" writes null.
  expect(resolveMobileLook({ modern_style: true, mobile_modern_style: null })).toBe("modern");
  expect(mobileLookSource({ modern_style: true, mobile_modern_style: null })).toBe("web");
  // Only a real boolean counts, for either key.
  expect(resolveMobileLook({ modern_style: "true", mobile_modern_style: "false", visual_style: "minimal" })).toBe("classic");
  expect(resolveMobileLook({ modern_style: 1, visual_style: "minimal" })).toBe("classic");
  expect(resolveMobileLook({ modern_style: 0 })).toBe("modern");
});
