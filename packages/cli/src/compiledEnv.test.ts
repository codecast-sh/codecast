/**
 * A compiled cast reads no .env from the directory it starts in
 * (build-with-native.ts COMPILED_ENV_ARGS). bun's default for a standalone
 * binary loads one, and every process cast starts inherits it: a runner
 * started beside Union's backend .env handed its dead GITHUB_TOKEN to every
 * station, and gh's credential helper preferred that token to the host's own
 * login, so git was refused (Union ct-102909).
 *
 * The first test holds every compile of the CLI to the flags. The second
 * compiles a binary in miniature, as workerEntries.test.ts does, because
 * whether the flag stops the load is a fact about bun.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMPILED_ENV_ARGS } from "../scripts/build-with-native.js";

const REPO = path.resolve(import.meta.dir, "../../..");

let stage = "";

beforeEach(() => {
  stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-env-"));
});

afterEach(() => {
  fs.rmSync(stage, { recursive: true, force: true });
});

/** The `bun build ... --compile` commands in a file, each with its continuation lines joined, comments left out. */
function compileCommands(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^(#|\/\/|\*)/.test(line) && /\bbun\b/.test(line) && /\bbuild\b/.test(line) && line.includes("--compile"));
}

test("every compile of the CLI loads no .env: through the build wrapper, or naming the flags itself", () => {
  const wrapper = fs.readFileSync(path.join(import.meta.dir, "../scripts/build-with-native.ts"), "utf8");
  expect(wrapper).toContain('...(args.includes("--compile") ? COMPILED_ENV_ARGS : [])');
  const files = [
    ...fs.readdirSync(path.join(REPO, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`),
    ...fs.readdirSync(path.join(REPO, "packages/cli/scripts")).filter((f) => f.endsWith(".sh")).map((f) => `packages/cli/scripts/${f}`),
    "packages/cli/package.json",
  ];
  const seen: string[] = [];
  const bare: string[] = [];
  for (const file of files) {
    for (const command of compileCommands(fs.readFileSync(path.join(REPO, file), "utf8"))) {
      seen.push(file);
      if (!command.includes("build-with-native") && !COMPILED_ENV_ARGS.every((flag) => command.includes(flag))) bare.push(`${file}: ${command}`);
    }
  }
  expect(seen).toContain(".github/workflows/finalize-cli-release.yml");
  expect(seen).toContain("packages/cli/package.json");
  expect(bare).toEqual([]);
});

test("a binary compiled with the flags reads no .env where it starts, and one built without them does", () => {
  const entry = path.join(stage, "probe.ts");
  fs.writeFileSync(entry, 'console.log(process.env.CAST_ENV_PROBE ?? "unset");\n');
  const build = (name: string, flags: string[]) =>
    spawnSync(process.execPath, ["build", entry, "--compile", ...flags, "--outfile", path.join(stage, name)], { encoding: "utf8", timeout: 300_000 });
  expect(build("flagged", COMPILED_ENV_ARGS).status).toBe(0);
  expect(build("plain", []).status).toBe(0);
  const project = path.join(stage, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, ".env"), "CAST_ENV_PROBE=from-the-project\n");
  const env = { ...process.env };
  delete env.CAST_ENV_PROBE;
  const run = (name: string) => spawnSync(path.join(stage, name), [], { cwd: project, encoding: "utf8", env, timeout: 60_000 }).stdout.trim();
  expect(run("flagged")).toBe("unset");
  expect(run("plain")).toBe("from-the-project");
}, 600_000);
