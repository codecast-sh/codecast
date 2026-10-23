// cast vault's local half: reading a value in, env mapping, temp files, quoting, the Files hint.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellQuote } from "../shellQuote.js";
import { argsAfterGroup, filesCommandFor, splitRunArgs } from "./argv.js";
import {
  exportLines,
  fieldValue,
  materialize,
  primaryValue,
  readPayload,
  runWith,
  sweepStaleTemp,
  LEGACY_TEMP_MS,
  type ReadSecret,
  type ValueIO,
} from "./inject.js";

function io(over: Partial<ValueIO> = {}): ValueIO & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    tty: false,
    hidden: async (prompts) => (asked.push(prompts), prompts.map((_, i) => ["first", "second"][i] ?? "")),
    ask: async () => "",
    stdin: () => "WHOLE\nFILE\n",
    env: {},
    readFile: () => "FROM DISK",
    ...over,
  };
}

describe("readPayload", () => {
  test("a key from the hidden prompt, or from --from-env without prompting", async () => {
    expect(await readPayload("key", {}, io())).toEqual({ value: "first" });
    const quiet = io({ env: { TOK: "envvalue" } });
    expect(await readPayload("key", { fromEnv: "TOK" }, quiet)).toEqual({ value: "envvalue" });
    expect(quiet.asked).toEqual([]);
  });

  test("an unset --from-env names the variable", async () => {
    await expect(readPayload("key", { fromEnv: "NOPE" }, io())).rejects.toThrow("NOPE is not set");
  });

  test("a login: username from the flag, password then 2FA seed from the hidden prompts", async () => {
    const x = io();
    expect(await readPayload("login", { username: "bot", totp: true }, x)).toEqual({ username: "bot", password: "first", totp_seed: "second" });
    expect(x.asked[0]!.length).toBe(2);
    // --from-env takes the password, so only the seed is prompted for.
    const y = io({ env: { PW: "pw" }, hidden: async (p) => p.map(() => "SEED") });
    expect(await readPayload("login", { fromEnv: "PW", totp: true }, y)).toEqual({ password: "pw", totp_seed: "SEED" });
  });

  test("a 2FA seed without a terminal: --totp-from-env, or the stdin line after the password", async () => {
    const x = io({ env: { SEED: "JBSWY3DPEHPK3PXP" } });
    expect(await readPayload("login", { username: "bot", totpFromEnv: "SEED" }, x)).toEqual({ username: "bot", password: "first", totp_seed: "JBSWY3DPEHPK3PXP" });
    expect(x.asked).toEqual([["Password (hidden, blank for none): "]]);
    const both = io({ env: { PW: "pw", SEED: "S" } });
    expect(await readPayload("login", { fromEnv: "PW", totpFromEnv: "SEED" }, both)).toEqual({ password: "pw", totp_seed: "S" });
    expect(both.asked).toEqual([]);
    await expect(readPayload("key", { totpFromEnv: "SEED" }, x)).rejects.toThrow("--kind login");
  });

  test("a missing seed says how to give one without a prompt", async () => {
    const onePiped = io({ hidden: async (p) => p.map((_, i) => (i === 0 ? "pw" : "")) });
    await expect(readPayload("login", { totp: true }, onePiped)).rejects.toThrow("pipe it as the second stdin line, after the password, or pass --totp-from-env VAR");
    const fromEnv = io({ env: { PW: "pw" }, hidden: async (p) => p.map(() => "") });
    await expect(readPayload("login", { fromEnv: "PW", totp: true }, fromEnv)).rejects.toThrow("pipe it as the first stdin line, or pass --totp-from-env VAR");
  });

  test("a file from --file keeps its name; piped, the whole of stdin", async () => {
    expect(await readPayload("file", { file: "/x/sa.json" }, io())).toEqual({ content: "FROM DISK", filename: "sa.json" });
    expect(await readPayload("file", {}, io())).toEqual({ content: "WHOLE\nFILE\n" });
    await expect(readPayload("file", {}, io({ tty: true }))).rejects.toThrow("--file <path>");
  });

  test("flags that belong to another kind are refused, and a sign-in is never typed", async () => {
    await expect(readPayload("key", { totp: true }, io())).rejects.toThrow("--kind login");
    await expect(readPayload("key", { file: "a" }, io())).rejects.toThrow("--kind file");
    await expect(readPayload("signin", {}, io())).rejects.toThrow("Save sign-in");
  });
});

