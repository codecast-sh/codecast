import { describe, expect, test } from "bun:test";
import { findSecrets, replaceSecrets, vaultReference, withoutSecrets } from "./secretShapes";

// Built at runtime so no credential-shaped literal sits in the source.
const body = (n: number) => "a1B2c3D4e5F6g7H8".repeat(4).slice(0, n);
const stripeTest = `sk_test_${body(26)}`;
const stripeLive = `sk_live_${body(26)}`;
const github = `ghp_${body(36)}`;

describe("findSecrets", () => {
  test("names a Stripe key by its mode", () => {
    const [test_] = findSecrets(`use ${stripeTest} for the checkout`);
    expect(test_).toMatchObject({ id: "stripe-secret-key", label: "Stripe secret key", value: stripeTest, start: 4, name: "stripe-test", env: "STRIPE_SECRET_KEY" });
    expect(findSecrets(stripeLive)[0]?.name).toBe("stripe-live");
  });

  test("a vendor key assigned to a variable is found once and keeps the variable", () => {
    const found = findSecrets(`STRIPE_KEY_PROD_TOKEN=${stripeTest}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "stripe-secret-key", value: stripeTest, env: "STRIPE_KEY_PROD_TOKEN" });
  });

  test("an opaque value after a secret-named variable", () => {
    const value = `x9${body(20)}`;
    const found = findSecrets(`SESSION_SECRET=${value}\nPORT=3000`);
    expect(found).toEqual([{ id: "secret-assignment", label: "SESSION_SECRET", value, start: 15, end: 15 + value.length, name: "session-secret", env: "SESSION_SECRET" }]);
  });

  test("a PEM private key block", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body(40)}\n-----END RSA PRIVATE KEY-----`;
    expect(findSecrets(`here:\n${pem}\n`)).toMatchObject([{ id: "private-key", value: pem, name: "private-key" }]);
  });

  test("several, in order of appearance", () => {
    const found = findSecrets(`gh ${github} and stripe ${stripeTest}`);
    expect(found.map((f) => f.name)).toEqual(["github-token", "stripe-test"]);
  });

  test("an Anthropic key is found whole wherever its body has an underscore", () => {
    const keyBody = body(64) + body(29) + "AA";
    for (const at of [1, 22, 60, keyBody.length - 3]) {
      const key = `sk-ant-api03-${keyBody.slice(0, at)}_${keyBody.slice(at + 1)}`;
      expect(findSecrets(`ANTHROPIC_API_KEY=${key} next`)).toMatchObject([{ id: "anthropic-key", value: key }]);
    }
  });

  test("a Bearer token keeps its ~ + / characters and = padding", () => {
    const token = `${body(12)}~${body(6)}+${body(6)}/${body(10)}==`;
    expect(findSecrets(`Authorization: Bearer ${token}\n`)).toMatchObject([{ id: "bearer-token", value: token }]);
  });

  test("ordinary text is left alone", () => {
    for (const text of [
      "Can you fix the login page? The password field is broken.",
      "FOREIGN_KEY: user_id, PRIMARY_KEY = column_name",
      "set API_KEY=your-key-here and TOKEN=abc",
      "Bearer someVariableName in the header",
      "sk_test_ is the prefix Stripe uses for test keys",
      "the commit is 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
      "",
    ]) expect(findSecrets(text)).toEqual([]);
  });
});

// Each input took seconds when a shape scanned to the end of the run from
// every start (2 to 6 s here, minutes at 600 KB). Linear, each is a few ms.
describe("findSecrets on long unspaced text stays linear", () => {
  const within = (text: string, ms: number) => {
    const t0 = performance.now();
    const found = findSecrets(text);
    expect(performance.now() - t0).toBeLessThan(ms);
    return found;
  };
  test("an assignment label repeated with no digit after it", () => {
    expect(within("TOKEN=".repeat(33_000), 500)).toEqual([]);
    expect(within("password=x&token=y&".repeat(10_000), 500)).toEqual([]);
  });
  test("BEGIN lines with no END", () => {
    expect(within("-----BEGIN RSA PRIVATE KEY-----\n".repeat(18_000), 500)).toEqual([]);
  });
  test("a JWT head repeated with no dot", () => {
    expect(within("-eyJabcdefghijkl".repeat(12_000), 500)).toEqual([]);
  });
  test("a real one after the noise is still found", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${body(64)}\n-----END PRIVATE KEY-----`;
    const found = within(`${"-----BEGIN RSA PRIVATE KEY-----\n".repeat(2_000)}${pem} SESSION_SECRET=${body(40)}`, 500);
    expect(found.map((f) => f.id)).toEqual(["private-key", "secret-assignment"]);
    expect(found[0]!.value).toBe(pem);
  });
});

describe("replaceSecrets", () => {
  test("swaps each range, back to front, leaving the rest", () => {
    const text = `a ${github} b ${stripeTest} c`;
    const found = findSecrets(text);
    const out = replaceSecrets(text, found.map((f) => ({ start: f.start, end: f.end, with: `<${f.name}>` })));
    expect(out).toBe("a <github-token> b <stripe-test> c");
  });

  test("vaultReference names the command and the vars", () => {
    expect(vaultReference("stripe-test", ["STRIPE_SECRET_KEY"])).toBe("[vault secret stripe-test: `cast vault run stripe-test -- <command>` sets STRIPE_SECRET_KEY]");
  });

  test("withoutSecrets puts the redaction marker where each value was", () => {
    expect(withoutSecrets(`a ${github} b ${stripeTest} c`)).toBe("a [redacted:github-token] b [redacted:stripe-secret-key] c");
    expect(withoutSecrets("nothing secret here")).toBe("nothing secret here");
  });
});
