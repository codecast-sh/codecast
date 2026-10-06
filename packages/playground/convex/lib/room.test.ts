import { describe, expect, test } from "bun:test";
import { ELEMENT_FIELD_MAX, MESSAGE_BODY_MAX } from "./limits";
import { cleanElement, cleanMessageBody } from "./room";

describe("message bodies", () => {
  test("trims the ends, keeps inner lines, normalizes line endings", () => {
    expect(cleanMessageBody("  make it blue\r\nand bigger  ")).toBe("make it blue\nand bigger");
  });

  test("empty is null; long is capped", () => {
    expect(cleanMessageBody(" \n\t ")).toBeNull();
    expect(cleanMessageBody("z".repeat(MESSAGE_BODY_MAX + 50))).toHaveLength(MESSAGE_BODY_MAX);
  });
});

describe("element references", () => {
  test("caps every field and folds the text to one line", () => {
    const el = cleanElement({
      selector: "s".repeat(1_000),
      tag: " BUTTON ",
      text: "  Wave\n   hello ",
      snippet: "p".repeat(1_000),
    })!;
    expect(el.selector).toHaveLength(ELEMENT_FIELD_MAX.selector);
    expect(el.tag).toBe("button");
    expect(el.text).toBe("Wave hello");
    expect(el.snippet).toHaveLength(ELEMENT_FIELD_MAX.snippet);
  });

  test("drops empty optional fields; a reference naming nothing is null", () => {
    expect(cleanElement({ selector: "#go", tag: "a", text: "  " })).toEqual({ selector: "#go", tag: "a" });
    expect(cleanElement({ selector: " ", tag: "a" })).toBeNull();
  });
});
