import { expect, test } from "bun:test";
import { Command } from "commander";
import { parseCloudEnvArgs, registerCloudEnvAction } from "./command";

test("cast cloud's flags parse by hand", () => {
  expect(parseCloudEnvArgs(["--host", "i-1", "--only", "~/a,~/b", "--days", "3", "--all"])).toMatchObject({ host: "i-1", only: "~/a,~/b", days: "3", all: true });
  expect(parseCloudEnvArgs(["--dry-run", "--json"])).toMatchObject({ dryRun: true, json: true });
  expect(() => parseCloudEnvArgs(["--nope"])).toThrow();
  expect(() => parseCloudEnvArgs(["stray"])).toThrow(/unknown command stray/);
});

test("subcommands keep their own --host and --json", async () => {
  const program = new Command();
  program.exitOverride();
  const cloud = program.command("cloud");
  registerCloudEnvAction(cloud);
  let start: unknown, seed: unknown;
  cloud.command("start <id>").option("--host <id>").action((_id, o) => { start = o; });
  cloud.command("seed").option("--json").action((o) => { seed = o; });
  await program.parseAsync(["node", "cast", "cloud", "start", "c1", "--host", "h1"]);
  await program.parseAsync(["node", "cast", "cloud", "seed", "--json"]);
  expect(start).toEqual({ host: "h1" });
  expect(seed).toEqual({ json: true });
});
