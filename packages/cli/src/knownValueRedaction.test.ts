import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  KnownValueStore,
  buildMatcher,
  collectFromDockerConfig,
  collectFromDotenv,
  collectFromEnv,
  collectFromKeyValueLines,
  collectFromNetrc,
  envFilesIn,
  qualifiesAsKnownValue,
  redactKnownValues,
  redactWithMatcher,
  setKnownValuesForTest,
} from "./knownValueRedaction.js";
import { redactionValuesOf } from "@codecast/shared/contracts/secrets";
import { redactSecrets } from "./secretRedaction.js";
import { vaultRedactionSource } from "./secrets/redactionSource.js";

const values = (list: Array<{ value: string }>) => list.map((v) => v.value);

afterEach(() => setKnownValuesForTest(null));

describe("length floors", () => {
  test("8 chars minimum for mixed values", () => {
    expect(qualifiesAsKnownValue("a1b2c3d")).toBe(false);
    expect(qualifiesAsKnownValue("a1b2c3d4")).toBe(true);
  });
  test("12 for all digits", () => {
    expect(qualifiesAsKnownValue("12345678901")).toBe(false);
    expect(qualifiesAsKnownValue("123456789012")).toBe(true);
  });
  test("16 for letters only", () => {
    expect(qualifiesAsKnownValue("development")).toBe(false);
    expect(qualifiesAsKnownValue("postgres_user_name")).toBe(true);
  });
  test("paths never qualify", () => {
    expect(qualifiesAsKnownValue("/private/tmp/com.apple.launchd.x9/Listeners")).toBe(false);
  });
});

describe("collectors", () => {
  test("env: secret-named variables only, AUTHOR is not AUTH, URL passwords from any variable", () => {
    const got = collectFromEnv({
      MY_SERVICE_TOKEN: "tok_9f8e7d6c5b4a",
      GITHUB_AUTH: "abc123def456",
      GIT_AUTHOR_NAME: "Someone Long Name",
      HOME: "/Users/x",
      DATABASE_URL: "postgres://app:hunter2hunter2@db.internal/app",
    });
    expect(values(got)).toEqual(["tok_9f8e7d6c5b4a", "abc123def456", "hunter2hunter2", "hunter2hunter2"]);
  });

  test("dotenv: secret names, generated-looking values, URL passwords; plain config stays", () => {
    const got = collectFromDotenv([
      "# comment",
      "export SESSION_SECRET='s3cr3t-value-here'",
      'WEIRD_ID="q8Z2mW9xL4vT7nB1"',
      "NEXT_PUBLIC_URL=https://example.com/app",
      "NODE_ENV=development",
      "REDIS_URL=redis://default:p4ssw0rdRedis@cache:6379",
      "PLAIN=abc # trailing comment",
    ].join("\n"));
    expect(values(got)).toEqual(["s3cr3t-value-here", "q8Z2mW9xL4vT7nB1", "p4ssw0rdRedis", "p4ssw0rdRedis"]);
    expect(got[0].name).toBe("SESSION_SECRET");
  });

  test("netrc", () => {
    expect(values(collectFromNetrc("machine api.example.com\n  login me\n  password n3tRcPassw0rd\n"))).toEqual(["n3tRcPassw0rd"]);
  });

  test("aws credentials", () => {
    const got = collectFromKeyValueLines("[default]\naws_access_key_id = AKIAEXAMPLEKEY12345\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCY\nregion = us-east-1\n", "=", /^aws_(?:access_key_id|secret_access_key|session_token)$/i);
    expect(values(got)).toEqual(["AKIAEXAMPLEKEY12345", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY"]);
  });

  test("npmrc scoped auth token", () => {
    const got = collectFromKeyValueLines("registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_aB3dE5fG7hJ9kL1m\n", "=", /^_auth$/);
    expect(values(got)).toEqual(["npm_aB3dE5fG7hJ9kL1m"]);
    expect(got[0].name).toBe("authToken");
  });

  test("gh hosts.yml", () => {
    const got = collectFromKeyValueLines("github.com:\n    user: me\n    oauth_token: gho_xyzXYZ0123456789\n    git_protocol: ssh\n", ":");
    expect(values(got)).toEqual(["gho_xyzXYZ0123456789"]);
  });

  test("docker config: auth blob and its decoded password", () => {
    const auth = Buffer.from("me:d0ckerPassw0rd!").toString("base64");
    const got = collectFromDockerConfig(JSON.stringify({ auths: { "ghcr.io": { auth } } }));
    expect(values(got)).toEqual([auth, "d0ckerPassw0rd!"]);
  });

  test("only .env and .env.* files, templates excluded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kv-envfiles-"));
    for (const f of [".env", ".env.local", ".env.production", ".env.example", ".env.sample", ".envrc", "env"]) fs.writeFileSync(path.join(dir, f), "");
    expect(envFilesIn(dir).map((f) => path.basename(f)).sort()).toEqual([".env", ".env.local", ".env.production"]);
  });
});

