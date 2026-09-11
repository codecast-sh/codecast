// `cast stack` — decision stacks (docs/architecture/decisions-as-documents.md
// D5): an ordered set of decisions one person clears in one sitting, with a
// policy. An agent creates one for a checklist of related asks, appends with
// `cast decide --stack ds-N`, and sets a policy: `auto-default:<dur>` answers
// advisory members with their default when the deadline passes (blocking
// members never auto answer); `--delegate @handle` lets that role answer
// every open category for the stack's members.
//
//   cast stack create "<title>" [--policy auto-default:24h] [--delegate @handle]
//   cast stack ls [--all]
//   cast stack show ds-N
//   cast stack add ds-N sd-N
//   cast stack policy ds-N [--auto-default 24h | --no-auto-default] [--delegate @handle]
//   cast stack delegate ds-N @handle
//
// Routes: /cli/stack/<verb> in http.ts (decisionStacks.ts).
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { cliFetch } from "./cliHttp.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { formatAge, formatDecisionList, type DecisionRow } from "./decideCommand.js";

export interface StackRow {
  _id: string;
  short_id: string;
  title: string;
  status: "open" | "done";
  policy: { auto_default_after_ms?: number; delegate_role_id?: string };
  decision_ids: string[];
  total: number;
  resolved: number;
  pending: number;
  next_short_id?: string;
  created_at: number;
  updated_at: number;
}

// "24h", "90m", "2d", "30s" → milliseconds. The one duration grammar the
// stack policy accepts on the command line.
export function parseDuration(raw: string): number {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!m) throw new Error(`"${raw}" is not a duration (use 30m, 24h, 2d)`);
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const out = Math.round(n * ms);
  if (out <= 0) throw new Error("A policy duration must be positive");
  return out;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

// `--policy auto-default:24h` on create, and any future `name:value` pair.
export function parsePolicyArg(raw: string): { auto_default_after_ms?: number } {
  const idx = raw.indexOf(":");
  const name = (idx === -1 ? raw : raw.slice(0, idx)).trim();
  const value = idx === -1 ? "" : raw.slice(idx + 1).trim();
  if (name === "auto-default") {
    if (!value) throw new Error("--policy auto-default needs a duration: auto-default:24h");
    return { auto_default_after_ms: parseDuration(value) };
  }
  throw new Error(`Unknown policy "${name}". Policies: auto-default:<duration>`);
}

export function describePolicy(policy: StackRow["policy"], delegateName?: string): string {
  const parts: string[] = [];
  if (policy.auto_default_after_ms) parts.push(`auto default after ${formatDuration(policy.auto_default_after_ms)}`);
  if (policy.delegate_role_id) parts.push(`delegated to ${delegateName ?? policy.delegate_role_id}`);
  return parts.length ? parts.join(", ") : "no policy";
}

