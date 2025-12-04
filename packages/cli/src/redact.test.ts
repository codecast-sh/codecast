import { describe, test, expect } from "bun:test";
import { redactSecrets, containsSecrets, maskToken } from "./redact.js";

describe("redactSecrets", () => {
  test("redacts OpenAI API keys", () => {
    expect(redactSecrets("sk-1234567890abcdefghij1234567890abcdefghij")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("My key: sk-abcdefghijklmnopqrstuvwxyz1234567890")).toBe("My key: [REDACTED_API_KEY]");
  });

  test("redacts OpenAI project keys", () => {
    expect(redactSecrets("sk-proj-abc123xyz456def789ghi012jkl345mno")).toBe("[REDACTED_API_KEY]");
  });

  test("redacts Anthropic API keys", () => {
    expect(redactSecrets("sk-ant-api03-1234567890abcdefghij1234567890")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-ant-test123456789012345678901234")).toBe("[REDACTED_API_KEY]");
  });

  test("redacts AWS access keys", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED_API_KEY]");
  });

  test("redacts Bearer tokens", () => {
    const token = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    expect(redactSecrets(token)).toBe("Authorization: [REDACTED_API_KEY]");
  });

  test("redacts generic secret patterns", () => {
    expect(redactSecrets("API_KEY=my-secret-api-key-here-123")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("SECRET_TOKEN=supersecretvalue123456")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("DATABASE_PASSWORD=mydbpassword123")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG")).toBe("[REDACTED_API_KEY]");
  });

  test("redacts private key blocks", () => {
    const rsaKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA123\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(rsaKey)).toBe("[REDACTED_API_KEY]");

    const privateKey = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQE\n-----END PRIVATE KEY-----";
    expect(redactSecrets(privateKey)).toBe("[REDACTED_API_KEY]");
  });

  test("redacts GitHub tokens", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[REDACTED_API_KEY]");
    expect(redactSecrets("gho_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[REDACTED_API_KEY]");
  });

  test("redacts Slack tokens", () => {
    expect(redactSecrets("xoxb-1234567890-abcdefghijklmnop")).toBe("[REDACTED_API_KEY]");
  });

  test("does not redact normal text", () => {
    expect(redactSecrets("Hello world")).toBe("Hello world");
    expect(redactSecrets("The key to success is persistence")).toBe("The key to success is persistence");
    expect(redactSecrets("api docs at https://api.example.com")).toBe("api docs at https://api.example.com");
  });

  test("does not redact short patterns", () => {
    expect(redactSecrets("sk-short")).toBe("sk-short");
  });
});

describe("containsSecrets", () => {
  test("detects secrets", () => {
    expect(containsSecrets("sk-1234567890abcdefghij1234567890abcdefghij")).toBe(true);
    expect(containsSecrets("API_KEY=secret123456789")).toBe(true);
  });

  test("returns false for normal text", () => {
    expect(containsSecrets("Hello world")).toBe(false);
    expect(containsSecrets("sk-short")).toBe(false);
  });
});

describe("maskToken", () => {
  test("masks long tokens", () => {
    expect(maskToken("1234567890abcdef")).toBe("123...def");
  });

  test("returns stars for short tokens", () => {
    expect(maskToken("short")).toBe("*****");
  });

  test("handles undefined", () => {
    expect(maskToken(undefined)).toBe("(not set)");
  });
});
