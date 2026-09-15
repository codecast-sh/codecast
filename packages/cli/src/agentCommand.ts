// `cast agent` — agent definitions and chains from a shell.
//
// A definition is the named role every launch surface runs as (`--as`); a
// chain is definitions in order with each step's output feeding the next.
// Both are workspace rows (Settings > Agent Library edits the same ones) and
// travel as markdown with frontmatter: `show`/`export` print that form,
// `import` reads it, so a repo's `.codecast/agents/*.md`, Claude Code's
// `~/.claude/agents/*.md` and pi's agent files all load unchanged.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  AGENT_CLIENTS,
  parseExecutionAgentClientId,
  validateAgentChain,
  validateAgentDefinition,
  type AgentChainSpec,
  type AgentClientId,
  type AgentDefinitionSpec,
} from "@codecast/shared/contracts";
import {
  isAgentChainFile,
  parseAgentChainFile,
  parseAgentDefinitionFile,
  serializeAgentChainFile,
  serializeAgentDefinitionFile,
} from "@codecast/shared/agents";
import { apiPost } from "./castApi.js";
import { commandGroup, type GroupDeps } from "./commandGroups.js";
import { readStdinBody, stdinText } from "./sendBody.js";
import { c } from "./colors.js";
import { parseExecTimeout, parseOutputFormat, resolveExecPrompt, runChain } from "./execCommand.js";

const AGENT_NAMES = Object.keys(AGENT_CLIENTS).join(", ");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseClient(raw: unknown): AgentClientId | undefined {
  if (!raw) return undefined;
  try {
    return parseExecutionAgentClientId(String(raw).toLowerCase());
  } catch {
    return fail(`Unknown agent "${raw}". Use: ${AGENT_NAMES}`);
  }
}

const splitList = (raw: unknown): string[] | undefined => {
  if (!raw) return undefined;
  const list = String(raw).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
};

/** Print-mode prompt text: a positional, `-` for stdin, or a piped stdin. */
function promptFrom(parts: string[] | undefined): string {
  return resolveExecPrompt(parts ?? [], { stdinIsTTY: !!process.stdin.isTTY, readStdin: readStdinBody }).prompt;
}

function definitionFromFlags(name: string, options: Record<string, unknown>, prompt: string, base?: AgentDefinitionSpec): AgentDefinitionSpec {
  const def: AgentDefinitionSpec = { ...(base ?? { name, description: "" }), name };
  if (options.description !== undefined) def.description = String(options.description);
  if (options.agent !== undefined) def.agent = parseClient(options.agent);
  if (options.model !== undefined) def.model = String(options.model) || undefined;
  if (options.effort !== undefined) def.effort = String(options.effort) || undefined;
  if (options.tools !== undefined) def.tools = splitList(options.tools);
  if (options.disallowedTools !== undefined) def.disallowed_tools = splitList(options.disallowedTools);
  if (options.safe) def.mode = "propose";
  if (options.apply) def.mode = "apply";
  if (options.isolated) def.isolated = true;
  if (options.noIsolated) def.isolated = false;
  if (options.replacePrompt) def.prompt_mode = "replace";
  if (options.appendPrompt) def.prompt_mode = "append";
  if (prompt) def.system_prompt = prompt;
  return def;
}

function printDefinitionRow(d: any): void {
  const facts = [d.agent ?? "caller", d.model, d.effort].filter(Boolean).join(" · ");
  const badges = [d.mode === "propose" ? "read-only" : "", d.isolated ? "worktree" : ""].filter(Boolean).join(" ");
  console.log(`  ${c.cyan}${d.name}${c.reset}  ${c.dim}${facts}${badges ? `  [${badges}]` : ""}${c.reset}`);
  if (d.description) console.log(`    ${d.description}`);
}

function printChainRow(ch: any): void {
  console.log(`  ${c.cyan}${ch.name}${c.reset}  ${c.dim}${(ch.steps ?? []).map((s: any) => s.agent).join(" → ")}${c.reset}`);
  if (ch.description) console.log(`    ${ch.description}`);
}

async function upsertDefinition(deps: GroupDeps, def: AgentDefinitionSpec, teamId?: string, id?: string): Promise<any> {
  const problems = validateAgentDefinition(def);
  if (problems.length) fail(`Invalid definition: ${problems.join("; ")}`);
  return await apiPost(deps, "/cli/agents/upsert", { ...def, id, team_id: teamId });
}

