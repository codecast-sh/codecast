import { describe, test, expect } from "bun:test";
import { redactSecrets, containsSecrets } from "./secretRedaction.js";

// Realistic (but fake) secrets covering each supported pattern.
const SAMPLES = {
  rsaPrivateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdef\nGHIJKLmnopqrstuvwxyz\n-----END RSA PRIVATE KEY-----",
  opensshPrivateKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----",
  plainPrivateKey:
    "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  awsAkia: "AKIAIOSFODNN7EXAMPLE",
  awsAsia: "ASIAY34FZKBOKM02T4EX",
  githubClassic: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  githubOauth: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  githubFineGrained: "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
  // Slack/Stripe fixtures are split so no contiguous secret literal appears in
  // this file (GitHub push protection blocks those); the runtime value is intact.
  slackBot: "xox" + "b-1234567890-1234567890-abcdefghijklmnopqrstuv",
  slackWebhook:
    "https://hooks.slack" + ".com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
  discordWebhook:
    "https://discord.com/api/webhooks/123456789012345678/abcdefGHIjklMNOpqrs_tuvwxyz-1234567890",
  stripeLive: "sk_" + "live_0123456789abcdefghijABCD",
  googleApiKey: "AIza" + "a".repeat(35),
  anthropicKey: "sk-ant-api03-" + "a".repeat(30),
  openaiProject: "sk-proj-" + "a".repeat(40),
  openaiLegacy: "sk-" + "a".repeat(48),
};

describe("redactSecrets — high-confidence patterns", () => {
  test("PEM private key blocks (RSA, OPENSSH, bare)", () => {
    expect(redactSecrets(SAMPLES.rsaPrivateKey)).toBe("[redacted:private-key]");
    expect(redactSecrets(SAMPLES.opensshPrivateKey)).toBe("[redacted:private-key]");
    expect(redactSecrets(SAMPLES.plainPrivateKey)).toBe("[redacted:private-key]");
  });

  test("JWT (three base64url segments)", () => {
    expect(redactSecrets(`token=${SAMPLES.jwt}`)).toBe("token=[redacted:jwt]");
  });

  test("AWS access key ids (AKIA / ASIA)", () => {
    expect(redactSecrets(`AWS_ACCESS_KEY_ID=${SAMPLES.awsAkia}`)).toBe(
      "AWS_ACCESS_KEY_ID=[redacted:aws-access-key]",
    );
    expect(redactSecrets(SAMPLES.awsAsia)).toBe("[redacted:aws-access-key]");
  });

  test("GitHub tokens (classic, oauth, fine-grained)", () => {
    expect(redactSecrets(SAMPLES.githubClassic)).toBe("[redacted:github-token]");
    expect(redactSecrets(SAMPLES.githubOauth)).toBe("[redacted:github-token]");
    expect(redactSecrets(SAMPLES.githubFineGrained)).toBe("[redacted:github-token]");
  });

  test("Slack token and webhook", () => {
    expect(redactSecrets(SAMPLES.slackBot)).toBe("[redacted:slack-token]");
    expect(redactSecrets(SAMPLES.slackWebhook)).toBe("[redacted:slack-webhook]");
  });

  test("Discord webhook", () => {
    expect(redactSecrets(SAMPLES.discordWebhook)).toBe("[redacted:discord-webhook]");
  });

  test("Stripe live secret key", () => {
    expect(redactSecrets(SAMPLES.stripeLive)).toBe("[redacted:stripe-secret-key]");
  });

  test("Google API key", () => {
    expect(redactSecrets(SAMPLES.googleApiKey)).toBe("[redacted:google-api-key]");
  });

  test("Anthropic and OpenAI keys", () => {
    expect(redactSecrets(SAMPLES.anthropicKey)).toBe("[redacted:anthropic-key]");
    expect(redactSecrets(SAMPLES.openaiProject)).toBe("[redacted:openai-key]");
    expect(redactSecrets(SAMPLES.openaiLegacy)).toBe("[redacted:openai-key]");
  });

  test("redacts every secret in a mixed .env dump", () => {
    const dump = [
      `AWS_ACCESS_KEY_ID=${SAMPLES.awsAkia}`,
      `GITHUB_TOKEN=${SAMPLES.githubClassic}`,
      `STRIPE_KEY=${SAMPLES.stripeLive}`,
      `GOOGLE_KEY=${SAMPLES.googleApiKey}`,
    ].join("\n");
    const out = redactSecrets(dump);
    expect(out).toContain("[redacted:aws-access-key]");
    expect(out).toContain("[redacted:github-token]");
    expect(out).toContain("[redacted:stripe-secret-key]");
    expect(out).toContain("[redacted:google-api-key]");
    // env var NAMES survive; only the values are scrubbed.
    expect(out).toContain("AWS_ACCESS_KEY_ID=");
    expect(out).toContain("GITHUB_TOKEN=");
  });
});

