import { describe, expect, test } from "bun:test";
import { sendableText } from "./sendableText";

describe("sendableText", () => {
  test("the first quoted passage, without its marks, blank quote lines kept", () => {
    const md = "Here's a draft you can send:\n\n> Hi [Name],\n>\n> Thank you so much for the invitation.\n> Love, Sam\n\nWant it warmer?";
    expect(sendableText(md)).toBe("Hi [Name],\n\nThank you so much for the invitation.\nLove, Sam");
  });

  test("an answer that quotes nothing has nothing to copy", () => {
    expect(sendableText("Done. I added it to your to-dos.")).toBeNull();
    expect(sendableText("")).toBeNull();
    expect(sendableText(">   ")).toBeNull();
  });

  test("a quote mark inside a code block is not a quote", () => {
    expect(sendableText("```\n> not this\n```\n\n> This one")).toBe("This one");
  });
});