describe("matcher", () => {
  test("replaces exact occurrences with a named marker", () => {
    const m = buildMatcher([{ value: "zq7Kp2Lm9Xw4", name: "MY_TOKEN" }]);
    expect(redactWithMatcher("token is zq7Kp2Lm9Xw4, again zq7Kp2Lm9Xw4.", m)).toBe(
      "token is [redacted:known:MY_TOKEN], again [redacted:known:MY_TOKEN].",
    );
  });

  test("longest first when one value contains another", () => {
    const m = buildMatcher([{ value: "abcd1234" }, { value: "abcd1234efgh5678", name: "LONG" }]);
    expect(redactWithMatcher("x abcd1234efgh5678 y abcd1234 z", m)).toBe("x [redacted:known:LONG] y [redacted:known] z");
  });

  test("values below the floors are ignored", () => {
    const m = buildMatcher([{ value: "short1" }, { value: "development" }, { value: "12345678" }]);
    expect(m.size).toBe(0);
    expect(redactWithMatcher("short1 development 12345678", m)).toBe("short1 development 12345678");
  });

  test("idempotent, and through redactSecrets", () => {
    setKnownValuesForTest([{ value: "opaque-Pw-7731xyz", name: "DB_PASS" }]);
    const once = redactSecrets("connect with opaque-Pw-7731xyz now");
    expect(once).toBe("connect with [redacted:known:DB_PASS] now");
    expect(redactSecrets(once)).toBe(once);
    expect(redactKnownValues(once)).toBe(once);
  });

  test("pass-through when no store is active", () => {
    expect(redactKnownValues("opaque-Pw-7731xyz")).toBe("opaque-Pw-7731xyz");
  });

  test("200 KB message with 500 known values stays under 20 ms", () => {
    const rand = (n: number) => Array.from({ length: n }, () => "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 56)]).join("");
    const known = Array.from({ length: 500 }, (_, i) => ({ value: `${rand(11 + (i % 40))}7`, name: `V${i}` }));
    const m = buildMatcher(known);
    const filler = "const result = await fetch(url, { headers }); // ordinary transcript text\n";
    let text = "";
    while (text.length < 200_000) text += filler + (Math.random() < 0.05 ? known[Math.floor(Math.random() * 500)].value : "");
    redactWithMatcher(text, m); // warm up
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      redactWithMatcher(text, m);
      runs.push(performance.now() - t0);
    }
    const median = runs.sort((a, b) => a - b)[2];
    expect(median).toBeLessThan(20);
    const out = redactWithMatcher(text, m);
    for (const { value } of known) expect(out.includes(value)).toBe(false);
  });
});

describe("store", () => {
  test("collects from HOME files, codecast config, env and a tracked cwd's .env; refreshes on change", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kv-home-"));
    const configDir = path.join(home, ".codecast");
    const repo = path.join(home, "repo");
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "sub"));
    fs.mkdirSync(path.join(home, ".aws"));
    fs.writeFileSync(path.join(home, ".netrc"), "machine x login me password netrcPw-112233\n");
    fs.writeFileSync(path.join(home, ".aws", "credentials"), "[default]\naws_secret_access_key = awsSecret/998877abc\n");
    fs.writeFileSync(path.join(home, "unlisted.txt"), "password = neverReadMe-445566\n");
    fs.writeFileSync(path.join(configDir, "provider-keys.json"), JSON.stringify({ anthropic: "provKey-55443322" }));
    fs.writeFileSync(path.join(repo, ".env"), "SERVICE_PASSWORD=repoEnvPw-776655\n");

    const store = new KnownValueStore({
      home,
      configDir,
      env: () => ({ CI_TOKEN: "envTok-13579bdf" }),
      codecastSecrets: () => ["codecastSecret-24680"],
    });
    try {
      store.rebuild();
      const text = "netrcPw-112233 awsSecret/998877abc neverReadMe-445566 provKey-55443322 repoEnvPw-776655 envTok-13579bdf codecastSecret-24680";
      expect(redactKnownValues(text)).toBe(
        "[redacted:known:netrc] [redacted:known:aws_secret_access_key] neverReadMe-445566 [redacted:known:anthropic-key] repoEnvPw-776655 [redacted:known:CI_TOKEN] [redacted:known:codecast]",
      );

      // A session in a subdirectory picks up the git root's .env immediately.
      store.trackCwd(path.join(repo, "sub"));
      expect(redactKnownValues("repoEnvPw-776655")).toBe("[redacted:known:SERVICE_PASSWORD]");

      fs.writeFileSync(path.join(repo, ".env"), "SERVICE_PASSWORD=rotatedPw-000111\n");
      store.rebuild();
      expect(redactKnownValues("rotatedPw-000111 repoEnvPw-776655")).toBe("[redacted:known:SERVICE_PASSWORD] repoEnvPw-776655");
    } finally {
      store.stop();
    }
  });
});

