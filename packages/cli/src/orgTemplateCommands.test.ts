// `cast org template`'s command tree, and the quoting its loader and follow-ups use.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerOrgTemplateCommands } from "./orgTemplate";
import { quoteTemplateArg } from "./orgTemplateRun";
import type { OrgInitDeps } from "./orgInit";

test("registers lazy org template commands and UI install flags", () => {
  const program = new Command(); program.command("org"); registerOrgTemplateCommands(program, {} as OrgInitDeps);
  const template = program.commands[0].commands[0]; expect(template.name()).toBe("template");
  expect(template.commands.map((c) => c.name())).toEqual(["inspect", "install", "status", "reconcile", "bind", "evidence", "report", "setup", "lesson", "lessons", "lesson-status", "learning", "learn", "publish", "yank", "retire", "catalog", "activate", "cutover", "upgrade", "tools", "run", "edit", "diff", "release", "instructions"]);
  expect(template.commands.find((c) => c.name() === "learn")!.commands.map((c) => c.name())).toEqual(["pass", "status", "due", "rollout", "promote"]);
  expect(template.commands.find((c) => c.name() === "install")!.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--instance", "--project", "--dir", "--team", "--personal", "--adopt"]));
});

test("loader and follow-up shell arguments remain literal", () => {
  const value = "/tmp/it's $(printf INJECTED) `printf INJECTED`";
  const result = spawnSync("bash", ["-c", `printf '%s' ${quoteTemplateArg(value)}`], { encoding: "utf8" });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }).toEqual({ status: 0, stdout: value, stderr: "", error: undefined });
});