async function upsertChain(deps: GroupDeps, chain: AgentChainSpec, teamId?: string, id?: string): Promise<any> {
  const problems = validateAgentChain(chain);
  if (problems.length) fail(`Invalid chain: ${problems.join("; ")}`);
  return await apiPost(deps, "/cli/chains/upsert", { ...chain, id, team_id: teamId });
}

const DEFINITION_FLAGS = (cmd: Command) =>
  cmd
    .option("-d, --description <text>", "One line a picker shows")
    .option("--agent <type>", `Client: ${AGENT_NAMES} (unset = the caller's)`)
    .option("--model <model>", "Model for that client (picker key or raw id)")
    .option("--effort <level>", "Effort level for that client")
    .option("--tools <list>", "Tool allowlist, comma separated (claude --allowedTools, pi --tools)")
    .option("--disallowed-tools <list>", "Tool denylist, comma separated (claude --disallowedTools)")
    .option("--safe", "Read only: write tools removed, mutating commands denied, mandate appended")
    .option("--apply", "Can act (the default)")
    .option("--isolated", "Start in its own git worktree")
    .option("--no-isolated", "Do not start in a worktree")
    .option("--replace-prompt", "The prompt replaces the client's system prompt")
    .option("--append-prompt", "The prompt is appended to the client's system prompt (the default)")
    .option("--team <name|id>", "Team workspace to write into (default: personal)");

