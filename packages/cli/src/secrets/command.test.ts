// `cast vault` on the wire: what each verb posts, what it prints, and that a
// value never reaches argv, a request it did not need, or error output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { useCliHarness } from "../externalDataCli.testHarness.js";
import { clearWorkspaceCache } from "../resolveWorkspace.js";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";

const VALUE = "sk_test_51HXabcdefghijklmnopqrstuvwxyz";
const TEAMS = { teams: [{ _id: "t1", name: "Acme" }], active_team_id: "t1" };
const meta = (over: Partial<SecretMeta> = {}): SecretMeta => ({
  _id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", status: "ready", workspace: "team:t1", team_id: "t1",
  env: ["STRIPE_SECRET_KEY"], created_by: "u", created_at: 0, updated_at: 0, last_used_at: Date.now() - 2 * 3_600_000,
  last_used_by_conversation: "jx7c6zkabcdef", ...over,
});

describe("cast vault on the wire", () => {
  const h = useCliHarness("vault", async () => (await import("./command.js")).registerVaultCommand);
  let stdout = "";
  beforeEach(() => {
    clearWorkspaceCache();
    stdout = "";
    process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  });

  test("ls: requests first as the server sends them, scope by team name, last use by session", async () => {
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : [
      meta({ short_id: "sec-9", name: "github-bot", kind: "login", status: "requested", env: undefined, requested_by_name: "Ana", request_why: "push tags", last_used_at: undefined }),
      meta(),
    ]);
    await h.run();
    const [req, ready] = h.out().split("\n");
    for (const part of ["sec-9", "requested", "github-bot", "asked by Ana: push tags"]) expect(req).toContain(part);
    for (const part of ["sec-4", "stripe-test", "STRIPE_SECRET_KEY", "Acme", "used 2h ago by jx7c6zk"]) expect(ready).toContain(part);
    expect(h.calls[0]).toEqual({ path: "/cli/vault/list", body: {} });
  });

  test("add takes the value from the environment, sends the workspace, prints the fingerprint only", async () => {
    process.env.VAULT_TEST_VALUE = VALUE;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : { id: "x", short_id: "sec-4", name: "stripe-test" });
    await h.run("add", "stripe-test", "--from-env", "VAULT_TEST_VALUE", "--env", "STRIPE_SECRET_KEY", "--site", "dashboard.stripe.com");
    delete process.env.VAULT_TEST_VALUE;
    expect(h.calls[1]).toEqual({
      path: "/cli/vault/create",
      body: { name: "stripe-test", kind: "key", payload: { value: VALUE }, env: ["STRIPE_SECRET_KEY"], sites: ["dashboard.stripe.com"], team_id: "t1" },
    });
    expect(h.out()).toContain("sk_t…wxyz");
    expect(h.out()).toContain("in Acme");
    expect(h.out()).not.toContain(VALUE);
  });

  test("--team personal stores it personally", async () => {
    process.env.VAULT_TEST_VALUE = VALUE;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : { short_id: "sec-5", name: "mine" });
    await h.run("add", "mine", "--from-env", "VAULT_TEST_VALUE", "--team", "personal");
    delete process.env.VAULT_TEST_VALUE;
    expect(h.calls[1]!.body.personal).toBe(true);
    expect(h.calls[1]!.body.team_id).toBeUndefined();
  });

  test("a refusal prints the server's sentence and never the value", async () => {
    process.env.VAULT_TEST_VALUE = VALUE;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : { error: "stripe-test already exists here (sec-4): replace its value with cast vault rotate stripe-test" });
    await expect(h.run("add", "stripe-test", "--from-env", "VAULT_TEST_VALUE")).rejects.toThrow("exit 1");
    delete process.env.VAULT_TEST_VALUE;
    expect(h.out()).toContain("cast vault rotate stripe-test");
    expect(h.out()).not.toContain(VALUE);
  });

  test("get prints the raw value alone; every read names the session", async () => {
    h.answer = () => ({ secrets: [{ id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", payload: { value: VALUE } }] });
    await h.run("get", "stripe-test");
    expect(stdout).toBe(VALUE);
    expect(h.logs).toEqual([]);
    expect(h.calls).toEqual([{ path: "/cli/vault/read", body: { refs: ["stripe-test"], purpose: "get", conversation: "s1" } }]);
  });

  test("get --field username and --field totp", async () => {
    h.answer = () => ({ secrets: [{ id: "x", short_id: "sec-2", name: "gh", kind: "login", payload: { username: "ci", totp_seed: "JBSWY3DPEHPK3PXP" } }] });
    await h.run("get", "gh", "--field", "username");
    expect(stdout).toBe("ci");
    stdout = "";
    await h.run("get", "gh", "--field", "totp");
    expect(stdout).toMatch(/^\d{6}$/);
    expect(h.calls[1]!.body.purpose).toBe("otp");
  });

  test("otp prints the code for a known seed at this moment", async () => {
    const { totp } = await import("@codecast/shared/contracts/secrets");
    h.answer = () => ({ secrets: [{ id: "x", short_id: "sec-2", name: "gh", kind: "login", payload: { totp_seed: "JBSWY3DPEHPK3PXP" } }] });
    const expected = (await totp("JBSWY3DPEHPK3PXP")).code;
    await h.run("otp", "gh");
    expect(h.logs[0]).toBe(expected);
  });

  test("env prints quoted export lines", async () => {
    h.answer = () => ({ secrets: [{ id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", env: ["K"], payload: { value: "a'b" } }] });
    await h.run("env", "stripe-test");
    expect(h.logs).toEqual([`export K='a'\\''b'`]);
  });

  test("run passes the command's exit code through and posts only names", async () => {
    h.answer = () => ({ secrets: [{ id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", payload: { value: VALUE } }] });
    await expect(h.run("run", "stripe-test", "--", "sh", "-c", `test "$STRIPE_TEST" = "${VALUE}" && exit 3`)).rejects.toThrow("exit 3");
    expect(h.calls).toEqual([{ path: "/cli/vault/read", body: { refs: ["stripe-test"], purpose: "run", conversation: "s1" } }]);
  });

  test("run without -- or without names says the form", async () => {
    await expect(h.run("run", "stripe-test")).rejects.toThrow("exit 1");
    await expect(h.run("run", "--", "true")).rejects.toThrow("exit 1");
    expect(h.out()).toContain("cast vault run stripe-test -- npm test");
    expect(h.calls).toEqual([]);
  });

  test("request is bound to the session and says how to wait", async () => {
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : { id: "x", short_id: "sec-9", name: "github-bot", requested: true });
    await h.run("request", "github-bot", "--kind", "login", "--why", "push tags");
    expect(h.calls[1]).toEqual({ path: "/cli/vault/request", body: { name: "github-bot", kind: "login", why: "push tags", conversation: "s1", team_id: "t1" } });
    expect(h.out()).toContain("sec-9");
    expect(h.out()).toContain("--status dormant");
  });

  test("rm needs --yes off a terminal", async () => {
    await expect(h.run("rm", "stripe-test")).rejects.toThrow("exit 1");
    expect(h.calls).toEqual([]);
    h.answer = () => ({ removed: true, short_id: "sec-4", name: "stripe-test" });
    await h.run("rm", "stripe-test", "--yes");
    expect(h.calls).toEqual([{ path: "/cli/vault/rm", body: { ref: "stripe-test" } }]);
  });

  test("a Files verb names the cast files command and exits 1 before any request", async () => {
    await expect(h.run("mirror", "/tmp", "--on")).rejects.toThrow("exit 1");
    await expect(h.run("add", "/tmp", "--name", "Wiki")).rejects.toThrow("exit 1");
    expect(h.out()).toContain("Files moved: cast files mirror /tmp --on");
    expect(h.out()).toContain("Files moved: cast files add /tmp --name Wiki");
    expect(h.calls).toEqual([]);
  });

  test("show prints metadata and activity", async () => {
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : p === "/cli/vault/events" ? [{ kind: "read", purpose: "run", at: Date.now() - 60_000, actor_name: "Ana", session_short_id: "jx7c6zk", session_title: "billing tests" }] : meta({ fingerprint: "sk_t…wxyz" }));
    await h.run("show", "stripe-test");
    for (const part of ["sec-4", "stripe-test", "sk_t…wxyz", "read (run)", "jx7c6zk", "billing tests"]) expect(h.out()).toContain(part);
    expect(h.calls[1]).toEqual({ path: "/cli/vault/events", body: { ref: "sec-4" } });
  });

  describe("in a repo with a [vault] map", () => {
    let repo = "";
    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cmd-"));
      fs.mkdirSync(path.join(repo, ".codecast"));
      fs.writeFileSync(path.join(repo, ".codecast", "workspace.toml"), `[vault]\nSTRIPE_SECRET_KEY = "stripe-test"\nOPENAI_API_KEY = "openai"\n`);
      process.env.CODECAST_CWD = repo;
    });
    afterEach(() => {
      delete process.env.CODECAST_CWD;
      fs.rmSync(repo, { recursive: true, force: true });
    });
    const stripe = { id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", env: ["STRIPE_TEST"], payload: { value: VALUE } };
    const live = { id: "y", short_id: "sec-5", name: "stripe-live", kind: "key", env: ["STRIPE_SECRET_KEY"], payload: { value: "named-wins" } };
    const openai = { id: "z", short_id: "sec-6", name: "openai", kind: "key", payload: { value: "oa" } };

    test("run with no names reads the map's secrets into the mapped vars", async () => {
      h.answer = () => ({ secrets: [stripe, openai] });
      await expect(h.run("run", "--", "sh", "-c", `test "$STRIPE_SECRET_KEY" = "${VALUE}" && test "$OPENAI_API_KEY" = oa && exit 3`)).rejects.toThrow("exit 3");
      expect(h.calls).toEqual([{ path: "/cli/vault/read", body: { refs: ["stripe-test", "openai"], purpose: "run", conversation: "s1" } }]);
    });

    test("env with names merges them with the map, and a named secret wins its var", async () => {
      h.answer = () => ({ secrets: [live, stripe, openai] });
      await h.run("env", "stripe-live");
      expect(h.calls[0]!.body).toEqual({ refs: ["stripe-live", "stripe-test", "openai"], purpose: "env", conversation: "s1" });
      expect(h.logs).toEqual([`export STRIPE_SECRET_KEY='named-wins'\nexport OPENAI_API_KEY='oa'`]);
    });

    test("ls marks what this project uses and names a mapped secret the Vault lacks, with its request", async () => {
      h.answer = (p) => (p === "/cli/teams" ? TEAMS : [meta()]);
      await h.run();
      expect(h.out()).toContain("project STRIPE_SECRET_KEY");
      expect(h.out()).toContain("OPENAI_API_KEY: no secret openai in your Vault. Ask for it: cast vault request openai --env OPENAI_API_KEY");
      h.answer = (p) => (p === "/cli/teams" ? TEAMS : [meta()]);
      await h.run("--json");
      expect(JSON.parse(h.logs.at(-1)!)[0].project_env).toEqual(["STRIPE_SECRET_KEY"]);
    });

    test("a bad [vault] line stops run with the line it names, before any request", async () => {
      fs.writeFileSync(path.join(repo, ".codecast", "workspace.toml"), `[vault]\nSTRIPE_SECRET_KEY = "Stripe Test"\n`);
      await expect(h.run("run", "--", "true")).rejects.toThrow("exit 1");
      expect(h.out()).toContain(`[vault] STRIPE_SECRET_KEY = "Stripe Test"`);
      expect(h.calls).toEqual([]);
    });
  });
});
