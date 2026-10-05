import { describe, expect, test } from "bun:test";
import { encodeForm, formPairs } from "./form";

describe("encodeForm", () => {
  test("nests objects and arrays in brackets and drops absent leaves", () => {
    expect(formPairs({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      metadata: { user_id: "u1", kind: undefined },
      customer: undefined,
      customer_email: null,
      allow_promotion_codes: true,
    })).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price]", "price_1"],
      ["line_items[0][quantity]", "1"],
      ["metadata[user_id]", "u1"],
      ["allow_promotion_codes", "true"],
    ]);
  });

  test("percent-encodes keys and values", () => {
    expect(encodeForm({ success_url: "https://x.test/a?b=c&d=e", metadata: { note: "a b" } }))
      .toBe("success_url=https%3A%2F%2Fx.test%2Fa%3Fb%3Dc%26d%3De&metadata%5Bnote%5D=a%20b");
  });
});
