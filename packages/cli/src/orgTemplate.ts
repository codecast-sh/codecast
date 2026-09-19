import type { Command } from "commander";
import type { OrgInitDeps } from "./orgInit.js";
import { readStdinBody } from "./sendBody.js";

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
    .option("--reports-to <me|@handle>", "Who the role reports to (default me). Required as the project's lead when the project already has one")
    .option("--input <key=value>", "Answer one of the template's inputs (repeatable); secrets are bound on the host, never answered here", (value: string, all: string[]) => [...all, value], [])
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
  context(template.command("bind <instance>").description("Host step after approval: write the instance file from the answers, bind secret inputs to files on this machine, find or create the ledger tasks"))
    .option("--secret <key=path>", "Bind a secret input to a file on this host (repeatable); the path is recorded by hash, its contents never leave the machine", (value: string, all: string[]) => [...all, value], [])
    .action(async (instance: string, options: any) => {
      const { bindTemplate } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await bindTemplate(deps, instance, options), null, 2));
    });
  context(template.command("evidence <instance> <check>").description("Record one observed check for this instance; the latest record per check decides readiness"))
    .requiredOption("--status <pass|fail>", "What was observed")
    .requiredOption("--source <href>", "A link or codecast short id a person can open")
    .option("--detail <key=value>", "A fact of the observation (repeatable)", (value: string, all: string[]) => [...all, value], [])
    .action(async (instance: string, check: string, options: any) => {
      const { evidenceTemplate } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await evidenceTemplate(deps, instance, check, options), null, 2));
    });
  context(template.command("report <instance> <key=value...>").description("Write scoreboard values the template declares, each with its source"))
    .requiredOption("--source <href>", "A link or codecast short id a person can open")
    .option("--observed-at <iso>", "When the values were observed (default: now)")
    .action(async (instance: string, entries: string[], options: any) => {
      const { reportTemplate } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await reportTemplate(deps, instance, entries, options), null, 2));
    });
  context(template.command("setup <instance> [id]").description("List the setup items, or mark one; a person's step is refused from an agent session"))
    .option("--done", "Mark the item done").option("--skip", "Mark the item skipped").option("--open", "Reopen the item")
    .option("--evidence <href>", "What shows it is done (required for the role's own items)")
    .action(async (instance: string, id: string | undefined, options: any) => {
      const { setupTemplate } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await setupTemplate(deps, instance, id, options), null, 2));
    });
  context(template.command("lesson <instance> <body>").description("Send a lesson to the template's publisher: a row on the template they review and may release; '-' reads the body from stdin"))
    .option("--evidence <label=link>", "A link or short id a person can open (repeatable)", (value: string, all: string[]) => [...all, value], [])
    .action(async (instance: string, body: string, options: any) => {
      const { lessonTemplate } = await import("./orgTemplateRun.js");
      const text = body === "-" ? readStdinBody() : body;
      console.log(JSON.stringify(await lessonTemplate(deps, instance, text, options), null, 2));
    });
  template.command("publish <folder>").description("Publish a release folder as a template under a workspace, or as Codecast for every workspace")
    .option("--team <name|id>", "Publishing team workspace").option("--personal", "Publish under your personal workspace").option("--codecast", "Publish as Codecast (its admins only)")
    .option("--status <draft|canary|stable>", "Release status", "draft").option("--changelog <text>", "What changed in this version; '-' reads stdin")
    .option("--review-project <id>", "Where this template's lessons are reviewed").option("--json", "Machine-readable output")
    .action(async (folder: string, options: any) => {
      const { publishTemplate } = await import("./orgTemplateRun.js");
      const changelog = options.changelog === "-" ? readStdinBody() : options.changelog;
      console.log(JSON.stringify(await publishTemplate(deps, folder, { ...options, changelog }), null, 2));
    });
  template.command("catalog").description("The templates this workspace may hire: its own and Codecast's")
    .option("--team <name|id>", "Team workspace").option("--personal", "Personal workspace").option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { catalogTemplates } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await catalogTemplates(deps, options), null, 2));
    });
  context(template.command("upgrade <instance> <folder>").description("Preview a release change; --apply advances this instance only"))
    .option("--apply", "Apply the reviewed release change, preserving role and external trigger state")
    .action(async (instance: string, folder: string, options: any) => output(await (await import("./orgTemplateRun.js")).upgradeTemplate(deps, instance, folder, options)));
  context(template.command("instructions <instance> <routine>").description("Return verified runtime instructions (routine may be charter)"))
    .action(async (instance: string, routine: string, options: any) => console.log(await (await import("./orgTemplateRun.js")).templateInstructions(deps, instance, routine, options)));
}
