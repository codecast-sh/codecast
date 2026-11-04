import { describe, expect, test } from "bun:test";
import { structuredMessageInput } from "./structuredMessage";

describe("structured assistant result messages", () => {
  const input = JSON.stringify({ verdict: "PASS", summary: "Verified the fix.", findings: [] });

  test("accepts bare and fenced complete object results", () => {
    for (const text of [input, `  ${input}\n`, `\`\`\`json\n${input}\n\`\`\``, `\`\`\`\n${input}\n\`\`\``]) {
      expect(structuredMessageInput(text)).toBe(input);
    }
  });

  test("leaves prose, examples, incomplete streams and non-objects as markdown", () => {
    for (const text of ["Done.", `Example:\n\`\`\`json\n${input}\n\`\`\``, `${input}\nDone.`, '{"verdict":', '{broken}', '[]', 'null', '42', `\`\`\`js\n${input}\n\`\`\``]) {
      expect(structuredMessageInput(text)).toBeNull();
    }
  });

  test("preserves the original payload for the JSON toggle", () => {
    const pretty = JSON.stringify({ summary: "Literal <tag> and **markdown**", nested: { count: 0 }, ready: false }, null, 2);
    expect(structuredMessageInput(pretty)).toBe(pretty);
  });
});