describe("vault values", () => {
  const emptyHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kv-vault-"));
    return { home, configDir: path.join(home, ".codecast") };
  };
  const fixedVault = (list: Array<{ name: string; value: string }>) => ({ values: () => list, refresh: async () => false });

  test("a Vault value skips the shape floors but keeps a small minimum, and a Vault name beats an env name for the same value", () => {
    const store = new KnownValueStore({
      ...emptyHome(),
      env: () => ({ STRIPE_TOKEN: "sk_vault_9f8e7d6c5b4a", OTHER_TOKEN: "correcthorse" }),
      vault: fixedVault([
        { name: "stripe", value: "sk_vault_9f8e7d6c5b4a" },
        { name: "pin", value: "1234" },
        { name: "word", value: "correcthorse" },
        { name: "digits", value: "8675309" },
      ]),
    });
    try {
      const m = store.rebuild();
      expect(m.size).toBe(3);
      expect(redactKnownValues("sk_vault_9f8e7d6c5b4a 1234 correcthorse 8675309")).toBe("[redacted:known:stripe] 1234 [redacted:known:word] [redacted:known:digits]");
    } finally {
      store.stop();
    }
  });

  test("a value with a quote, a backslash or a newline is caught once a tool call's input is JSON-stringified, once or twice", () => {
    setKnownValuesForTest([
      { value: 'pa"ss\\w0rd-77', name: "db", vault: true },
      { value: "first-line-Xy7\nsecond-line-Zq9", name: "cert", vault: true },
    ]);
    try {
      const input = { command: `psql --password='pa"ss\\w0rd-77'`, content: "first-line-Xy7\nsecond-line-Zq9" };
      const once = redactSecrets(JSON.stringify(input));
      expect(once).not.toContain("w0rd-77");
      expect(once).not.toContain("second-line-Zq9");
      expect(once).toContain("[redacted:known:db]");
      expect(once).toContain("[redacted:known:cert]");
      expect(redactSecrets(JSON.stringify({ input: JSON.stringify(input) }))).not.toMatch(/w0rd-77|second-line-Zq9/);
    } finally {
      setKnownValuesForTest(null);
    }
  });

  test("a Vault login's password is caught inside a Basic auth header, a base64url token and a percent-encoded URL", () => {
    const password = "zz-Tr0ub4dor&3xx";
    setKnownValuesForTest([{ value: password, name: "zz-login", vault: true }]);
    const basic = (user: string) => Buffer.from(`${user}:${password}`).toString("base64");
    // Each username length puts the password at another byte offset inside the encoding.
    for (const user of ["zzbot", "zzbot1", "zzbot12"]) {
      const out = redactKnownValues(redactSecrets(`> Authorization: Basic ${basic(user)}`));
      expect(out).toContain("[redacted:known:zz-login]");
      expect(out).not.toContain(basic(user).slice(12, -4));
      const url = Buffer.from(`${user}:${password}`).toString("base64url");
      expect(redactKnownValues(`token=${url}`)).toContain("[redacted:known:zz-login]");
    }
    const out = redactKnownValues(redactSecrets("https://zzbot:zz-Tr0ub4dor%263xx@example.com/x"));
    expect(out).toContain("[redacted:known:zz-login]");
    expect(out).not.toContain("Tr0ub4dor");
    setKnownValuesForTest([{ value: "zz/Pw0rd=9xq", name: "zz-slash", vault: true }]);
    for (const url of ["https://u:zz%2FPw0rd%3D9xq@h/x", "https://u:zz%2fPw0rd%3d9xq@h/x"]) {
      expect(redactKnownValues(url)).toBe("https://u:[redacted:known:zz-slash]@h/x");
    }
  });

  test("an encoded form shorter than 8 chars is not matched, and a value outside the Vault gets no encoded forms", () => {
    const short = buildMatcher([{ value: "ab", name: "x", vault: true }, { value: "pin123", name: "pin", vault: true }]);
    expect(redactWithMatcher(Buffer.from("pin").toString("base64"), short)).toBe("cGlu");
    const env = buildMatcher([{ value: "zq7Kp2Lm9Xw4", name: "key" }]);
    const encoded = Buffer.from("zq7Kp2Lm9Xw4").toString("base64");
    expect(redactWithMatcher(encoded, env)).toBe(encoded);
  });

  test("a Vault value inside a marker is dropped, so a second pass changes nothing", () => {
    const m = buildMatcher([{ value: "redacted", name: "a", vault: true }, { value: "stripe-test", name: "stripe-test", vault: true }, { value: "zq7Kp2Lm9Xw4", name: "key" }]);
    expect(m.size).toBe(1);
    const once = redactWithMatcher("zq7Kp2Lm9Xw4 redacted stripe-test", m);
    expect(redactWithMatcher(once, m)).toBe(once);
  });

  test("end to end: a transcript line holding a Vault value syncs with the secret's name", async () => {
    let version = "team:a=1";
    let values = [{ name: "prod-db", value: "opaque-Db-Pw-7731xyz" }];
    const fetch = (async (url: string) =>
      url.endsWith("/redaction-version") ? Response.json({ version }) : Response.json({ version, values })) as unknown as typeof globalThis.fetch;
    const store = new KnownValueStore({
      ...emptyHome(),
      env: () => ({}),
      vault: vaultRedactionSource({ endpoint: () => ({ siteUrl: "https://b.test", apiToken: "t" }), fetch }),
    });
    try {
      store.rebuild();
      await store.refreshVault();
      const line = JSON.stringify({ type: "user", message: { content: "psql -p opaque-Db-Pw-7731xyz" } });
      expect(redactSecrets(line)).toBe(JSON.stringify({ type: "user", message: { content: "psql -p [redacted:known:prod-db]" } }));

      // A rotation reaches the matcher on the next tick.
      version = "team:a=2";
      values = [{ name: "prod-db", value: "rotated-Db-Pw-000111" }];
      await store.refreshVault();
      expect(redactSecrets("rotated-Db-Pw-000111")).toBe("[redacted:known:prod-db]");
    } finally {
      store.stop();
    }
  });

  test("a refresh still in flight when the store stops installs nothing", async () => {
    let land: (changed: boolean) => void = () => {};
    const store = new KnownValueStore({
      ...emptyHome(),
      env: () => ({}),
      vault: { values: () => [{ name: "late", value: "late-Value-Pw-445566" }], refresh: () => new Promise<boolean>((r) => (land = r)) },
    });
    store.start();
    expect(redactKnownValues("late-Value-Pw-445566")).toBe("[redacted:known:late]");
    const pending = store.refreshVault();
    store.stop();
    land(true);
    await pending;
    expect(redactKnownValues("late-Value-Pw-445566")).toBe("late-Value-Pw-445566");
  });
});