export function registerAgentCommand(program: Command, deps: GroupDeps): void {
  const agent = program
    .command("agent")
    .alias("agents")
    .description(commandGroup("agent").description);

  agent
    .command("ls")
    .alias("list")
    .description("Definitions and chains in every workspace you hold")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const [defs, chains] = await Promise.all([
        apiPost(deps, "/cli/agents/list", {}, { read: true }),
        apiPost(deps, "/cli/chains/list", {}, { read: true }),
      ]);
      if (options.json) {
        console.log(JSON.stringify({ definitions: defs ?? [], chains: chains ?? [] }, null, 2));
        return;
      }
      console.log(`${c.bold}Definitions${c.reset} (${(defs ?? []).length})`);
      if (!defs?.length) console.log(`  ${c.dim}none — cast agent create <name> … or cast agent import <file>${c.reset}`);
      for (const d of defs ?? []) printDefinitionRow(d);
      console.log(`\n${c.bold}Chains${c.reset} (${(chains ?? []).length})`);
      if (!chains?.length) console.log(`  ${c.dim}none — cast agent chain create <name> --step <agent>:<prompt> …${c.reset}`);
      for (const ch of chains ?? []) printChainRow(ch);
    });

  const show = async (name: string, options: any) => {
    const def = await apiPost(deps, "/cli/agents/get", { name }, { read: true });
    if (def) {
      if (options.json) console.log(JSON.stringify(def, null, 2));
      else process.stdout.write(serializeAgentDefinitionFile(def));
      return;
    }
    const chain = await apiPost(deps, "/cli/chains/get", { name }, { read: true });
    if (chain) {
      if (options.json) console.log(JSON.stringify(chain, null, 2));
      else process.stdout.write(serializeAgentChainFile(chain));
      return;
    }
    fail(`No definition or chain named "${name}". See: cast agent ls`);
  };

  agent
    .command("show")
    .description("A definition or chain in its markdown file form")
    .argument("<name>")
    .option("--json", "The stored row instead")
    .action(show);

  agent
    .command("export")
    .description("Same as show: the markdown file form, for redirecting to a file")
    .argument("<name>")
    .option("--json", "The stored row instead")
    .action(show);

  DEFINITION_FLAGS(
    agent
      .command("create")
      .description("Create a definition; the prompt is a positional, '-' for a heredoc, or piped stdin")
      .argument("<name>", "Lowercase, digits and hyphens: the --as value")
      .argument("[prompt...]", stdinText("System prompt")),
  ).action(async (name: string, parts: string[], options: any) => {
    const teamId = options.team ? await teamIdFor(deps, options.team) : undefined;
    const def = definitionFromFlags(name, options, promptFrom(parts));
    if (!def.description) fail("Give it a description: -d \"…\"");
    const row = await upsertDefinition(deps, def, teamId);
    console.log(`${c.green}ok${c.reset} ${row.short_id} ${c.cyan}${row.name}${c.reset}  →  cast exec --as ${row.name} "…"`);
  });

  DEFINITION_FLAGS(
    agent
      .command("edit")
      .description("Change a definition's fields; only the flags you pass change")
      .argument("<name>")
      .argument("[prompt...]", stdinText("New system prompt")),
  ).action(async (name: string, parts: string[], options: any) => {
    const existing = await apiPost(deps, "/cli/agents/get", { name }, { read: true });
    if (!existing) fail(`No definition named "${name}". See: cast agent ls`);
    const base: AgentDefinitionSpec = {
      name: existing.name,
      description: existing.description,
      agent: existing.agent,
      model: existing.model,
      effort: existing.effort,
      tools: existing.tools,
      disallowed_tools: existing.disallowed_tools,
      system_prompt: existing.system_prompt,
      prompt_mode: existing.prompt_mode,
      mode: existing.mode,
      isolated: existing.isolated,
    };
    const def = definitionFromFlags(name, options, promptFrom(parts), base);
    const row = await upsertDefinition(deps, def, undefined, existing._id);
    console.log(`${c.green}ok${c.reset} updated ${c.cyan}${row.name}${c.reset}`);
  });

  agent
    .command("rm")
    .alias("remove")
    .description("Delete a definition or chain by name")
    .argument("<name>")
    .action(async (name: string) => {
      const def = await apiPost(deps, "/cli/agents/get", { name }, { read: true });
      if (def) {
        await apiPost(deps, "/cli/agents/remove", { id: def._id });
        console.log(`${c.green}ok${c.reset} removed definition ${name}`);
        return;
      }
      const chain = await apiPost(deps, "/cli/chains/get", { name }, { read: true });
      if (chain) {
        await apiPost(deps, "/cli/chains/remove", { id: chain._id });
        console.log(`${c.green}ok${c.reset} removed chain ${name}`);
        return;
      }
      fail(`No definition or chain named "${name}".`);
    });

  agent
    .command("import")
    .description("Import definition or chain files (frontmatter markdown); '-' reads one from stdin")
    .argument("<files...>", "Paths or globs already expanded by the shell")
    .option("--team <name|id>", "Team workspace to write into (default: personal)")
    .action(async (files: string[], options: any) => {
      const teamId = options.team ? await teamIdFor(deps, options.team) : undefined;
      let imported = 0;
      for (const file of files) {
        const content = file === "-" ? readStdinBody() : fs.readFileSync(path.resolve(file.replace(/^~/, os.homedir())), "utf8");
        const stem = file === "-" ? undefined : path.basename(file).replace(/\.md$/i, "");
        if (isAgentChainFile(content)) {
          const chain = parseAgentChainFile(content, stem);
          const row = await upsertChain(deps, chain, teamId);
          console.log(`${c.green}ok${c.reset} chain ${c.cyan}${row.name}${c.reset} (${row.steps.length} steps) from ${file}`);
        } else {
          const def = parseAgentDefinitionFile(content, stem);
          const row = await upsertDefinition(deps, def, teamId);
          console.log(`${c.green}ok${c.reset} definition ${c.cyan}${row.name}${c.reset} from ${file}`);
        }
        imported++;
      }
      console.log(`${c.dim}${imported} imported${c.reset}`);
    });

  // ── Chains ────────────────────────────────────────────────────────────
  const chain = agent.command("chain").description("Chains: definitions in order, each step's output feeding the next");

  chain
    .command("ls")
    .alias("list")
    .description("Chains you can run")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const chains = await apiPost(deps, "/cli/chains/list", {}, { read: true });
      if (options.json) {
        console.log(JSON.stringify(chains ?? [], null, 2));
        return;
      }
      if (!chains?.length) console.log(`${c.dim}no chains — cast agent chain create <name> --step <agent>:<prompt> …${c.reset}`);
      for (const ch of chains ?? []) printChainRow(ch);
    });

  chain
    .command("create")
    .description("Create or replace a chain from --step agent:prompt pairs, or --file")
    .argument("<name>")
    .option("-d, --description <text>", "One line")
    .option("--step <agent:prompt>", "A step: definition name, a colon, then the prompt template ({task}, {previous})", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--file <path>", "A chain file (frontmatter + ## step sections) instead of --step flags; '-' for stdin")
    .option("--team <name|id>", "Team workspace to write into (default: personal)")
    .action(async (name: string, options: any) => {
      const teamId = options.team ? await teamIdFor(deps, options.team) : undefined;
      let spec: AgentChainSpec;
      if (options.file) {
        const content = options.file === "-" ? readStdinBody() : fs.readFileSync(path.resolve(String(options.file).replace(/^~/, os.homedir())), "utf8");
        spec = parseAgentChainFile(content, name);
        spec.name = name;
        if (options.description) spec.description = String(options.description);
      } else {
        const steps = (options.step as string[]).map((raw) => {
          const idx = raw.indexOf(":");
          if (idx <= 0) fail(`--step needs agent:prompt, got "${raw}"`);
          return { agent: raw.slice(0, idx).trim(), prompt: raw.slice(idx + 1).replace(/\\n/g, "\n").trim() };
        });
        spec = { name, description: String(options.description ?? ""), steps };
      }
      if (!spec.description) fail("Give it a description: -d \"…\"");
      const existing = await apiPost(deps, "/cli/chains/get", { name }, { read: true });
      const row = await upsertChain(deps, spec, teamId, existing?._id);
      console.log(`${c.green}ok${c.reset} ${row.short_id} ${c.cyan}${row.name}${c.reset}  →  cast agent run ${row.name} "…"`);
    });

  chain
    .command("rm")
    .description("Delete a chain")
    .argument("<name>")
    .action(async (name: string) => {
      const ch = await apiPost(deps, "/cli/chains/get", { name }, { read: true });
      if (!ch) fail(`No chain named "${name}".`);
      await apiPost(deps, "/cli/chains/remove", { id: ch._id });
      console.log(`${c.green}ok${c.reset} removed chain ${name}`);
    });

  agent
    .command("run")
    .description("Run a chain on a task (same as cast exec --chain <name>); prints the last step's output")
    .argument("<chain>")
    .argument("[task...]", stdinText("The task"))
    .option("-C, --dir <path>", "Working directory (default: current directory)")
    .option("--output-format <fmt>", "text (default) or json (every step's output)")
    .option("--timeout <duration>", "Per step (30s, 2m, 10m)")
    .option("--quiet", "No progress on stderr")
    .option("--dry-run", "Print each step's command and exit")
    .option("--task <id>", "Record the run against this task (ct-N)")
    .option("--plan <id>", "Record the run against this plan (pl-N)")
    .action(async (chainName: string, parts: string[], options: any) => {
      const outputFormat = parseOutputFormat(options.outputFormat);
      if (options.outputFormat && !outputFormat) fail(`Unknown --output-format "${options.outputFormat}". Use: text, json`);
      const timeoutMs = options.timeout ? parseExecTimeout(String(options.timeout)) : undefined;
      if (options.timeout && timeoutMs == null) fail(`Unknown --timeout "${options.timeout}". Use 30s, 2m, 10m, or seconds.`);
      const dir = options.dir ? path.resolve(String(options.dir).replace(/^~/, os.homedir())) : (process.env.CODECAST_CWD || process.cwd());
      const code = await runChain(deps, chainName, promptFrom(parts), {
        flags: { outputFormat },
        dir,
        timeoutMs,
        quiet: !!options.quiet,
        dryRun: !!options.dryRun,
        // the-line.md L7: the chain is a run, bound when asked.
        taskId: options.task ? String(options.task) : undefined,
        planId: options.plan ? String(options.plan) : undefined,
      });
      process.exit(code);
    });
}

/** `--team <name|id>` to a team id through the roster the server already serves. */
async function teamIdFor(deps: GroupDeps, ref: string): Promise<string> {
  const teams = await apiPost(deps, "/cli/teams", {}, { read: true });
  const list: any[] = Array.isArray(teams) ? teams : teams?.teams ?? [];
  const needle = ref.toLowerCase();
  const hit = list.find((t) => t._id === ref || String(t.name ?? "").toLowerCase() === needle || String(t.slug ?? "").toLowerCase() === needle);
  if (!hit) fail(`No team matches "${ref}". Teams: ${list.map((t) => t.name).join(", ") || "none"}`);
  return hit._id;
}