export function formatStackList(rows: StackRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No decision stacks. Create one: cast stack create \"<title>\" [--policy auto-default:24h].";
  return rows
    .map((s) => {
      const mark = s.status === "open" ? "●" : "○";
      const progress = `${s.resolved}/${s.total}`;
      const next = s.next_short_id ? `  next ${s.next_short_id}` : "";
      return `${mark} ${s.short_id}  ${s.title}  ${progress} resolved${next}  (${describePolicy(s.policy)}; ${formatAge(now - s.created_at)})`;
    })
    .join("\n");
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

async function stackApi(deps: PublishDeps, verb: string, body: Record<string, unknown>): Promise<any> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const response = await cliFetch(`${siteUrl}/cli/stack/${verb}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    fail(`API error (${response.status}): ${text.slice(0, 200)}`);
  }
  if (result?.error) fail(String(result.error));
  return result;
}

function looksLikeStackId(value: string | undefined): boolean {
  return !!value && (/^ds-\d+$/.test(value) || /^[a-z0-9]{20,}$/i.test(value));
}

export function registerStackCommand(program: Command, deps: PublishDeps): void {
  program
    .command("stack")
    .description(commandGroup("stack").description)
    .argument("[sub]", "create | ls | show | add | policy | delegate")
    .argument("[args...]", "subcommand arguments")
    .option("--policy <spec>", "create: auto-default:<duration> (advisory members answer with their default after it)")
    .option("--delegate <handle>", "create/policy: the role (@handle or or-N) that answers every open category for the stack's members")
    .option("--auto-default <duration>", "policy: set the auto default deadline (30m, 24h, 2d)")
    .option("--no-auto-default", "policy: clear the auto default deadline")
    .option("--all", "ls: include done stacks")
    .option("--session <id>", "Session whose team scopes the stack (default: detect current)")
    .option("--json", "Machine-readable output")
    .action(async (sub: string | undefined, rest: string[], options: any) => {
      const usage = 'Usage: cast stack create "<title>" | ls | show ds-N | add ds-N sd-N | policy ds-N … | delegate ds-N @handle';
      if (!sub) fail(usage);

      if (sub === "create") {
        const title = rest.join(" ").trim();
        if (!title) fail('Usage: cast stack create "<title>" [--policy auto-default:24h] [--delegate @handle]');
        let policy: { auto_default_after_ms?: number } | undefined;
        if (options.policy) {
          try {
            policy = parsePolicyArg(options.policy);
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          }
        }
        const sessionId = options.session || deps.detectCurrentSessionId() || undefined;
        const result = await stackApi(deps, "create", { title, session_id: sessionId, policy, delegate: options.delegate });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${fmt.success("Stack created:")} ${result.short_id}  ${title}`);
          if (policy?.auto_default_after_ms) console.log(fmt.muted(`  advisory members answer with their default after ${formatDuration(policy.auto_default_after_ms)}`));
          if (result.delegated) console.log(fmt.muted(`  delegated to ${result.delegated.role?.name ?? options.delegate} (${result.delegated.grants_created} grants)`));
          console.log(fmt.muted(`  append with: cast decide "<question>" -o … --stack ${result.short_id}`));
        }
        return;
      }

      if (sub === "ls" || sub === "list") {
        const result = await stackApi(deps, "ls", { include_done: !!options.all });
        const rows: StackRow[] = result.stacks ?? [];
        if (options.json) console.log(JSON.stringify(rows, null, 2));
        else console.log(formatStackList(rows));
        return;
      }

      const target = rest[0];
      if (!looksLikeStackId(target)) fail(usage);

      if (sub === "show") {
        const result = await stackApi(deps, "show", { stack: target });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const s: StackRow = result.stack;
        console.log(formatStackList([s]));
        if (result.delegate_role) console.log(fmt.muted(`  delegate: ${result.delegate_role.name} (@${result.delegate_role.handle})`));
        const members: DecisionRow[] = (result.decisions ?? []).map((d: any) => ({ ...d, id: d._id }));
        if (members.length) console.log("\n" + formatDecisionList(members));
        return;
      }

      if (sub === "add") {
        const decision = rest[1];
        if (!decision) fail("Usage: cast stack add ds-N sd-N");
        const result = await stackApi(deps, "add", { stack: target, decision });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`${fmt.success("Added:")} ${result.decision?.short_id ?? decision} → ${result.stack?.short_id ?? target}`);
        return;
      }

      if (sub === "policy" || sub === "delegate") {
        const body: Record<string, unknown> = { stack: target };
        if (sub === "delegate") {
          if (!rest[1]) fail("Usage: cast stack delegate ds-N @handle");
          body.delegate = rest[1];
        } else {
          if (options.delegate) body.delegate = options.delegate;
          if (options.autoDefault === false) body.clear_auto_default = true;
          else if (typeof options.autoDefault === "string") {
            try {
              body.auto_default_after_ms = parseDuration(options.autoDefault);
            } catch (err) {
              fail(err instanceof Error ? err.message : String(err));
            }
          }
          if (Object.keys(body).length === 1) fail("Nothing to change. Pass --auto-default <duration>, --no-auto-default, or --delegate @handle.");
        }
        const result = await stackApi(deps, "policy", body);
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${fmt.success("Policy updated:")} ${result.short_id ?? target}  ${describePolicy(result.policy ?? {}, result.delegated?.role?.name)}`);
          if (result.delegated) console.log(fmt.muted(`  ${result.delegated.grants_created} grants created for ${result.delegated.role?.name}; pending members now held by that role`));
        }
        return;
      }

      fail(usage);
    });
}