describe("Vault values the redactor once dropped", () => {
  // Generated, so no token-shaped literal sits in the repo.
  const b64 = (n: number, seed: number) => Array.from({ length: n }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[(i * 7 + seed * 13 + ((i * i) % 11)) % 64]).join("");
  const fromVault = (name: string, ...args: Parameters<typeof redactionValuesOf>) =>
    buildMatcher(redactionValuesOf(...args).map((value) => ({ value, name, vault: true as const })));

  test("a 14 KB kubeconfig: cat of the whole file and a grep of one line both come out redacted", () => {
    const token = b64(1200, 4);
    const keyData = b64(6000, 5);
    const content = ["apiVersion: v1", "users:", "- name: admin", "  user:", `    certificate-authority-data: ${b64(7000, 6)}`, `    token: ${token}`, `    client-key-data: ${keyData}`].join("\n");
    const m = fromVault("zz-kube", "file", { content });
    const cat = redactWithMatcher(content, m);
    for (const v of [token.slice(0, 40), keyData.slice(100, 140)]) expect(cat).not.toContain(v);
    expect(redactWithMatcher(`    token: ${token}`, m)).toBe("    token: [redacted:known:zz-kube]");
  });

  test("a key over 8192 characters is redacted printed whole and from any piece boundary on", () => {
    const value = b64(10_000, 7);
    const m = fromVault("zz-long", "key", { value });
    expect(redactWithMatcher(`KEY=${value}`, m)).not.toMatch(/[A-Za-z0-9+\/]{64}/);
    expect(redactWithMatcher(value.slice(640, 2000), m)).not.toContain(value.slice(704, 800));
  });

  test("one printed line of a multi-line key is redacted", () => {
    const [a, b] = [b64(30, 8), b64(30, 9)];
    const m = fromVault("zz-k", "key", { value: `${a}\n${b}` });
    expect(redactWithMatcher(`line 2: ${b}`, m)).toBe("line 2: [redacted:known:zz-k]");
  });
});
