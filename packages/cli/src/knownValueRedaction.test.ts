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
import { redactSecrets } from "./secretRedaction.js";

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
    const known = Array.from({ length: 500 }, (_, i) => ({ value: rand(12 + (i % 40)), name: `V${i}` }));
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
