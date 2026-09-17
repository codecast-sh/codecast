import { describe, expect, test } from "bun:test";
import { nativeComposerText } from "./composerField";

describe("nativeComposerText", () => {
  test("uses the native box when React state has not caught up", () => {
    expect(nativeComposerText({ _lastNativeText: "hello from the field" }, "")).toBe(
      "hello from the field",
    );
  });

  test("falls back to the controlled value when native text is missing", () => {
    expect(nativeComposerText(null, "typed")).toBe("typed");
    expect(nativeComposerText({}, "typed")).toBe("typed");
    expect(nativeComposerText({ _lastNativeText: 1 }, "typed")).toBe("typed");
  });
});
