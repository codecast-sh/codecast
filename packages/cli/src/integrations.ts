// `cast integrations` — connect the services a workspace acts through, and run
// the issue sync that turns Linear and GitHub issues into codecast tasks.
//
// Two layers live under one command because a person thinks of them as one
// thing. `ls`, `connect` and `disconnect` are the CONNECTION: the OAuth or app
// install that gives the workspace a token. `sources`, `candidates`, `import`,
// `sync`, `pause`, `resume`, `remove` and `set` are the SYNC: which Linear
// project, Linear team or GitHub repo flows into which codecast project, and
// what a delegation to an agent looks like there
// (docs/architecture/issue-sync.md S1.3, S9, S10).
//
// Same deps pattern as publish.ts / stateCommand.ts: index.ts hands in endpoint
// access and its project resolver, this module stays importable by tests.

import type { Command } from "commander";
import open from "open";
import { apiPost, type PublishDeps } from "./publish.js";
import { formatRelativeTime } from "./formatter.js";
import { c, fmt } from "./colors.js";
import { APP_DESCRIPTORS, type AppId, type AppConnectionStatus } from "@codecast/shared/contracts";

export interface IntegrationsDeps extends PublishDeps {
  /** index.ts owns project lookup by id, short id or title substring. */
  resolveProjectId: (ref: string) => Promise<string>;
}

/** The two providers that carry issues. Slack, Gmail and Notion connect but sync nothing. */
const ISSUE_PROVIDERS = ["linear", "github"] as const;
type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

const SOURCE_KINDS = ["linear_project", "linear_team", "github_repo"] as const;

const SOURCE_STATUS_COLORS: Record<string, string> = {
  active: c.green,
  paused: c.dim,
  error: c.red,
};

function appName(id: string): string {
  return APP_DESCRIPTORS[id as AppId]?.name ?? id;
}

