import { expect, test } from "bun:test";
import { cleanContent, getConversationPreview } from "./conversationProcessor";

test("plain content bypasses cleanup without changing tagged, ANSI or caveat text", () => {
  expect(cleanContent("  Ordinary **markdown**\n  ")).toBe("Ordinary **markdown**");
  expect(cleanContent("<system-reminder>hidden</system-reminder>Visible")).toBe("Visible");
  expect(cleanContent("\x1b[31mRed\x1b[0m")).toBe("Red");
  expect(cleanContent("Visible\n  Caveat: omitted\nEnd")).toBe("Visible\n\nEnd");
  expect(cleanContent("Embedded Caveat: kept")).toBe("Embedded Caveat: kept");
});

test("a preview stops reading once its visible slots are filled", () => {
  const rows = [
    { role: "user", content: "Title" },
    { role: "assistant", content: "Visible" },
    { role: "assistant", get content(): string { throw new Error("unused tail read"); } },
  ];
  expect(getConversationPreview(rows, "Title", 1).map((r) => r.cleanContent)).toEqual(["Visible"]);
  expect(getConversationPreview(rows, "Title", 0)).toEqual([]);
});

test("preview limits keep array slicing semantics", () => {
  const rows = ["First", "Second", "Third"].map((content) => ({ role: "assistant", content }));
  expect(getConversationPreview(rows, "", -1).map((r) => r.content)).toEqual(["First", "Second"]);
  expect(getConversationPreview(rows, "", 1.5).map((r) => r.content)).toEqual(["First"]);
  expect(getConversationPreview(rows, "", NaN)).toEqual([]);
  expect(getConversationPreview(rows, "", Infinity)).toHaveLength(3);
});
