import { describe, expect, test } from "bun:test";
import { momentWho, parseExtractorOutput } from "./moments";

describe("who a moment is about", () => {
  test("the extractor's own who wins, and parses through", () => {
    const out = parseExtractorOutput(JSON.stringify({ blocks: [], refs: [], who: "Marilyn Priest, called by Logan" }));
    expect("error" in out ? null : momentWho(out)).toBe("Marilyn Priest, called by Logan");
  });
  test("else the first facts block's Contact or Name", () => {
    expect(momentWho({ blocks: [{ type: "facts", title: "Session", facts: [{ label: "Contact", value: "Marilyn Priest" }, { label: "Direction", value: "outgoing" }] }] } as never)).toBe("Marilyn Priest");
    expect(momentWho({ blocks: [{ type: "text", title: "x", text: "y" }, { type: "facts", title: "Contact", facts: [{ label: "Name", value: "Bruna Sanjuan" }, { label: "Title", value: "Artist Liaison" }] }] } as never)).toBe("Bruna Sanjuan");
  });
  test("never an id: no person fact names nobody", () => {
    expect(momentWho({ blocks: [{ type: "facts", title: "Match", facts: [{ label: "status", value: "live" }] }] } as never)).toBeNull();
  });
});
