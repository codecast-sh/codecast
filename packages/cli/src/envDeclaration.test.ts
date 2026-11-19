import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commandPlaceholders, fillCommand, loadEnvDeclarations, parseEnvsText, repoIdentity, resultText } from "./envDeclaration";
import { runEnv } from "./envCommand";

const ok = `
[[env]]
key = "union/unit-smoke"
title = "Pricing unit tests"
level = "L0"
command = "bun run x.ts --candidate {candidate} --split {split} --out {out} \${HOME}"
splits = ["dev", "held"]
cost_usd = 0
predicts = "L5:intros_a_week"
`;

describe("parseEnvsText", () => {
  test("reads a declaration; splits default to dev", () => {
    expect(parseEnvsText(ok)).toEqual([{ key: "union/unit-smoke", title: "Pricing unit tests", level: "L0", command: "bun run x.ts --candidate {candidate} --split {split} --out {out} ${HOME}", splits: ["dev", "held"], cost_usd: 0, predicts: "L5:intros_a_week" }]);
    expect(parseEnvsText(`[[env]]\nkey="a/b"\ntitle="t"\nlevel="L1"\ncommand="true"`)[0].splits).toEqual(["dev"]);
    expect(parseEnvsText("")).toEqual([]);
  });

  test("refuses unknown keys, placeholders, levels, splits and duplicates with where they sit", () => {
    const one = (extra: string, key = "a/b") => `[[env]]\nkey="${key}"\ntitle="t"\nlevel="L1"\ncommand="run {candidate}"\n${extra}`;
    expect(() => parseEnvsText(one(`comand="x"`), "f.toml")).toThrow(/f.toml: \[\[env\]\] #1 has unknown key "comand"/);
    expect(() => parseEnvsText(`product="x"\n${one("")}`)).toThrow(/unknown key "product"/);
    expect(() => parseEnvsText(one("").replace("{candidate}", "{candiate}"))).toThrow(/unknown placeholder \{candiate\}/);
    expect(() => parseEnvsText(one("").replace(`level="L1"`, `level="L7"`))).toThrow(/level must be one of/);
    expect(() => parseEnvsText(one(`splits=["test"]`))).toThrow(/must be one of dev, held, fresh/);
    expect(() => parseEnvsText(one("", "Union Smoke"))).toThrow(/<product>\/<name>/);
    expect(() => parseEnvsText(one("") + "\n" + one(""))).toThrow(/a\/b is declared twice/);
    expect(() => parseEnvsText(one(`predicts="L1:x/y"`))).toThrow(/not above L1/);
    expect(() => parseEnvsText(one(`cost_usd=-2`))).toThrow(/cost_usd/);
    expect(() => parseEnvsText("key = = 1\n")).toThrow(/invalid TOML/);
    // A placeholder inside quotes loses its quoting (review M4).
    expect(() => parseEnvsText(one("").replace(`"run {candidate}"`, `'run --label "{candidate}"'`))).toThrow(/inside quotes/);
    expect(() => parseEnvsText(one("").replace(`"run {candidate}"`, `"run --label '{candidate}'"`))).toThrow(/inside quotes/);
    expect(parseEnvsText(one("").replace(`"run {candidate}"`, `'run "\${HOME}" {candidate}'`))[0].command).toBe(`run "\${HOME}" {candidate}`);
    expect(() => parseEnvsText(one(`timeout_s=0`))).toThrow(/timeout_s/);
  });

  test("a check names its role, the direction that must not worsen and how far it may move", () => {
    const one = (extra: string) => `[[env]]\nkey="u/fit"\ntitle="t"\nlevel="L2"\ncommand="run {candidate}"\n${extra}`;
    expect(parseEnvsText(one(`role="check"\ndirection="lower"\ntolerance=0.02`))[0]).toMatchObject({ role: "check", direction: "lower", tolerance: 0.02 });
    expect(parseEnvsText(one(`role="score"`))[0].role).toBe("score");
    expect(() => parseEnvsText(one(`role="gate"`))).toThrow(/role must be "score" or "check"/);
    expect(() => parseEnvsText(one(`tolerance=0.02`))).toThrow(/tolerance applies to a check/);
    expect(() => parseEnvsText(one(`role="check"\ntolerance=2`))).toThrow(/tolerance must be a number from 0 to 1/);
    expect(() => parseEnvsText(one(`role="check"\ndirection="up"`))).toThrow(/direction must be "higher" or "lower"/);
  });

  test("placeholders are filled shell-quoted; ${VAR} is left to the shell", () => {
    expect(commandPlaceholders("a {candidate} ${HOME} {out}")).toEqual(["candidate", "out"]);
    expect(fillCommand("run --c {candidate} --o {out} ${HOME}", { candidate: "it's mine; rm -rf /", out: "/tmp/x.json" })).toBe(`run --c 'it'\\''s mine; rm -rf /' --o /tmp/x.json \${HOME}`);
  });

  test("a runner's JSON is read from all of stdout, or from the last object after its logs", () => {
    expect(resultText(`{"a":1}`)).toBe(`{"a":1}`);
    expect(resultText(`running...\n{"a":\n 1}\n`)).toBe(`{"a":\n 1}`);
    expect(resultText("no json here")).toBeNull();
    expect(resultText(`{"a":1}\ndone in 3s\n`)).toBe(`{"a":1}`);
  });
});

describe("loading and running in a repo", () => {
  const repo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envs-repo-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/Union.git"]);
    fs.mkdirSync(path.join(dir, ".codecast"));
    return dir;
  };
  const result = (over: string) => `{"env":"acme/smoke","env_version":"v1","rung":"L0","candidate":{"label":"$1"},"split":"$2","cases":[{"id":"a","score":1},{"id":"b","score":0}],"summary":{"n":2,"mean":0.5},"started_at":"2026-11-17T00:00:00Z","finished_at":"2026-11-17T00:00:01Z"${over}}`;
  const declare = (dir: string, script: string) => {
    fs.writeFileSync(path.join(dir, "run.sh"), script);
    fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), `[[env]]\nkey="acme/smoke"\ntitle="Smoke"\nlevel="L0"\ncommand="sh run.sh {candidate} {split} {out}"\nsplits=["dev","held"]\n`);
    return loadEnvDeclarations(dir);
  };

  test("the repo is named by its remote; no file is no envs", () => {
    const dir = repo();
    expect(repoIdentity(dir)).toBe("github.com/acme/union");
    expect(loadEnvDeclarations(dir)).toMatchObject({ file: null, envs: [] });
  });

  test("a runner that writes {out} is read and checked, its sha filled in", async () => {
    const dir = repo();
    const { envs, root } = declare(dir, `echo log line; printf '%s' '${result("")}' | sed "s/\\$1/$1/; s/\\$2/$2/" > "$3"`);
    const run = await runEnv(envs[0], { dir: root!, candidate: "ct-9", split: "dev", sha: "abc1234", quiet: true });
    expect(run.ok && run.result).toMatchObject({ env: "acme/smoke", candidate: { label: "ct-9", sha: "abc1234" }, summary: { n: 2, mean: 0.5 } });
  });

  test("a runner past its timeout_s is stopped with its children, not waited on (review v2 item 1)", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), `[[env]]\nkey="acme/slow"\ntitle="Slow"\nlevel="L0"\ncommand="sh -c 'sleep 8; echo hi' {candidate}"\ntimeout_s=1\n`);
    const { envs, root } = loadEnvDeclarations(dir);
    const started = Date.now();
    const run = await runEnv(envs[0], { dir: root!, candidate: "base", split: "dev", quiet: true });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(!run.ok && run.error).toMatch(/ran past its 1s limit/);
  });

  test("a held run files its case ids hashed, the same hash every run", async () => {
    const dir = repo();
    const { envs, root } = declare(dir, `echo '${result("").replace('"env_version":"v1"', '"env_version":"9f3a2c1d"').replace('"id":"a"', '"id":"Jane.Roe.wants.refund"')}' | sed "s/\\$1/$1/; s/\\$2/$2/"`);
    const one = await runEnv(envs[0], { dir: root!, candidate: "base", split: "held", quiet: true });
    const two = await runEnv(envs[0], { dir: root!, candidate: "base", split: "held", quiet: true });
    expect(one.ok && one.result.cases.map((k) => k.id)).toEqual([expect.stringMatching(/^h:[0-9a-f]{16}$/), expect.stringMatching(/^h:[0-9a-f]{16}$/)]);
    expect(one.ok && two.ok && one.result.cases[0].id === two.result.cases[0].id).toBe(true);
  });

  test("held leakage, malformed JSON and silence are refused before anything is filed", async () => {
    const dir = repo();
    const leak = declare(dir, `echo '${result("").replace('"env_version":"v1"', '"env_version":"9f3a2c1d"').replace('"score":0}', '"score":0,"note":"the pitch text"}')}' | sed "s/\\$1/$1/; s/\\$2/$2/"`);
    const held = await runEnv(leak.envs[0], { dir: leak.root!, candidate: "base", split: "held", quiet: true });
    // The reason would quote the runner, so a held run says only that it broke; dev shows the reason.
    expect(!held.ok && held.error).toMatch(/held result breaks the contract .*withheld/);
    expect(!held.ok && held.error).not.toContain("the pitch text");
    const bad = declare(dir, `echo '{"env": "acme/smoke",'; exit 1`);
    const broken = await runEnv(bad.envs[0], { dir: bad.root!, candidate: "base", split: "dev", quiet: true });
    expect(!broken.ok && broken.error).toMatch(/exited 1 and printed no result/);
    const wrongSplit = declare(dir, `echo '${result("")}' | sed "s/\\$1/$1/; s/\\$2/dev/"`);
    const ws = await runEnv(wrongSplit.envs[0], { dir: wrongSplit.root!, candidate: "base", split: "held", quiet: true });
    expect(!ws.ok && ws.error).toMatch(/held result breaks the contract/);
  });
});
