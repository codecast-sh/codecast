import { describe, expect, test } from "bun:test";
import { SECRET_SHAPES, findSecrets } from "@codecast/shared/contracts/secretShapes";
import { redactSecrets as redactOnServer } from "../../convex/convex/redact";
import { VENDOR_TOKEN_RE, isCredentialFilePath, liveVendorToken } from "./secretPatterns.js";
import { redactSecrets } from "./secretRedaction.js";

describe("liveVendorToken", () => {
  test("a random-looking token is live; hand-written test tokens are not", () => {
    expect(liveVendorToken('key = "sk-ant-api03-Qm7xR2pLk9VwN4tZb8YcHj3sDf6Ga1Ue5Ko0"')).toContain("sk-ant-api03-Qm7x");
    expect(liveVendorToken('"sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"')).toBeNull();
    expect(liveVendorToken("SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED")).toBeNull();
    expect(liveVendorToken("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBeNull();
    expect(liveVendorToken("AKIAIOSFODNN7EXAMPLE")).toBeNull();
    expect(liveVendorToken("nothing here")).toBeNull();
  });
  test("credential files are named as such", () => {
    expect(isCredentialFilePath("packages/playground/.env.production")).toBe(true);
    expect(isCredentialFilePath("certs/server.pem")).toBe(true);
    expect(isCredentialFilePath("src/env.ts")).toBe(false);
  });
});

describe("one list of vendor tokens", () => {
  // Built at runtime so no credential-shaped literal sits in the source.
  const body = (n: number, alphabet = "Qm7xR2pLk9VwN4tZb8YcHj3sDf6Ga1Ue5Ko0") => Array.from({ length: n }, (_, i) => alphabet[(i * 5 + 3) % alphabet.length]).join("");
  const samples: Record<string, string[]> = {
    "aws-access-key": [`AKIA${body(16, "QWERTYUPLKJHG234567")}`, `ASIA${body(16, "ZXCVBNMASDFG98765")}`],
    "github-token": [`github_pat_${body(82)}`, ...["ghp", "gho", "ghu", "ghs", "ghr"].map((p) => `${p}_${body(36)}`)],
    "slack-token": [`xoxb-${body(12, "0123456789")}-${body(24)}`],
    "slack-webhook": [`https://hooks.slack.com/services/T${body(8)}/B${body(8)}/${body(24)}`],
    "discord-webhook": [`https://discord.com/api/webhooks/${body(18, "0123456789")}/${body(60)}`],
    "stripe-secret-key": [`sk_live_${body(30)}`, `sk_test_${body(30)}`],
    "google-api-key": [`AIza${body(35)}`],
    "anthropic-key": [`sk-ant-api03-${body(40)}_${body(20)}-${body(30)}`],
    "openrouter-key": [`sk-or-v1-${body(64, "0123456789abcdef")}`],
    "openai-key": [`sk-proj-${body(60)}_${body(20)}`, `sk-svcacct-${body(60)}`, `sk-${body(48)}`],
    "api-key": [`sk-${body(32, "0123456789abcdef")}`],
  };

  test("every sample is the shape it is filed under, and every vendor shape has a sample", () => {
    const vendorIds = new Set(SECRET_SHAPES.filter((s) => s.id !== "private-key" && s.id !== "jwt").map((s) => s.id));
    expect(new Set(Object.keys(samples))).toEqual(vendorIds);
    for (const [id, tokens] of Object.entries(samples)) for (const t of tokens) expect(findSecrets(` ${t} `)).toMatchObject([{ id, value: t }]);
  });

  test("transcript redaction, the server's redaction and the file scan agree on each", () => {
    for (const t of Object.values(samples).flat()) {
      const text = `before ${t} after`;
      expect(VENDOR_TOKEN_RE.test(text)).toBe(true);
      expect(redactSecrets(text)).not.toContain(t.slice(-12));
      expect(redactOnServer(text)).not.toContain(t.slice(-12));
    }
  });
});
