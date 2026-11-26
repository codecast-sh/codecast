// ct-101922: an agent asked a person, through `cast vault request`, for a
// card's 3-digit security code. The Vault refuses any key shorter than
// SECRET_REDACTION_MIN when it is filled, so the request reached the person as
// a "Needs you" item no answer could satisfy. An agent learns what the Vault
// will hold from the request verb's help and the Vault guide; both must state
// the minimum, from the shared constant, before an agent files such a request.
import { beforeEach, describe, expect, test } from "bun:test";
import { useCliHarness } from "../externalDataCli.testHarness.js";
import { SECRET_REDACTION_MIN } from "@codecast/shared/contracts/secretRules";

const statesMinimum = (text: string) =>
  new RegExp(`\\b${SECRET_REDACTION_MIN}\\b[^.\\n]{0,40}character`, "i").test(text);

describe("an agent is told the Vault's minimum length before it files a request", () => {
  const h = useCliHarness("vault", async () => (await import("./command.js")).registerVaultCommand);
  let stdout = "";
  beforeEach(() => {
    stdout = "";
    process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  });

  test("cast vault request --help states the minimum", async () => {
    await h.run("request", "--help").catch(() => {});
    const help = stdout + h.out();
    expect(help).toContain("cast vault request");
    expect(statesMinimum(help)).toBe(true);
  });

  test("the Vault guide states the minimum where it teaches cast vault request", async () => {
    const { VAULT_REFERENCE } = await import("@codecast/shared/contracts");
    expect(VAULT_REFERENCE).toContain("cast vault request");
    expect(statesMinimum(VAULT_REFERENCE)).toBe(true);
  });
});