const key = (name: string, value: string, env?: string[]): ReadSecret => ({ id: name, short_id: "sec-1", name, kind: "key", env, payload: { value } });
const login: ReadSecret = { id: "l", short_id: "sec-2", name: "github-bot", kind: "login", payload: { username: "ci", password: "pw'd" } };
const file: ReadSecret = { id: "f", short_id: "sec-3", name: "gcp-sa", kind: "file", payload: { content: "{\"k\":1}", filename: "sa.json" } };
const signin: ReadSecret = { id: "s", short_id: "sec-4", name: "vercel", kind: "signin", payload: { cookies: [], captured_from: "chrome" } };

describe("materialize", () => {
  test("keys fill their env names or NAME_UPPER; a login its two vars; a sign-in nothing", () => {
    const m = materialize([key("stripe-test", "sk"), key("db", "url", ["DATABASE_URL"]), login, signin]);
    expect(m.env).toEqual({ STRIPE_TEST: "sk", DATABASE_URL: "url", GITHUB_BOT_USERNAME: "ci", GITHUB_BOT_PASSWORD: "pw'd" });
    expect(m.skipped).toEqual(["vercel"]);
    m.cleanup();
  });

  test("a file secret becomes a 0600 file in a 0700 directory, gone after cleanup", () => {
    const m = materialize([file]);
    const p = m.env.GCP_SA_FILE!;
    expect(path.basename(p)).toBe("sa.json");
    expect(fs.readFileSync(p, "utf-8")).toBe("{\"k\":1}");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(path.dirname(p))).mode & 0o777).toBe(0o700);
    m.cleanup();
    expect(fs.existsSync(path.dirname(path.dirname(p)))).toBe(false);
  });

  test("for env output a file is left out rather than left on disk", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
    const m = materialize([file, key("a", "1")], { writeFiles: false, tmpRoot: tmp });
    expect(m.env).toEqual({ A: "1" });
    expect(m.skipped).toEqual(["gcp-sa"]);
    expect(fs.readdirSync(tmp)).toEqual([]);
    fs.rmSync(tmp, { recursive: true });
  });

  test("a project map names the vars: key value, login password, file path", () => {
    const m = materialize([key("stripe-test", "sk"), login, file], { map: { STRIPE_SECRET_KEY: "stripe-test", GH_PASS: "github-bot", CREDS: "gcp-sa" } });
    expect(m.env.STRIPE_SECRET_KEY).toBe("sk");
    expect(m.env.GH_PASS).toBe("pw'd");
    expect(fs.existsSync(m.env.CREDS!)).toBe(true);
    expect(Object.keys(m.env)).toHaveLength(3);
    m.cleanup();
  });
});

describe("file secrets left on disk", () => {
  const legacyEnv: ReadSecret = { id: "n", short_id: "sec-5", name: "node-opts", kind: "key", env: ["NODE_OPTIONS"], payload: { value: "--require x" } };

  test("an env check that throws after a file was written removes the file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
    expect(() => materialize([file, legacyEnv], { tmpRoot: tmp })).toThrow("node-opts");
    expect(fs.readdirSync(tmp)).toEqual([]);
    fs.rmSync(tmp, { recursive: true });
  });

  test("the temp directory carries its owner's pid, and the next run removes a dead owner's", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
    const m = materialize([file], { tmpRoot: tmp });
    expect(fs.readdirSync(tmp)[0]!.startsWith(`cast-vault-${process.pid}-`)).toBe(true);
    const dead = path.join(tmp, "cast-vault-999999999-abc");
    const legacyOld = path.join(tmp, "cast-vault-old123");
    const legacyNew = path.join(tmp, "cast-vault-new123");
    for (const d of [dead, legacyOld, legacyNew]) fs.mkdirSync(d);
    const now = Date.now();
    fs.utimesSync(legacyOld, new Date(now - LEGACY_TEMP_MS - 60_000), new Date(now - LEGACY_TEMP_MS - 60_000));
    sweepStaleTemp(tmp, now);
    expect(fs.readdirSync(tmp).sort()).toEqual([path.basename(path.dirname(path.dirname(m.env.GCP_SA_FILE!))), "cast-vault-new123"].sort());
    m.cleanup();
    fs.rmSync(tmp, { recursive: true });
  });
});

