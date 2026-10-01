import { describe, expect, test } from "bun:test";
import { cleanNotificationBody, speakableAgentLine } from "./plainText";

describe("speakableAgentLine", () => {
  test("markup and code leave; the words stay", () => {
    expect(speakableAgentLine("## Done\nThe **fix** is in `auth.ts`.\n```ts\nx()\n```\n- tests pass")).toBe("Done The fix is in auth.ts. tests pass");
  });

  test("a long reply ends on a whole sentence", () => {
    const text = `${"This sentence is filler. ".repeat(40)}And this is the end.`;
    const out = speakableAgentLine(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("filler.")).toBe(true);
  });

  test("a long reply with no sentence break ends on a word", () => {
    const out = speakableAgentLine("word ".repeat(100), 50);
    expect(out.endsWith("word…")).toBe(true);
  });

  test("it is the peek's plain line, uncut", () => {
    const text = "Use `cast check` and **then** deploy.";
    expect(speakableAgentLine(text)).toBe(cleanNotificationBody(text, 1000));
  });
});
