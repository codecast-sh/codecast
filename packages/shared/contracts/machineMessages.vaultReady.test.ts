import { expect, test } from "bun:test";
import { formatVaultReady, parseVaultReady } from "./machineMessages";

test("each kind says how to use the secret, and the tag round-trips", () => {
  const key = formatVaultReady({ short_id: "sec-4", name: "stripe-test", kind: "key", env: ["STRIPE_SECRET_KEY"] });
  expect(key).toContain("`cast vault run stripe-test -- <command>` sets STRIPE_SECRET_KEY");
  expect(parseVaultReady(key)).toEqual({ id: "sec-4", name: "stripe-test", text: key.split("\n")[0] });

  expect(formatVaultReady({ short_id: "sec-5", name: "gcp-sa", kind: "file" })).toContain("sets GCP_SA_FILE to its path");
  expect(formatVaultReady({ short_id: "sec-6", name: "vercel", kind: "signin", sites: ["vercel.com"] })).toContain("`cast browser open vercel.com` starts signed in");
  expect(formatVaultReady({ short_id: "sec-7", name: "staging", kind: "login", has_otp: true })).toContain("`cast vault otp staging`");
});

test("a typed message without the tag is not a ready line", () => {
  expect(parseVaultReady("Vault: stripe-test is ready.")).toBeNull();
  expect(parseVaultReady(null)).toBeNull();
});