describe("primaryValue", () => {
  test("a kind's default field, a file's temp path, and why a login without a password has none", () => {
    expect(primaryValue(key("k", "v"))).toEqual({ value: "v" });
    expect(primaryValue(login)).toEqual({ value: "pw'd" });
    expect(primaryValue(file, "/tmp/sa.json")).toEqual({ value: "/tmp/sa.json" });
    expect("error" in primaryValue(file)).toBe(true);
    expect("error" in primaryValue({ ...login, payload: { username: "ci" } })).toBe(true);
    expect("error" in primaryValue(signin)).toBe(true);
  });
});

describe("materialize with a project map and names", () => {
  test("names add their own vars on top of the map, and win a var both set", () => {
    const m = materialize([key("stripe-test", "from-map"), key("stripe-live", "named", ["STRIPE_SECRET_KEY"]), key("db", "url")], {
      map: { STRIPE_SECRET_KEY: "stripe-test", DATABASE_URL: "db" },
      named: ["stripe-live"],
    });
    expect(m.env).toEqual({ STRIPE_SECRET_KEY: "named", DATABASE_URL: "url" });
  });

  test("a name given by short id counts as named; a mapped sign-in is skipped, not silently dropped", () => {
    const m = materialize([key("a", "1"), signin], { map: { SESSION: "vercel" }, named: ["sec-1"] });
    expect(m.env).toEqual({ A: "1" });
    expect(m.skipped).toEqual(["vercel"]);
  });
});

describe("runWith", () => {
  test("the child sees the env, its exit code comes back, and cleanup runs", async () => {
    const m = materialize([file, key("stripe-test", "sk")]);
    const out = path.join(os.tmpdir(), `vault-run-${process.pid}`);
    const code = await runWith(["sh", "-c", `stat -f %Lp "$GCP_SA_FILE" > ${out} 2>/dev/null || stat -c %a "$GCP_SA_FILE" > ${out}; echo "$STRIPE_TEST" >> ${out}; exit 7`], m.env, m.cleanup);
    expect(code).toBe(7);
    expect(fs.readFileSync(out, "utf-8").split("\n").slice(0, 2)).toEqual(["600", "sk"]);
    expect(fs.existsSync(m.env.GCP_SA_FILE!)).toBe(false);
    fs.rmSync(out);
  });

  test("a child killed by a signal reports 128 + n; a missing command 127", async () => {
    let cleaned = 0;
    expect(await runWith(["sh", "-c", "kill -TERM $$"], {}, () => cleaned++)).toBe(143);
    expect(await runWith(["definitely-not-a-command-xyz"], {}, () => cleaned++)).toBe(127);
    expect(cleaned).toBe(2);
  });

  // The child traps INT (exit 3) and TERM (exit 4); `sleep & wait` lets a trap run at once.
  const trapping = ["sh", "-c", `trap "exit 3" INT; trap "exit 4" TERM; touch "$READY"; sleep 5 & wait`];
  const runTrapping = async (tty: boolean, signals: NodeJS.Signals[]) => {
    const ready = path.join(os.tmpdir(), `vault-sig-${process.pid}-${tty}`);
    fs.rmSync(ready, { force: true });
    const done = runWith(trapping, { READY: ready }, () => {}, tty);
    while (!fs.existsSync(ready)) await Bun.sleep(10);
    for (const sig of signals) {
      process.emit(sig as any, sig);
      await Bun.sleep(100);
    }
    fs.rmSync(ready, { force: true });
    return done;
  };

  test("on a terminal Ctrl-C is left to the terminal, which already sent it to the child; TERM is forwarded", async () => {
    expect(await runTrapping(true, ["SIGINT", "SIGTERM"])).toBe(4);
  });

  test("off a terminal SIGINT is forwarded", async () => {
    expect(await runTrapping(false, ["SIGINT"])).toBe(3);
  });
});