function ago(ts: number | undefined | null): string {
  return ts ? formatRelativeTime(new Date(ts).toISOString()) : "never";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A provider name typed at the terminal, checked against a known set. */
function requireProvider<T extends string>(raw: string, allowed: readonly T[]): T {
  const value = raw.trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`Unknown provider "${raw}" — expected one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/** `--auto-spawn on|off` → boolean. Anything else is a typo worth stopping for. */
function parseToggle(flag: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "on" || value === "true" || value === "yes") return true;
  if (value === "off" || value === "false" || value === "no") return false;
  return fail(`Invalid ${flag} "${raw}" — pass on or off`);
}

function printSource(s: any): void {
  const color = SOURCE_STATUS_COLORS[s.status] ?? "";
  const project = s.project_title || s.project_short_id || s.project_id || "";
  console.log(
    `  ${c.cyan}${s._id}${c.reset}  ${color}${String(s.status).padEnd(7)}${c.reset}  ` +
    `${s.name}  ${c.dim}${s.kind}${c.reset}${project ? `  ${c.dim}→ ${project}${c.reset}` : ""}`,
  );
  const delegation = [
    s.delegate_label ? `label ${s.delegate_label}` : null,
    s.delegate_assignee ? `assignee ${s.delegate_assignee}` : null,
    s.auto_spawn ? "auto-spawn" : null,
    s.push_new_tasks ? "push new tasks" : null,
  ].filter(Boolean).join(" · ");
  console.log(`    ${c.dim}synced ${ago(s.last_synced_at)}${delegation ? `  ·  ${delegation}` : ""}${c.reset}`);
  if (s.last_error) console.log(`    ${c.red}error: ${s.last_error}${c.reset}`);
}

export function registerIntegrationsCommand(program: Command, deps: IntegrationsDeps): void {
  const post = (urlPath: string, body: Record<string, unknown> = {}) => apiPost(deps, urlPath, body);

  const integrations = program
    .command("integrations")
    .alias("integration")
    .description("Connect Slack, GitHub, Linear, Gmail and Notion; sync issues into tasks")
    .showHelpAfterError(true);

  integrations
    .command("ls")
    .alias("list")
    .description("Connection status for every app this workspace can use")
    .option("--json", "Output as JSON")
    .action(async (options: any) => {
      const result = await post("/cli/integrations/list");
      const apps: AppConnectionStatus[] = result?.apps ?? [];
      if (options.json) {
        console.log(JSON.stringify(apps, null, 2));
        return;
      }
      if (apps.length === 0) {
        console.log(fmt.muted("No apps reported."));
        return;
      }
      console.log();
      for (const app of apps) {
        const name = appName(app.id).padEnd(8);
        if (app.status === "connected") {
          const who = app.by ? `by ${app.by}` : "by someone no longer in the workspace";
          const detail = app.detail ? `  ${c.dim}${app.detail}${c.reset}` : "";
          console.log(
            `  ${c.green}connected${c.reset}      ${c.bold}${name}${c.reset}  ${c.dim}${app.scope}${c.reset}  ` +
            `${c.dim}${who} ${ago(app.at)}${c.reset}${detail}`,
          );
        } else if (app.status === "not_connected") {
          console.log(`  ${c.dim}not connected${c.reset}  ${c.bold}${name}${c.reset}  ${c.dim}${APP_DESCRIPTORS[app.id]?.tagline ?? ""}${c.reset}`);
        } else {
          console.log(`  ${c.dim}coming soon${c.reset}    ${c.bold}${name}${c.reset}  ${c.dim}no connector yet${c.reset}`);
        }
      }
      console.log();
    });

  integrations
    .command("connect")
    .description("Start the connect flow for an app (opens your browser)")
    .argument("<provider>", `App to connect: ${Object.keys(APP_DESCRIPTORS).join(", ")}`)
    .action(async (providerRaw: string) => {
      const provider = requireProvider(providerRaw, Object.keys(APP_DESCRIPTORS) as AppId[]);
      const result = await post("/cli/integrations/connect-url", { provider });
      if (!result?.ok || !result.url) {
        fail(result?.error || `No connect flow available for ${appName(provider)}.`);
      }
      console.log(`${fmt.muted("Opening the browser to connect")} ${c.bold}${appName(provider)}${c.reset}`);
      console.log(`${fmt.muted("If it doesn't open, visit:")}\n  ${fmt.accent(result.url)}\n`);
      try {
        await open(result.url);
      } catch {
        console.log(fmt.muted("Could not open the browser automatically."));
      }
      console.log(fmt.muted("Finish the flow in the browser, then run: cast integrations ls"));
    });

  integrations
    .command("disconnect")
    .description("Revoke this workspace's connection to an app")
    .argument("<provider>", `App to disconnect: ${Object.keys(APP_DESCRIPTORS).join(", ")}`)
    .action(async (providerRaw: string) => {
      const provider = requireProvider(providerRaw, Object.keys(APP_DESCRIPTORS) as AppId[]);
      const result = await post("/cli/integrations/disconnect", { provider });
      if (!result?.ok) fail(result?.error || `Could not disconnect ${appName(provider)}.`);
      console.log(`${c.green}ok${c.reset} Disconnected ${c.bold}${appName(provider)}${c.reset}`);
    });

  integrations
    .command("sources")
    .description("Issue sync sources: which Linear/GitHub container feeds which project")
    .option("--json", "Output as JSON")
    .action(async (options: any) => {
      const rows = await post("/cli/integrations/sources");
      const sources: any[] = Array.isArray(rows) ? rows : [];
      if (options.json) {
        console.log(JSON.stringify(sources, null, 2));
        return;
      }
      if (sources.length === 0) {
        console.log(fmt.muted("No issue sync sources. Add one with: cast integrations import <provider> <ref>"));
        return;
      }
      console.log();
      for (const s of sources) printSource(s);
      console.log();
    });

  integrations
    .command("candidates")
    .description("What you can import from a provider (Linear teams/projects, GitHub repos)")
    .argument("<provider>", `Provider: ${ISSUE_PROVIDERS.join(", ")}`)
    .option("--json", "Output as JSON")
    .action(async (providerRaw: string, options: any) => {
      const provider = requireProvider(providerRaw, ISSUE_PROVIDERS);
      const result = await post("/cli/integrations/candidates", { provider });
      const candidates: any[] = result?.candidates ?? [];
      if (options.json) {
        console.log(JSON.stringify(candidates, null, 2));
        return;
      }
      if (candidates.length === 0) {
        console.log(fmt.muted(`Nothing importable from ${appName(provider)}. Connect it first: cast integrations connect ${provider}`));
        return;
      }
      console.log();
      for (const cand of candidates) {
        const key = cand.external_key ? `${c.yellow}${cand.external_key}${c.reset}  ` : "";
        console.log(`  ${key}${cand.name}  ${c.dim}${cand.kind}${c.reset}  ${c.dim}${cand.external_id}${c.reset}`);
      }
      console.log(`\n  ${fmt.muted(`Import one: cast integrations import ${provider} <key or name> --project "<project>"`)}\n`);
    });

  integrations
    .command("import")
    .description("Import a Linear project/team or a GitHub repo as an issue sync source")
    .argument("<provider>", `Provider: ${ISSUE_PROVIDERS.join(", ")}`)
    .argument("<ref>", "Candidate to import: its key, name, or external id")
    .option("--project <ref>", "Codecast project the imported tasks land in (ID, short ID, or title substring)")
    .option("--kind <kind>", `Narrow the match: ${SOURCE_KINDS.join(", ")}`)
    .action(async (providerRaw: string, ref: string, options: any) => {
      const provider = requireProvider(providerRaw, ISSUE_PROVIDERS);
      if (options.kind && !(SOURCE_KINDS as readonly string[]).includes(options.kind)) {
        fail(`Unknown --kind "${options.kind}" — expected one of: ${SOURCE_KINDS.join(", ")}`);
      }
      const result = await post("/cli/integrations/candidates", { provider });
      const pool: any[] = (result?.candidates ?? []).filter((cand: any) => !options.kind || cand.kind === options.kind);
      const match = matchCandidate(pool, ref);
      if (match.kind === "none") {
        console.error(`No ${appName(provider)} candidate matching "${ref}".`);
        fail(`Run 'cast integrations candidates ${provider}' to see what is importable.`);
      }
      if (match.kind === "many") {
        console.error(`Ambiguous "${ref}" — matches:`);
        for (const cand of match.matches) console.error(`  ${cand.external_key || cand.external_id}  ${cand.name}`);
        process.exit(1);
      }
      const cand = match.candidate;
      const body: Record<string, unknown> = {
        provider,
        kind: cand.kind,
        external_id: cand.external_id,
        name: cand.name,
      };
      if (cand.external_key) body.external_key = cand.external_key;
      if (cand.url) body.url = cand.url;
      if (options.project) body.project_id = await deps.resolveProjectId(options.project);
      const source = await post("/cli/integrations/add-source", body);
      console.log(`${c.green}ok${c.reset} Importing ${c.bold}${cand.name}${c.reset} ${c.dim}(${cand.kind})${c.reset} as ${c.cyan}${source._id}${c.reset}`);
      console.log(fmt.muted(`Pull it now with: cast integrations sync ${source._id}`));
    });

  integrations
    .command("sync")
    .description("Pull a source's issues now instead of waiting for the next webhook")
    .argument("<id>", "Source ID from cast integrations sources")
    .action(async (id: string) => {
      await post("/cli/integrations/sync", { id });
      console.log(`${c.green}ok${c.reset} Sync queued for ${c.cyan}${id}${c.reset}`);
    });

  const setStatus = (status: "paused" | "active", verb: string) => async (id: string) => {
    await post("/cli/integrations/update-source", { id, status });
    console.log(`${c.green}ok${c.reset} ${verb} ${c.cyan}${id}${c.reset}`);
  };

  integrations
    .command("pause")
    .description("Stop syncing a source, keeping its tasks and its settings")
    .argument("<id>", "Source ID")
    .action(setStatus("paused", "Paused"));

  integrations
    .command("resume")
    .description("Start syncing a paused source again")
    .argument("<id>", "Source ID")
    .action(setStatus("active", "Resumed"));

  integrations
    .command("remove")
    .description("Drop a source. Tasks it already created stay; nothing new flows in.")
    .argument("<id>", "Source ID")
    .action(async (id: string) => {
      await post("/cli/integrations/remove-source", { id });
      console.log(`${c.green}ok${c.reset} Removed ${c.cyan}${id}${c.reset}`);
    });

  integrations
    .command("set")
    .description("Change a source's delegation convention")
    .argument("<id>", "Source ID")
    .option("--delegate-label <label>", "Provider label that means 'hand this to an agent'")
    .option("--delegate-assignee <who>", "Provider user (id or login) that means 'hand this to an agent'")
    .option("--auto-spawn <on|off>", "Spawn a session as soon as the delegation signal appears")
    .option("--push-new-tasks <on|off>", "Create tasks made in this project on the provider too")
    .action(async (id: string, options: any) => {
      const body: Record<string, unknown> = { id };
      if (options.delegateLabel !== undefined) body.delegate_label = options.delegateLabel;
      if (options.delegateAssignee !== undefined) body.delegate_assignee = options.delegateAssignee;
      if (options.autoSpawn !== undefined) body.auto_spawn = parseToggle("--auto-spawn", options.autoSpawn);
      if (options.pushNewTasks !== undefined) body.push_new_tasks = parseToggle("--push-new-tasks", options.pushNewTasks);
      if (Object.keys(body).length === 1) {
        fail("Nothing to set — pass --delegate-label, --delegate-assignee, --auto-spawn, or --push-new-tasks");
      }
      await post("/cli/integrations/update-source", body);
      console.log(`${c.green}ok${c.reset} Updated ${c.cyan}${id}${c.reset}`);
    });
}

export type CandidateMatch =
  | { kind: "one"; candidate: any }
  | { kind: "none" }
  | { kind: "many"; matches: any[] };

/**
 * A candidate named the three ways a person would name it: its provider key
 * ("ENG"), its display name ("Engineering"), or its raw external id. An exact
 * hit on any of the three wins outright, so a team named "API" is never
 * ambiguous against "API Gateway"; only substring matching can be ambiguous.
 */
export function matchCandidate(candidates: any[], ref: string): CandidateMatch {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  const fields = (cand: any) => [cand.external_key, cand.name, cand.external_id].filter(Boolean).map((v: string) => String(v).toLowerCase());
  const exact = candidates.filter((cand) => fields(cand).includes(needle));
  if (exact.length === 1) return { kind: "one", candidate: exact[0] };
  if (exact.length > 1) return { kind: "many", matches: exact };
  const partial = candidates.filter((cand) => fields(cand).some((v) => v.includes(needle)));
  if (partial.length === 1) return { kind: "one", candidate: partial[0] };
  if (partial.length > 1) return { kind: "many", matches: partial };
  return { kind: "none" };
}
