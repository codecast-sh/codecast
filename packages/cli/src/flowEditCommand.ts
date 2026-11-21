// `cast flow edit <flow> <op> ...` (docs/architecture/pipeline.md PL5): the command that makes one typed edit to a
// project's flow. flowEdit.ts plans and writes the edit; this file reads the arguments and prints the result.
import type { Command } from "commander";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import type { FlowDeps } from "./flowCommand.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** `cast flow edit --help`: each edit as the line it writes. */
const FLOW_EDIT_HELP = `
Each edit writes one line in the project's .codecast/flows/<flow>.cast (created over the library
flow when the repo has none) and a prompt's text beside it in .codecast/flows/<flow>/<station>.md.
It validates the flow, prints the diff, and commits nothing.

  cast flow edit change add lint --after check --run "bun run lint"      lint [after="check", ...]
  cast flow edit change add e2e --after check --run "bun e2e" --when "landing/**"
  cast flow edit change guide review "Also check the migrations"          review [guide="@change/review.guide.md"]
  cast flow edit change prompt review @review.md                          replaces the inherited prompt
  cast flow edit change run lint "bun run lint --changed"
  cast flow edit change when e2e "landing/**, backend/src/routes/**"      or: when e2e always
  cast flow edit change skip decide                                       decide [skip=true]
  cast flow edit change undo review                                       back to the library's

A new station fails the way the station before it fails back (a check after Check goes to Fix check);
--fix <station> sends it elsewhere.
`;

/** Registers `edit` on the `cast flow` group. */
export function registerFlowEditCommand(flow: Command, deps: FlowDeps): void {
  flow
    .command("edit <flow> <op> [args...]")
    .description("Change how this project's flow differs from the library's, one typed edit at a time: add, guide, prompt, run, skip, when, undo")
    .option("--after <station>", "add: put the new station after this one on the passing path")
    .option("--before <station>", "add: put the new station before this one")
    .option("--run <command>", "add: the station runs this command")
    .option("--agent <prompt>", "add: the station is an agent with this prompt (text, @file or -)")
    .option("--person <question>", "add: the station asks a person this")
    .option("--when <globs>", "add: run it only when the change touches these paths (\"landing/**, src/api/**\")")
    .option("--label <name>", "add: the station's name (default: from its id)")
    .option("--fix <station>", "add: where its failure goes (default: the way back the station before it uses)")
    .option("--dry-run", "Print what would change, write nothing")
    .option("--json", "Print the edit as JSON")
    .addHelpText("after", FLOW_EDIT_HELP)
    .action(async (name: string, op: string, args: string[], opts: { after?: string; before?: string; run?: string; agent?: string; person?: string; when?: string; label?: string; fix?: string; dryRun?: boolean; json?: boolean }) => {
      const { planFlowEdit, applyFlowEdit, argText, FlowEditError } = await import("./flowEdit.js");
      const { readStdin } = await import("./workflow/sessionFlow.js");
      const cwd = deps.realCwd();
      const root = (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim();
      const fail = (msg: string): never => { console.error(`✗ ${msg}`); process.exit(1); };
      if (!root) fail("cast flow edit writes the project's flow in its repository: run it inside the checkout");
      const slug = name.replace(/\.cast$/, "");
      const [station, ...rest] = args;
      const usage: Record<string, string> = {
        add: `cast flow edit ${slug} add <id> --after <station> --run "<command>"`,
        guide: `cast flow edit ${slug} guide <station> "<text>"   (or @file, or - for stdin)`,
        prompt: `cast flow edit ${slug} prompt <station> "<text>"   (or @file, or -)`,
        run: `cast flow edit ${slug} run <station> "<command>"`,
        skip: `cast flow edit ${slug} skip <station>`,
        when: `cast flow edit ${slug} when <station> "<globs>"   (or always)`,
        undo: `cast flow edit ${slug} undo <station>`,
      };
      if (!usage[op]) fail(`"${op}" is not an edit; the edits are ${Object.keys(usage).join(", ")}: ${usage.add}`);
      const wantsText = ["guide", "prompt", "run", "when"].includes(op);
      if (!station || (wantsText && rest.length === 0) || (!wantsText && rest.length > 0)) fail(`usage: ${usage[op]}`);
      const text = rest.join(" ");
      try {
        const req =
          op === "add" ? { op, station, after: opts.after, before: opts.before, run: opts.run, agent: opts.agent !== undefined ? argText(opts.agent, cwd, readStdin) : undefined, person: opts.person, when: opts.when, label: opts.label, fix: opts.fix } as const
          : op === "guide" || op === "prompt" ? { op, station, text: argText(text, cwd, readStdin) } as const
          : op === "run" ? { op, station, cmd: text } as const
          : op === "when" ? { op, station, paths: text } as const
          : { op: op as "skip" | "undo", station };
        const plan = planFlowEdit(root, slug, req);
        // The repository names the pipeline the card draws the edit against; a checkout with no GitHub origin has none.
        const repository = (await import("./prCommand.js")).readLocalGitContext(root).repository?.toLowerCase();
        if (repository) plan.edit.repository = repository;
        if (!opts.dryRun) applyFlowEdit(plan);
        if (opts.json) { console.log(JSON.stringify({ ...plan.edit, changed: plan.changed, dry_run: !!opts.dryRun, path: plan.path, diff: plan.diff }, null, 2)); return; }
        if (!plan.changed) { console.log(op === "undo" ? `${plan.edit.file} makes no edit to ${station}; nothing to undo` : `${plan.edit.file} already says this; nothing to change`); return; }
        for (const w of plan.words) console.log(w);
        console.log(dim(`${opts.dryRun ? "would write" : plan.created ? "created" : plan.removed ? "removed (the library's flow runs again)" : "wrote"} ${plan.writes.map((w) => path.relative(root, w.file)).join(", ")} · ${plan.path}`));
        console.log(`\n${plan.diff.trimEnd()}\n`);
        console.log("```flow");
        console.log(JSON.stringify({ edit: plan.edit }));
        console.log("```");
        if (!opts.dryRun) console.log(dim("Not committed: the edit ships through the pipeline like any change."));
      } catch (err) {
        if (err instanceof FlowEditError) fail(err.message);
        throw err;
      }
    });
}
