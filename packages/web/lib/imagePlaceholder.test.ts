import { describe, it, expect } from "vitest";
import {
  imagePlaceholderToken,
  insertImagePlaceholder,
  dropImagePlaceholder,
} from "./imagePlaceholder";

describe("insertImagePlaceholder", () => {
  it("inserts into an empty draft with no leading space", () => {
    expect(insertImagePlaceholder("", 0, 1)).toEqual({ text: "[Image 1] ", caret: 10 });
  });

  it("appends after existing text with one separating space", () => {
    const r = insertImagePlaceholder("look at", 7, 1);
    expect(r.text).toBe("look at [Image 1] ");
    expect(r.caret).toBe(r.text.length);
  });

  it("does not double the space the user already typed", () => {
    expect(insertImagePlaceholder("look at ", 8, 2).text).toBe("look at [Image 2] ");
  });

  it("inserts at the caret, not the end", () => {
    const r = insertImagePlaceholder("crop like and ship", 10, 1);
    expect(r.text).toBe("crop like [Image 1] and ship");
    // Caret lands after the inserted token so typing continues naturally.
    expect(r.text.slice(0, r.caret)).toBe("crop like [Image 1] ");
  });

  it("borrows the following space instead of adding one", () => {
    expect(insertImagePlaceholder("a b", 2, 1).text).toBe("a [Image 1] b");
  });

  it("keeps a newline before the token intact", () => {
    expect(insertImagePlaceholder("line\n", 5, 1).text).toBe("line\n[Image 1] ");
  });

  it("clamps a caret past the end", () => {
    expect(insertImagePlaceholder("ab", 99, 1).text).toBe("ab [Image 1] ");
  });

  it("numbers by attach order", () => {
    let text = "";
    for (let n = 1; n <= 3; n++) text = insertImagePlaceholder(text, text.length, n).text;
    expect(text).toBe("[Image 1] [Image 2] [Image 3] ");
  });
});

describe("dropImagePlaceholder", () => {
  it("removes the token and closes the sentence up", () => {
    expect(dropImagePlaceholder("see [Image 2] here", 2)).toBe("see here");
  });

  it("leaves no leading space when the token started the draft", () => {
    expect(dropImagePlaceholder("[Image 1] here", 1)).toBe("here");
  });

  it("leaves no trailing space when the token ended the draft", () => {
    expect(dropImagePlaceholder("see [Image 1]", 1)).toBe("see");
  });

  it("renumbers higher tokens down", () => {
    expect(dropImagePlaceholder("a [Image 1] b [Image 2] c [Image 3]", 1)).toBe(
      "a b [Image 1] c [Image 2]"
    );
  });

  it("leaves lower tokens alone", () => {
    expect(dropImagePlaceholder("[Image 1] and [Image 2] and [Image 3]", 2)).toBe(
      "[Image 1] and and [Image 2]"
    );
  });

  it("removes every occurrence of a token the user duplicated", () => {
    expect(dropImagePlaceholder("[Image 1] vs [Image 1]", 1)).toBe("vs");
  });

  it("is a no-op when the draft never mentioned the image", () => {
    expect(dropImagePlaceholder("just prose", 1)).toBe("just prose");
  });

  it("does not touch the user's own line breaks", () => {
    expect(dropImagePlaceholder("first\n[Image 1]\nlast", 1)).toBe("first\n\nlast");
  });

  it("does not renumber a lookalike with a different number width", () => {
    expect(dropImagePlaceholder("[Image 1] [Image 10]", 1)).toBe("[Image 9]");
  });
});

describe("imagePlaceholderToken", () => {
  it("is the format the insert and drop paths agree on", () => {
    const inserted = insertImagePlaceholder("", 0, 4).text;
    expect(inserted).toContain(imagePlaceholderToken(4));
    expect(dropImagePlaceholder(inserted, 4).trim()).toBe("");
  });
});
