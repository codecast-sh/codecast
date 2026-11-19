import { describe, expect, test } from "bun:test";
import { chatPlainText, formatChatCopy } from "../chatCopy";

describe("chatPlainText", () => {
  test("links read as their labels, invisible characters drop", () => {
    expect(
      chatPlainText("[@​Aivery](/chat?with=kd7&slack=https%3A%2F%2Fx) see [Arnaud Rubeck](https://x.com/a_(b)) ok"),
    ).toBe("@Aivery see Arnaud Rubeck ok");
  });
});

const at = (h: number, m: number) => new Date(2026, 10, 18, h, m).getTime();
const now = at(18, 0);

describe("formatChatCopy", () => {
  test("one header per run of a person's lines, a blank line between people", () => {
    const out = formatChatCopy(
      [
        { author: "Samvit", createdAt: at(16, 58), text: "in stuff that is essential\n" },
        { author: "Ashot Petrosian", createdAt: at(17, 0), text: "I think one idea" },
        { author: "Ashot Petrosian", createdAt: at(17, 1), text: "or we can modulate them" },
        { author: "Ashot Petrosian", createdAt: at(17, 1), text: "  " },
      ],
      now,
    )!;
    expect(out.text).toBe(
      "Samvit · 4:58 PM\nin stuff that is essential\n\nAshot Petrosian · 5:00 PM\nI think one idea\nor we can modulate them",
    );
    expect(out.html).toContain("<p><strong>Ashot Petrosian</strong> · 5:00 PM</p><p>I think one idea</p>");
  });

  test("a long pause starts a new header; older lines carry their date", () => {
    const out = formatChatCopy(
      [
        { author: "A", createdAt: new Date(2026, 10, 17, 9, 0).getTime(), text: "x" },
        { author: "A", createdAt: new Date(2026, 10, 17, 11, 0).getTime(), text: "y" },
      ],
      now,
    )!;
    expect(out.text).toBe("A · Nov 17, 9:00 AM\nx\n\nA · Nov 17, 11:00 AM\ny");
  });

  test("escapes html and returns null for nothing", () => {
    expect(formatChatCopy([{ author: "<b>", createdAt: now, text: "a<b" }], now)!.html).toContain("&lt;b&gt;");
    expect(formatChatCopy([], now)).toBeNull();
  });
});
