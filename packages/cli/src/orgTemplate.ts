import type { Command } from "commander";
import type { OrgInitDeps } from "./orgInit.js";
import { readStdinBody } from "./sendBody.js";
import { LEARNING_OPT_IN_LABEL, LEARNING_OPT_IN_SENTENCE } from "@codecast/shared/contracts/orgTemplateLearning";

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
    .option("--to <version>", "Move the instance to this published release first; without it, an upgrade accepted on the server (a person's Update, or the publisher's canary rollout) is performed")
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
  context(template.command("lessons <template>").description("Lessons filed on a template, for its publisher; with --instance, the lessons from one instance in this checkout and where each stands"))
    .option("--codecast", "Read as Codecast, the publisher of its templates (its admins only)")
    .option("--instance", "The argument is an instance in this checkout: list the lessons that came from it")
    .option("--status <open|accepted|declined|released>", "Only lessons in this state")
    .action(async (target: string, options: any) => output(await (await import("./orgTemplateRun.js")).listLessons(deps, target, options)));
  template.command("lesson-status <id...>").description("The publisher's verdict on lessons: accepted into a draft, declined, or released in a version")
    .option("--accept", "Folded into the next release").option("--decline", "Not acted on").option("--released-in <version>", "Shipped in this stable version").option("--json", "Machine-readable output")
    .action(async (ids: string[], options: any) => output(await (await import("./orgTemplateRun.js")).setLessonStatus(deps, ids, options)));
  template.command("learning [on|off]").description(`${LEARNING_OPT_IN_LABEL}: show the workspace's choice, or set it (a team admin, from their own terminal; an agent session is refused). ${LEARNING_OPT_IN_SENTENCE}`)
    .option("--team <name|id>", "Team workspace").option("--personal", "Personal workspace").option("--session <id>", "Calling session (default: current)").option("--json", "Machine-readable output")
    .action(async (set: string | undefined, options: any) => {
      if (set !== undefined && set !== "on" && set !== "off") throw new Error("Give on or off, or nothing to read the current choice");
      const state = (await (await import("./orgTemplateRun.js")).templateLearning(deps, set, options)) as any;
      if (options.json) { output(state); return; }
      console.log(`${LEARNING_OPT_IN_LABEL}: ${state.enabled ? "on" : "off"}${state.changed_by ? ` (set by ${state.changed_by}, ${new Date(state.changed_at).toISOString().slice(0, 10)})` : ""}`);
      console.log(LEARNING_OPT_IN_SENTENCE);
    });
  // The learning loop's publisher side (org-hire.md H12): Codecast's admins, on the machine with the template folders.
  const learn = template.command("learn").description("The learning loop, for the publisher of Codecast's templates: read opted-in instances into lessons, see when a draft or a promotion is due, move canary instances");
  learn.command("pass <template>").description("Read each opted-in instance of the template on the server and file generalized lessons; prints what was filed and counts, never a session's words")
    .option("--json", "Machine-readable output")
    .action(async (id: string) => {
      const result = await (await import("./orgTemplateRun.js")).learnPass(deps, id);
      output(result);
      if (result.read > 0 && result.failed === result.read) { console.error("Every model call of the pass failed; nothing was learned. Check ANTHROPIC_API_KEY on the deployment."); process.exitCode = 1; }
    });
  learn.command("status <template>").description("Open lessons, whether a draft is due and its next version, the canary release with its instances and whether it ran clean")
    .option("--json", "Machine-readable output")
    .action(async (id: string) => output(await (await import("./orgTemplateRun.js")).learnStatus(deps, id)));
  learn.command("due").description("Whether the loop has anything to do across Codecast's templates; exits 1 when nothing is due (a trigger's --precheck)")
    .option("--json", "Machine-readable output")
    .action(async () => {
      const result = await (await import("./orgTemplateRun.js")).learnDue(deps);
      output(result);
      if (!result.due) process.exitCode = 1;
    });
  learn.command("rollout <template>").description("Move the instances that follow canary to the canary release: each gets the upgrade and its host step queued on its machine")
    .option("--json", "Machine-readable output")
    .action(async (id: string) => output(await (await import("./orgTemplateRun.js")).learnRollout(deps, id)));
  template.command("publish <folder...>").description("Publish release folders as templates under a workspace, or as Codecast for every workspace; several folders publish in one run (a gallery: packs/*)")
    .option("--team <name|id>", "Publishing team workspace").option("--personal", "Publish under your personal workspace").option("--codecast", "Publish as Codecast (its admins only)")
    .option("--status <draft|canary|stable>", "Release status", "draft").option("--changelog <text>", "What changed in this version; '-' reads stdin; default: the folder's CHANGELOG.md")
    .option("--review-project <id>", "Where this template's lessons are reviewed").option("--json", "Machine-readable output")
    .action(async (folders: string[], options: any) => {
      const { publishTemplate, publishTemplates } = await import("./orgTemplateRun.js");
      const changelog = options.changelog === "-" ? readStdinBody() : options.changelog;
      if (folders.length === 1) { console.log(JSON.stringify(await publishTemplate(deps, folders[0]!, { ...options, changelog }), null, 2)); return; }
      const rows = await publishTemplates(deps, folders, { ...options, changelog });
      console.log(JSON.stringify(rows, null, 2));
      if (rows.some((r) => r.error)) process.exitCode = 1;
    });
  template.command("catalog").description("The templates this workspace may hire: its own and Codecast's")
    .option("--team <name|id>", "Team workspace").option("--personal", "Personal workspace").option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { catalogTemplates } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await catalogTemplates(deps, options), null, 2));
    });
  context(template.command("activate <instance> <routine>").description("Activate a paused routine: human only; from an agent session the server refuses and says so"))
    .option("--session <id>", "Calling session (default: current)")
    .action(async (instance: string, routine: string, options: any) => {
      const { activateTemplateRoutine } = await import("./orgTemplateRun.js");
      console.log(JSON.stringify(await activateTemplateRoutine(deps, instance, routine, options), null, 2));
    });
  context(template.command("upgrade <instance> <folder>").description("Preview a release change; --apply advances this instance only"))
    .option("--apply", "Apply the reviewed release change, preserving role and external trigger state")
    .action(async (instance: string, folder: string, options: any) => output(await (await import("./orgTemplateRun.js")).upgradeTemplate(deps, instance, folder, options)));
  context(template.command("instructions <instance> <routine>").description("Return verified runtime instructions (routine may be charter, or setup:<id> for a setup step's guide filled in for this instance)"))
    .action(async (instance: string, routine: string, options: any) => console.log(await (await import("./orgTemplateRun.js")).templateInstructions(deps, instance, routine, options)));
}
