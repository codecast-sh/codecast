import { describe, expect, test } from "bun:test";
import { findSecrets, replaceSecrets, vaultReference } from "./secretShapes";

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
});
