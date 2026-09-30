import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseBindArgs, runOrgTemplateBind, secretsDir } from "./orgTemplateBindCommand";
import { encryptProviderKeyForTest, getProviderKeyPublicKey } from "./providerKeyCrypto";

// The daemon's host step (org-hire.md H3, H4): sealed secrets become 0600
// files this device alone can read, and the CLI is run exactly as a person
// would run it. The value never appears in an argument, a result or an error.

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "org-bind-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const args = (configDir: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  instance_key: "pending:project-1:acme-growth", instance: "acme-growth", dir: configDir, workspace: { kind: "team", id: "team-1" }, secrets: [], ...extra,
});

describe("org_template_bind", () => {
  test("refuses arguments the CLI would not take", () => {
    const configDir = tmp();
    expect(() => parseBindArgs("nope")).toThrow(/bad JSON/);
    expect(() => parseBindArgs(args(configDir, { instance: "Bad Name" }))).toThrow(/slug/);
    expect(() => parseBindArgs(args(configDir, { dir: "relative/dir" }))).toThrow(/absolute/);
    expect(() => parseBindArgs(args(configDir, { workspace: { kind: "org", id: "x" } }))).toThrow(/team or a user/);
    expect(() => parseBindArgs(args(configDir, { secrets: [{ key: "accounts.ads", payload: { epk: "x" } }] }))).toThrow(/not sealed/);
    expect(() => parseBindArgs(args(configDir, { secrets: [{ key: "../etc", payload: { epk: "a", iv: "b", ct: "c" } }] }))).toThrow(/input key/);
    expect(parseBindArgs(args(configDir, { workspace: { kind: "user", id: "u1" } })).workspace).toEqual({ kind: "user", id: "u1" });
  });

  test("decrypts each sealed secret into a private file and runs the CLI with its path", async () => {
    const configDir = tmp();
    const pubkey = getProviderKeyPublicKey(configDir);
    const sealed = encryptProviderKeyForTest(pubkey, "accounts.ads", "{\"token\":\"never-copied\"}");
    const runs: string[][] = [];
    const result = await runOrgTemplateBind(configDir, args(configDir, { secrets: [{ key: "accounts.ads", payload: sealed }] }), async (cli) => {
      runs.push(cli);
      return { code: 0, stdout: JSON.stringify({ phase: "ready", host: { machine: "mbp" } }), stderr: "" };
    });
    expect(runs).toHaveLength(1);
    const cli = runs[0]!;
    expect(cli.slice(0, 4)).toEqual(["org", "template", "bind", "acme-growth"]);
    expect(cli).toContain("--dir"); expect(cli[cli.indexOf("--dir") + 1]).toBe(configDir);
    expect(cli[cli.indexOf("--team") + 1]).toBe("team-1");
    expect(cli).toContain("--json");
    const file = cli[cli.indexOf("--secret") + 1]!.split("=")[1]!;
    expect(file).toBe(path.join(secretsDir(configDir, "acme-growth"), "accounts.ads"));
    expect(fs.readFileSync(file, "utf8")).toBe("{\"token\":\"never-copied\"}");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(cli)).not.toContain("never-copied");
    expect(result).toEqual({ instance: "acme-growth", phase: "ready", bound: ["accounts.ads"], host: "mbp" });
  });

  test("a personal workspace passes --personal and no secret writes nothing", async () => {
    const configDir = tmp();
    const runs: string[][] = [];
    await runOrgTemplateBind(configDir, args(configDir, { workspace: { kind: "user", id: "u1" } }), async (cli) => { runs.push(cli); return { code: 0, stdout: "{\"phase\":\"ready\"}", stderr: "" }; });
    expect(runs[0]).toContain("--personal");
    expect(runs[0]).not.toContain("--secret");
    expect(fs.existsSync(secretsDir(configDir, "acme-growth"))).toBe(false);
  });

  test("a secret sealed to another machine fails before the CLI runs, without the value", async () => {
    const configDir = tmp();
    const other = tmp();
    const sealed = encryptProviderKeyForTest(getProviderKeyPublicKey(other), "accounts.ads", "secret-value");
    let ran = false;
    const failure = runOrgTemplateBind(configDir, args(configDir, { secrets: [{ key: "accounts.ads", payload: sealed }] }), async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; });
    await expect(failure).rejects.toThrow(/sealed to another device's key/);
    await expect(failure).rejects.not.toThrow(/secret-value/);
    expect(ran).toBe(false);
  });

  test("a CLI failure surfaces the tail of its stderr as the error, and a missing checkout is named", async () => {
    const configDir = tmp();
    const failure = runOrgTemplateBind(configDir, args(configDir), async () => ({ code: 1, stdout: "", stderr: "noise\nError: Instance is proposal; bind runs once the role and its routines exist (reconcile first)\n" }));
    await expect(failure).rejects.toThrow(/^Instance is proposal; bind runs once/);
    await expect(runOrgTemplateBind(configDir, args(configDir, { dir: path.join(configDir, "gone") }), async () => ({ code: 0, stdout: "", stderr: "" }))).rejects.toThrow(/is not on this machine/);
  });
});
