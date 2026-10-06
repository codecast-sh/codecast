import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  test("a client marker survives verbatim while a raw secret beside it is still replaced", () => {
    const toolOutput = [
      "PLAIN_SETTING=[redacted:known:PLAIN_SETTING]",
      "APP_PASSWORD=[redacted:known:APP_PASSWORD]",
      "DB_SECRET=[redacted:secret-assignment]",
      "SESSION_TOKEN=q8Z2mW9xL4vT7nB1raw",
    ].join("\n");
    const out = redactSecrets(toolOutput);
    expect(out).toContain("APP_PASSWORD=[redacted:known:APP_PASSWORD]");
    expect(out).toContain("DB_SECRET=[redacted:secret-assignment]");
    expect(out).not.toContain("q8Z2mW9xL4vT7nB1raw");
    expect(out).toContain("[REDACTED_API_KEY]");
  });

  test("idempotent over its own output", () => {
    const once = redactSecrets("MY_API_TOKEN: abcdef1234567890");
    expect(once).not.toContain("abcdef1234567890");
    expect(redactSecrets(once)).toBe(once);
  });
});
