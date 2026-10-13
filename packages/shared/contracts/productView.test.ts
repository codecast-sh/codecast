import { describe, expect, test } from "bun:test";
import {
  PRODUCT_VIEW_HOST_SOURCE,
  PRODUCT_VIEW_SOURCE,
  formatProductViewRef,
  isProductViewHostMessage,
  parseProductViewMessage,
  parseProductViewRef,
} from "./productView";

const contact = "3f2b8c1e-9d4a-4e2b-8f1c-0a1b2c3d4e5f";

describe("parseProductViewRef", () => {
  test("reads app, view, id and an optional moment, and formats back", () => {
    const at = "2026-10-09T14:03:00Z";
    const ref = parseProductViewRef(`union:conversation/${contact}@${at}`);
    expect(ref).toEqual({ app: "union", view: "conversation", id: contact, at });
    expect(formatProductViewRef(ref!)).toBe(`union:conversation/${contact}@${at}`);
    expect(parseProductViewRef(`union:call/${contact}`)).toEqual({ app: "union", view: "call", id: contact, at: null });
    expect(parseProductViewRef(` union:need/abc123 `)?.id).toBe("abc123");
    expect(parseProductViewRef(`union:conversation/${contact}@2026-10-09T14:03:00.123+02:00`)?.at).toBe("2026-10-09T14:03:00.123+02:00");
  });

  test("refuses malformed parts", () => {
    for (const raw of [
      "union/conversation/x",
      "union:conversation",
      "union:conversation/",
      "Union:conversation/x",
      "union:conversation/x/y",
      "union:conversation/../x",
      "union:conversation/x@yesterday",
      "union:conversation/x@2026-10-09",
      "union:conversation/x@2026-13-40T99:99:00Z",
      "union:conversation/a b",
    ]) {
      expect(parseProductViewRef(raw)).toBeNull();
    }
  });
});

describe("frame messages", () => {
  test("parses the frame's messages field by field", () => {
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "hello" })).toEqual({ source: PRODUCT_VIEW_SOURCE, type: "hello" });
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "ready", height: 412.4 })).toEqual({ source: PRODUCT_VIEW_SOURCE, type: "ready", height: 413 });
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "height", height: 1e9 })?.type).toBe("height");
    expect((parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "height", height: 1e9 }) as any).height).toBe(20_000);
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "error", message: "expired" })).toMatchObject({ type: "error", message: "expired" });
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "height", height: -1 })).toBeNull();
    expect(parseProductViewMessage({ source: PRODUCT_VIEW_SOURCE, type: "height", height: "12" })).toBeNull();
    expect(parseProductViewMessage({ source: "codecast-replay-player", type: "ready", height: 1 })).toBeNull();
    expect(parseProductViewMessage(null)).toBeNull();
    expect(isProductViewHostMessage({ source: PRODUCT_VIEW_HOST_SOURCE, type: "hello" })).toBe(true);
    expect(isProductViewHostMessage({ source: PRODUCT_VIEW_SOURCE, type: "hello" })).toBe(false);
  });
});