describe("output", () => {
  test("shell quoting survives quotes, spaces and $", () => {
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(exportLines({ A: "x y", B: "o'k" })).toBe(`export A='x y'\nexport B='o'\\''k'`);
  });

  test("fieldValue picks a kind's field and says why one is missing", () => {
    expect(fieldValue(login, "username")).toEqual({ value: "ci" });
    expect(fieldValue(key("k", "v"), "password")).toEqual({ error: "k is a key with no password" });
    expect("error" in fieldValue(signin, "value")).toBe(true);
  });
});

describe("argv", () => {
  test("the old Files verbs are rewritten under cast files", () => {
    const isDir = (p: string) => p === "notes" || p === "/Users/x/notes";
    expect(filesCommandFor(["mirror", "/Users/x/notes", "--on"], isDir)).toBe("cast files mirror /Users/x/notes --on");
    expect(filesCommandFor(["search", "tag:health sleep"], isDir)).toBe("cast files search 'tag:health sleep'");
    expect(filesCommandFor(["read", "Sleep"], isDir)).toBe("cast files cat Sleep");
    expect(filesCommandFor(["add", "/Users/x/notes", "--name", "Wiki"], isDir)).toBe("cast files add /Users/x/notes --name Wiki");
    expect(filesCommandFor(["add", "notes"], isDir)).toBe("cast files add notes");
    expect(filesCommandFor(["rm", "Areas/Sleep.md"], isDir)).toBe("cast files rm Areas/Sleep.md");
    expect(filesCommandFor(["/Users/x/notes"], isDir)).toBe("cast files add /Users/x/notes");
  });

  test("vault verbs on secret names pass through", () => {
    const isDir = () => false;
    for (const args of [["add", "stripe-test"], ["rm", "sec-4"], ["ls"], ["run", "a", "--", "x"], [], ["get", "x"]]) {
      expect(filesCommandFor(args, isDir)).toBeNull();
    }
  });

  test("run splits names from the command at --, after leading flags and the group token", () => {
    expect(argsAfterGroup(["bun", "cast", "vault", "ls"])).toEqual(["ls"]);
    expect(splitRunArgs(["bun", "cast", "secrets", "run", "a", "b", "--", "env", "-x", "--", "y"])).toEqual({ names: ["a", "b"], envFiles: [], command: ["env", "-x", "--", "y"] });
    expect(splitRunArgs(["bun", "cast", "vault", "run", "a"])).toBeNull();
  });

  test("run takes --env-file paths out of the names, in order, both spellings", () => {
    expect(splitRunArgs(["bun", "cast", "vault", "run", "--env-file", ".env", "a", "--env-file=.env.local", "--", "--env-file", "x"])).toEqual({
      names: ["a"], envFiles: [".env", ".env.local"], command: ["--env-file", "x"],
    });
    expect(splitRunArgs(["bun", "cast", "vault", "run", "--env-file", "--", "true"])!.envFiles).toEqual([""]);
  });

  test("run takes --why out of the names, both spellings, and leaves the command's own alone", () => {
    expect(splitRunArgs(["bun", "cast", "vault", "run", "a", "--why", "billing tests", "--", "x", "--why", "y"])).toEqual({
      names: ["a"], envFiles: [], why: "billing tests", command: ["x", "--why", "y"],
    });
    expect(splitRunArgs(["bun", "cast", "vault", "run", "--why=a=b", "a", "--", "x"])!.why).toBe("a=b");
  });
});