describe("redactSecrets — is deterministic and idempotent", () => {
  test("same input → same output", () => {
    expect(redactSecrets(SAMPLES.githubClassic)).toBe(redactSecrets(SAMPLES.githubClassic));
  });

  test("re-running over redacted text is a no-op", () => {
    const once = redactSecrets(`key=${SAMPLES.openaiLegacy} and ${SAMPLES.jwt}`);
    expect(redactSecrets(once)).toBe(once);
  });

  test("markers are not themselves re-redacted", () => {
    expect(redactSecrets("[redacted:github-token]")).toBe("[redacted:github-token]");
  });

  test("nullish / non-string input", () => {
    expect(redactSecrets(null as unknown as string)).toBe("");
    expect(redactSecrets(undefined as unknown as string)).toBe("");
  });
});

// The high-stakes half: these must ALL pass through untouched. This pass runs
// over every synced transcript, so a false positive here eats real content.
describe("redactSecrets — zero false positives on legitimate content", () => {
  const NEGATIVES: Array<[string, string]> = [
    ["plain prose", "The key to success is persistence, not a secret."],
    ["prose with 'bearer'", "Please bear with me while I find the answer."],
    [
      "code referencing env vars by name",
      "const apiKey = process.env.API_KEY;\nif (FOREIGN_KEY === PRIMARY_KEY) return;\nDATABASE_PASSWORD is read from env.",
    ],
    ["env var with placeholder value", "API_KEY=<your-key-here>\nSECRET_TOKEN=changeme"],
    ["short sk- fragment", "The sk-learn library and sk-abc123 are fine."],
    ["bare AKIA word", "AKIA is a Japanese word; AKIA appears in docs."],
    ["file path", "/Users/ashot/src/codecast/packages/cli/src/secretRedaction.ts"],
    ["git commit hash", "commit a1b2c3d4e5f6789012345678901234567890abcd landed"],
    ["short git hash", "see 6a036abb and c58530d7 for context"],
    ["uuid", "session 550e8400-e29b-41d4-a716-446655440000 started"],
    [
      "base64 png image data",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    ],
    ["hex color codes", "background: #1a2b3c; color: #FFF; border: #FF00AA;"],
    [
      "two-segment JWT-like string (no signature)",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ],
    ["a normal https URL", "docs at https://api.example.com/v1/users?id=123"],
    ["long lowercase hex blob", "0123456789abcdef".repeat(8)],
  ];

  for (const [label, input] of NEGATIVES) {
    test(`leaves ${label} unchanged`, () => {
      expect(redactSecrets(input)).toBe(input);
      expect(containsSecrets(input)).toBe(false);
    });
  }
});

describe("containsSecrets", () => {
  test("detects a secret", () => {
    expect(containsSecrets(`token=${SAMPLES.githubClassic}`)).toBe(true);
    expect(containsSecrets(SAMPLES.rsaPrivateKey)).toBe(true);
  });

  test("false for normal text and nullish", () => {
    expect(containsSecrets("Hello world")).toBe(false);
    expect(containsSecrets(null as unknown as string)).toBe(false);
  });
});

describe("opaque secret assignments (name-guarded, digit+length guarded)", () => {
  const REDACTS = [
    "SESSION_SECRET=aB3xK9mP2qR7sT1vW5yZ",
    'DB_PASSWORD="P@ssw0rd12345678xyz"',
    "export MY_ACCESS_TOKEN=abcdef1234567890ghijkl",
    'apiToken: "tok_9f8e7d6c5b4a3210zzz"',
    "CLIENT_SECRET = 0oa1b2c3d4e5f6g7h8i9",
    "Authorization: Bearer eyJ0abc123def456ghi789jkl0mnop",
  ];
  for (const s of REDACTS) {
    test(`redacts: ${s.slice(0, 32)}`, () => {
      expect(redactSecrets(s)).toContain("[redacted:");
      expect(containsSecrets(s)).toBe(true);
    });
  }

  // Legitimate code must survive untouched — the false-positive guard.
  const KEEPS = [
    "FOREIGN_KEY: users_id",
    "PRIMARY_KEY = column_name_reference",
    "const accessToken = someVariableName;",
    "PARTITION_KEY: userId",
    "SORT_KEY = createdAtTimestamp",
    "password = getPasswordFromPrompt()",
    "this.apiKey = config.apiKey",
    "Bearer tokenPlaceholderNoDigits",
    "const FOREIGN_KEY_CONSTRAINT = tableRelationName",
  ];
  for (const s of KEEPS) {
    test(`keeps code: ${s.slice(0, 32)}`, () => {
      expect(redactSecrets(s)).toBe(s);
      expect(containsSecrets(s)).toBe(false);
    });
  }

  test("keeps the variable name, redacts only the value; idempotent", () => {
    const once = redactSecrets("SESSION_SECRET=aB3xK9mP2qR7sT1vW5yZ");
    expect(once).toBe("SESSION_SECRET=[redacted:secret-assignment]");
    expect(redactSecrets(once)).toBe(once);
  });
});
