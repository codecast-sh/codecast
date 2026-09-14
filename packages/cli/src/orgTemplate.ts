import type { Command } from "commander";
import type { OrgInitDeps } from "./orgInit.js";

export function registerOrgTemplateCommands(program: Command, deps: OrgInitDeps): void {
  const org = program.commands.find((c) => c.name() === "org");
  if (!org) throw new Error("Register the org group before template commands");
  const template = org.command("template").description("Inspect and install pinned folder templates through human org proposals");
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const context = (command: Command) => command.option("--dir <path>", "Existing project checkout", process.cwd()).option("--team <name|id>", "Explicit team workspace (mutually exclusive with --personal)").option("--personal", "Explicit personal workspace").option("--json", "Machine-readable output");
  template.command("inspect <folder>").description("Validate a release folder without installing it").option("--json", "Machine-readable output").action(async (folder: string) => {
    const { readArtifact } = await import("./orgTemplateArtifact.js");
    const artifact = readArtifact(folder);
    output({ ...artifact.manifest, root: artifact.root, hash: artifact.hash, files: [...artifact.files.keys()] });
  });
  context(template.command("install <folder>").description("Post one role proposal and stop for the human answer"))
    .option("--dry-run", "Verify release, exact project/workspace and proposed bindings without writing")
    .requiredOption("--instance <slug>", "Unique instance name in this checkout")
    .requiredOption("--project <id>", "Exact existing project id")
    .option("--session <id>", "Proposing session UUID (default: current session)")
    .option("--adopt <routine=tr-N>", "Record an existing external trigger without changing it", (value: string, all: string[]) => [...all, value], [])
    .action(async (folder: string, options: any) => {
      const { installTemplate, quoteTemplateArg } = await import("./orgTemplateRun.js");
      const receipt = await installTemplate(deps, folder, options.instance, options);
      const workspace = receipt.workspace.kind === "team" ? `--team ${quoteTemplateArg(receipt.workspace.id)}` : "--personal";
      if (options.dryRun) { output({ dryRun: true, receipt, next: "Review this proposal, then rerun without --dry-run to post its human decision" }); return; }
      output({ ...receipt, next: `Answer ${receipt.stack.decisionId}, then run cast org template reconcile ${quoteTemplateArg(receipt.instance)} --dir ${quoteTemplateArg(receipt.project.dir)} ${workspace}` });
    });
  context(template.command("status <instance>").description("Verify the pinned artifact and report live bindings without changes"))
    .action(async (instance: string, options: any) => output(await (await import("./orgTemplateRun.js")).templateStatus(deps, instance, options)));
  context(template.command("reconcile <instance>").description("Apply a human answer, verify the standing session, create routines gated and paused"))
    .option("--adopt <routine=tr-N>", "Record an existing external trigger without changing it", (value: string, all: string[]) => [...all, value], [])
    .action(async (instance: string, options: any) => {
      const runtime = await import("./orgTemplateRun.js");
      await runtime.reconcileTemplate(deps, instance, options);
      output(await runtime.templateStatus(deps, instance, options));
    });
  context(template.command("upgrade <instance> <folder>").description("Preview a release change; --apply advances this instance only"))
    .option("--apply", "Apply the reviewed release change, preserving role and external trigger state")
    .action(async (instance: string, folder: string, options: any) => output(await (await import("./orgTemplateRun.js")).upgradeTemplate(deps, instance, folder, options)));
  context(template.command("instructions <instance> <routine>").description("Return verified runtime instructions (routine may be charter)"))
    .action(async (instance: string, routine: string, options: any) => console.log(await (await import("./orgTemplateRun.js")).templateInstructions(deps, instance, routine, options)));
}
