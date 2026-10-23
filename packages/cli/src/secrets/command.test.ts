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
  // This machine's real daemon must not hear the reads a test makes.
  const realConfigDir = process.env.CODECAST_DIR;
  let configDir = "";
  beforeEach(() => {
    clearWorkspaceCache();
    stdout = "";
    process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-"));
    process.env.CODECAST_DIR = configDir;
  });
  afterEach(() => {
    if (realConfigDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = realConfigDir;
  });

  test("a read has this machine's daemon take the Vault's values into redaction before the value is printed", async () => {
    fs.writeFileSync(path.join(configDir, "hook-port"), "40123");
    fs.writeFileSync(path.join(configDir, "hook-token"), "tok");
    let printedAfter = -1;
    h.answer = (p) => (p.endsWith("/hook/vault-refresh") ? {} : { secrets: [{ id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", payload: { value: VALUE } }] });
    process.stdout.write = ((s: string) => ((stdout += s), (printedAfter = h.calls.length), true)) as typeof process.stdout.write;
    await h.run("get", "stripe-test");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/vault/read", "http://127.0.0.1:40123/hook/vault-refresh"]);
    expect(printedAfter).toBe(2);
    expect(stdout).toBe(VALUE);
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

  test("ls --stale lists only the secrets that need a look, each with its health word", async () => {
    const day = 86_400_000;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : [
      meta({ use_count: 4 }),
      meta({ short_id: "sec-5", name: "old-key", last_used_at: Date.now() - 100 * day, use_count: 3 }),
      meta({ short_id: "sec-6", name: "new-key", created_at: Date.now() - 2 * day, last_used_at: undefined, use_count: 0 }),
      meta({ short_id: "sec-7", name: "gh-signin", kind: "signin", env: undefined, signin_expires_at: Date.now() - day, use_count: 1 }),
      meta({ short_id: "sec-8", name: "asked", status: "requested", last_used_at: undefined }),
    ]);
    await h.run("ls", "--stale");
    const lines = h.out().split("\n");
    expect(lines.map((l) => /sec-\d/.exec(l)?.[0])).toEqual(["sec-5", "sec-6", "sec-7"]);
    expect(lines[0]).toContain("stale");
    expect(lines[1]).toContain("never used");
    expect(lines[2]).toContain("expired");
    h.logs.length = 0;
    await h.run("ls", "--stale", "--json");
    expect(JSON.parse(h.out()).map((r: SecretMeta & { health: string }) => r.health)).toEqual(["stale", "unused", "expired"]);
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : [meta({ use_count: 4 })]);
    await h.run("ls", "--stale");
    expect(h.out()).toContain("Nothing needs a look");
  });

  test("every verb's --json reaches the verb, and bare cast vault --json still lists as JSON", async () => {
    h.answer = () => [meta()];
    await h.run("ls", "--json");
    expect(JSON.parse(h.out())[0].short_id).toBe("sec-4");
    h.logs.length = 0;
    await h.run("--json");
    expect(JSON.parse(h.out())[0].name).toBe("stripe-test");
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/vault/events" ? [] : meta());
    await h.run("show", "stripe-test", "--json");
    expect(JSON.parse(h.out()).events).toEqual([]);
  });

  test("a file piped on stdin is stored byte for byte, final newline included", async () => {
    const { terminalIO } = await import("./command.js");
    const { readPayload } = await import("./inject.js");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
    expect(await readPayload("file", {}, terminalIO(false, () => pem))).toEqual({ content: pem });
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

  test("a secret with no --env says the vars run fills from its name: add, ls and show", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-file-"));
    fs.writeFileSync(path.join(dir, "sa.json"), "{}");
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : { id: "x", short_id: "sec-6", name: "gcp-sa" });
    await h.run("add", "gcp-sa", "--kind", "file", "--file", path.join(dir, "sa.json"));
    expect(h.out()).toContain("run fills GCP_SA_FILE");
    const file = meta({ name: "gcp-sa", kind: "file", env: undefined });
    const login = meta({ name: "gh-bot", kind: "login", env: undefined });
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : [file, login]);
    await h.run("ls");
    expect(h.out()).toContain("GCP_SA_FILE");
    expect(h.out()).toContain("GH_BOT_USERNAME,GH_BOT_PASSWORD");
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : p === "/cli/vault/events" ? [] : file);
    await h.run("show", "gcp-sa");
    expect(h.out()).toMatch(/env\s+GCP_SA_FILE\s+from its name/);
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

  test("show gives a sign-in's sites and when it expires", async () => {
    const signin = meta({ kind: "signin", env: undefined, sites: ["vercel.com"], signin_expires_at: Date.now() + 10 * 86_400_000 + 3_600_000 });
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : p === "/cli/vault/events" ? [] : signin);
    await h.run("show", "vercel-signin");
    expect(h.out()).toContain("vercel.com");
    expect(h.out()).toMatch(/expires\s+in 10d \(\d{4}-\d{2}-\d{2}\)/);
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? TEAMS : p === "/cli/vault/events" ? [] : { ...signin, signin_expires_at: Date.now() - 2 * 86_400_000 });
    await h.run("show", "vercel-signin");
    expect(h.out()).toContain("expired 2d ago");
  });

  describe("Ask first", () => {
    const HELD = {
      needs_approval: { decision: "sd-41", secret: "stripe-live" },
      approvals: [{ decision: "sd-41", secret: "stripe-live" }],
      message: "server words",
    };

    test("get, env and otp read nothing, name the decision and the dormant line, and exit 3", async () => {
      h.answer = () => HELD;
      for (const argv of [["get", "stripe-live", "--why", "refund a test charge"], ["env", "stripe-live"], ["otp", "stripe-live"]]) {
        h.logs.length = 0;
        await expect(h.run(...argv)).rejects.toThrow("exit 3");
        expect(h.out()).toContain("sd-41");
        expect(h.out()).toContain(`cast state --status dormant "Waiting on sd-41 to use stripe-live"`);
      }
      expect(stdout).toBe("");
      expect(h.calls[0]!.body).toEqual({ refs: ["stripe-live"], purpose: "get", why: "refund a test charge", conversation: "s1" });
    });

    test("run never starts the command, and --why before -- reaches the read", async () => {
      const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vault-held-")), "ran");
      h.answer = () => ({ ...HELD, approvals: [...HELD.approvals, { decision: "sd-42", secret: "openai" }] });
      await expect(h.run("run", "stripe-live", "openai", "--why", "billing tests", "--", "touch", marker)).rejects.toThrow("exit 3");
      expect(fs.existsSync(marker)).toBe(false);
      expect(h.calls).toEqual([{ path: "/cli/vault/read", body: { refs: ["stripe-live", "openai"], purpose: "run", why: "billing tests", conversation: "s1" } }]);
      expect(h.out()).toContain(`"Waiting on sd-41, sd-42 to use stripe-live, openai"`);
    });

    test("ask-first on posts at once; off is a person's, on the Vault page, and never reaches the backend", async () => {
      h.answer = (_p, b) => ({ id: "x", short_id: "sec-4", name: "stripe-live", ask_first: b.ask_first });
      await h.run("ask-first", "stripe-live", "on");
      expect(h.calls).toEqual([{ path: "/cli/vault/ask-first", body: { ref: "stripe-live", ask_first: true } }]);
      expect(h.out()).toContain("ask first on");
      h.calls.length = 0;
      await expect(h.run("ask-first", "stripe-live", "off")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("Only a person turns Ask first off");
      expect(h.calls).toEqual([]);
      await expect(h.run("ask-first", "stripe-live", "maybe")).rejects.toThrow("exit 1");
    });
  });

  describe("restore", () => {
    const NOW = Date.now();
    const VERSIONS = [
      { _id: "v2", rotated_at: NOW - 3_600_000, rotated_by_name: "Ana", fingerprint: "sk_t…bbbb", expires_at: NOW + 6 * 86_400_000 + 600_000 },
      { _id: "v1", rotated_at: NOW - 2 * 86_400_000, fingerprint: "sk_t…aaaa", expires_at: NOW + 5 * 86_400_000 },
    ];
    const answer = (p: string) => (p === "/cli/vault/show" ? meta() : p === "/cli/vault/versions" ? VERSIONS : { id: "x", short_id: "sec-4", name: "stripe-test", restored_from: VERSIONS[1]!.rotated_at });

    test("with no version it lists them, newest first, numbered, and changes nothing", async () => {
      h.answer = answer;
      await h.run("restore", "stripe-test");
      const [first, second, hint] = h.out().split("\n");
      for (const part of ["1", "replaced 1h ago by Ana", "sk_t…bbbb", "kept in 6d"]) expect(first).toContain(part);
      for (const part of ["2", "replaced 2d ago", "sk_t…aaaa"]) expect(second).toContain(part);
      expect(hint).toContain("cast vault restore stripe-test <number>");
      expect(h.calls.map((c) => c.path)).toEqual(["/cli/vault/show", "/cli/vault/versions"]);
    });

    test("a version by number or rotated_at needs --yes off a terminal, then posts its id", async () => {
      h.answer = answer;
      await expect(h.run("restore", "stripe-test", "2")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("cast vault restore stripe-test 2 --yes");
      expect(h.calls.map((c) => c.path)).not.toContain("/cli/vault/restore");
      h.calls.length = 0;
      await h.run("restore", "stripe-test", String(VERSIONS[1]!.rotated_at), "--yes");
      expect(h.calls.at(-1)).toEqual({ path: "/cli/vault/restore", body: { ref: "sec-4", version: "v1" } });
      expect(h.out()).toContain("restored");
      expect(h.out()).toContain("sk_t…aaaa");
    });

    test("a version that is not listed is refused before any write", async () => {
      h.answer = answer;
      await expect(h.run("restore", "stripe-test", "7", "--yes")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("stripe-test has no version 7");
      expect(h.calls.map((c) => c.path)).not.toContain("/cli/vault/restore");
    });
  });

  describe("health and flags in ls and show", () => {
    const DAY = 86_400_000;
    test("ls carries 2fa, ask-first, earlier values and each health as a short token", async () => {
      const { formatSecretLine } = await import("./command.js");
      const now = Date.now();
      const line = (over: Partial<SecretMeta>) => formatSecretLine(meta(over), "Acme", now);
      const flagged = line({ kind: "login", has_otp: true, ask_first: true, version_count: 2, use_count: 3 });
      for (const part of ["login+2fa", "ask-first", "2 earlier", "used 2h ago"]) expect(flagged).toContain(part);
      expect(line({ kind: "signin", signin_expires_at: now - DAY, use_count: 1 })).toContain("expired");
      expect(line({ kind: "signin", signin_expires_at: now + 2 * DAY, use_count: 1 })).toContain("expiring in 2d");
      expect(line({ last_used_at: now - 100 * DAY, use_count: 1 })).toContain("stale");
      const unused = line({ last_used_at: undefined, use_count: 0, created_at: now - 2 * DAY });
      expect(unused.match(/never used/g)).toHaveLength(1);
      expect(line({ use_count: 1 })).not.toMatch(/stale|expir|never used|ask-first|earlier/);
    });

    test("show gives health, Ask first, 2FA, earlier values and the decision behind an approval", async () => {
      const at = Date.now() - 60_000;
      h.answer = (p) => (p === "/cli/teams" ? TEAMS : p === "/cli/vault/events"
        ? [{ kind: "approval_requested", at, decision_short_id: "sd-41", session_short_id: "jx7c6zk" }]
        : meta({ kind: "login", has_otp: true, ask_first: true, version_count: 1, last_used_at: Date.now() - 100 * DAY, use_count: 4 }));
      await h.run("show", "stripe-test");
      for (const part of ["login+2fa", "stale", "a person approves each session's first read", "cast vault otp stripe-test", "1 value", "cast vault restore stripe-test", "approval_requested", "sd-41"]) expect(h.out()).toContain(part);
    });
  });

  describe("run --env-file", () => {
    let dir = "";
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-envfile-"));
      process.env.CODECAST_CWD = dir;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
    const stripe = { id: "x", short_id: "sec-4", name: "stripe-test", kind: "key", env: ["STRIPE_TEST"], payload: { value: VALUE } };
    const gh = { id: "y", short_id: "sec-5", name: "github-bot", kind: "login", payload: { username: "ci", password: "pw" } };

    test("references fill from one read, literals pass through, a later file wins, and the secret adds no env names of its own", async () => {
      write(".env", "STRIPE_SECRET_KEY=vault://stripe-test\nGH_USER=vault://github-bot/username\nMODE=dev\n");
      write(".env.local", "MODE=local\n");
      h.answer = (p) => (p === "/cli/vault/list" ? [meta(), meta({ short_id: "sec-5", name: "github-bot", kind: "login" })] : { secrets: [stripe, gh] });
      const check = `test "$STRIPE_SECRET_KEY" = "${VALUE}" && test "$GH_USER" = ci && test "$MODE" = local && test -z "$STRIPE_TEST" && exit 3`;
      await expect(h.run("run", "--env-file", ".env", "--env-file=.env.local", "--", "sh", "-c", check)).rejects.toThrow("exit 3");
      expect(h.calls).toEqual([
        { path: "/cli/vault/list", body: {} },
        { path: "/cli/vault/read", body: { refs: ["stripe-test", "github-bot"], purpose: "run", conversation: "s1" } },
      ]);
    });

    test("a file of literals runs with no Vault call", async () => {
      write(".env", "MODE=dev\n");
      await expect(h.run("run", "--env-file", ".env", "--", "sh", "-c", `test "$MODE" = dev && exit 3`)).rejects.toThrow("exit 3");
      expect(h.calls).toEqual([]);
    });

    test("unresolved references stop the run with each var and its fix, before any value is read", async () => {
      write(".env", "STRIPE_SECRET_KEY=vault://stripe-test\nOPENAI_API_KEY=vault://openai\n");
      h.answer = () => [meta({ status: "requested", short_id: "sec-4" })];
      await expect(h.run("run", "--env-file", ".env", "--", "true")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("STRIPE_SECRET_KEY: stripe-test (sec-4) is requested and has no value yet. Fill it on the Vault page or with cast vault fill stripe-test");
      expect(h.out()).toContain("OPENAI_API_KEY: no secret openai in your Vault. Ask for it: cast vault request openai --env OPENAI_API_KEY");
      expect(h.calls.map((c) => c.path)).toEqual(["/cli/vault/list"]);
    });

    test("a missing file or a malformed reference is refused before any request", async () => {
      await expect(h.run("run", "--env-file", "nope.env", "--", "true")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("Cannot read");
      write(".env", "K=vault://Not A Name\n");
      await expect(h.run("run", "--env-file", ".env", "--", "true")).rejects.toThrow("exit 1");
      expect(h.out()).toContain("K: vault://Not A Name is not a reference");
      expect(h.calls).toEqual([]);
    });
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
      expect(h.out()).toContain("[vault] STRIPE_SECRET_KEY: the value is not a secret name");
      expect(h.out()).not.toContain("Stripe Test");
      expect(h.calls).toEqual([]);
    });
  });
});
