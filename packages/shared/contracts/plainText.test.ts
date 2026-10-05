import { describe, expect, test } from "bun:test";
import { cleanNotificationBody, plainAgentLine } from "./plainText";

describe("plainAgentLine", () => {
  test("markup and code leave; the words stay", () => {
    expect(plainAgentLine("## Done\nThe **fix** is in `auth.ts`.\n```ts\nx()\n```\n- tests pass")).toBe("Done The fix is in auth.ts. tests pass");
  });

  test("it is the peek's line, uncut", () => {
    const text = "Use `cast check` and **then** deploy.";
    expect(plainAgentLine(text)).toBe(cleanNotificationBody(text, 1000));
  });
});
