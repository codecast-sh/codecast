// `cast sources` (docs/architecture/external-data.md X1, X10): the feeds of
// errors, jobs, checks and metrics into a workspace.
//
//   cast sources ls | show <source> | add <provider> [name] | key rotate <source>
//   cast sources pause|resume|rm <source> | test <source> [--key -]
//
// Routes: /cli/sources/* in http.ts (ingest.ts). A keyed source (sdk, http)
// gets a write-only ingest key, printed once by add and by key rotate; only
// its hash is stored. A sentry, posthog or app source reads through the
// workspace's connection, made with `cast integrations connect <provider>`.
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, csv, emit, fail, scopedRead, scopedWrite } from "./externalDataCli.js";
import { stdinText } from "./sendBody.js";
import { lineDefaults } from "./signalCommand.js";
import { KEYED_SOURCE_PROVIDERS, SOURCE_PROVIDERS, type SourceProvider } from "@codecast/shared/contracts/ingest";

export interface SourceRow {
  _id: string;
  short_id: string;
  name: string;
  provider: SourceProvider;
  status: "active" | "paused" | "error";
  last_error?: string;
  last_event_at?: number;
  last_poll_at?: number;
  key_prefix?: string;
  keyed?: boolean;
  events_today?: number;
  dropped_today?: number;
  groups_open?: number;
  promote?: string[];
  fingerprint_prefix?: string;
  config?: Record<string, unknown>;
}

export interface SourceAddOptions {
  project?: string;
  org?: string;
  projects?: string;
  host?: string;
  projectId?: string;
  baseUrl?: string;
  environments?: string;
  allowedOrigins?: string;
  fingerprintPrefix?: string;
  promote?: string;
}

/** The wire body for `cast sources add`, or the one line that says what is wrong. */
export function sourceAddBody(providerRaw: string, name: string | undefined, o: SourceAddOptions): Record<string, unknown> {
  const provider = providerRaw.trim().toLowerCase();
  if (!(SOURCE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider "${providerRaw}". Providers: ${SOURCE_PROVIDERS.join(", ")}`);
  }
  const config: Record<string, unknown> = {};
  if (o.org?.trim()) config.org = o.org.trim();
  if (csv(o.projects)) config.projects = csv(o.projects);
  if (o.host?.trim()) config.host = o.host.trim();
  if (o.projectId?.trim()) config.project_id = o.projectId.trim();
  if (o.baseUrl?.trim()) config.base_url = o.baseUrl.trim();
  if (csv(o.environments)) config.environments = csv(o.environments);
  if (csv(o.allowedOrigins)) config.allowed_origins = csv(o.allowedOrigins);
  return {
    provider,
    name: name?.trim() || provider,
    ...(Object.keys(config).length ? { config } : {}),
    ...(o.project?.trim() ? { project: o.project.trim() } : {}),
    ...(o.fingerprintPrefix?.trim() ? { fingerprint_prefix: o.fingerprintPrefix.trim() } : {}),
    ...(csv(o.promote) ? { promote: csv(o.promote) } : {}),
  };
}

export function formatSourceLine(s: SourceRow, now: number = Date.now()): string {
  const status = s.status === "active" ? fmt.success(s.status) : s.status === "error" ? fmt.error(s.status) : fmt.warning(s.status);
  const parts = [`${s.groups_open ?? 0} open`, `${s.events_today ?? 0} today`];
  if (s.dropped_today) parts.push(`${s.dropped_today} dropped`);
  parts.push(`last event ${ago(s.last_event_at, now)}`);
  return `${fmt.id(s.short_id)}  ${s.name}  ${fmt.muted(s.provider)}  ${status}  ${fmt.muted(parts.join(" · "))}`;
}

export function formatSourceList(rows: SourceRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No sources. Add one: cast sources add sdk <name>";
  return rows.map((s) => formatSourceLine(s, now)).join("\n");
}

export function formatSourceDetail(s: SourceRow, now: number = Date.now()): string {
  const lines = [formatSourceLine(s, now)];
  if (s.last_error) lines.push(fmt.error(`  ${s.last_error}`));
  if (s.keyed) lines.push(fmt.muted(`  ingest key ${s.key_prefix ?? "?"}… (cast sources key rotate ${s.name} for a new one)`));
  if (s.last_poll_at) lines.push(fmt.muted(`  last poll ${ago(s.last_poll_at, now)}`));
  if (s.promote?.length) lines.push(fmt.muted(`  promotes ${s.promote.join(", ")} to signals`));
  if (s.fingerprint_prefix) lines.push(fmt.muted(`  fingerprints as ${s.fingerprint_prefix}:<kind>:<fp>`));
  for (const [k, v] of Object.entries(s.config ?? {})) lines.push(fmt.muted(`  ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`));
  return lines.join("\n");
}

/** What to tell a person who just made a keyed source: the key, once, and how it is used. */
export function formatNewKey(source: SourceRow, key: string, siteUrl: string): string {
  return [
    `${fmt.success(source.short_id)} ${source.name}: ingest key (shown once, store it now)`,
    "",
    `  ${key}`,
    "",
    fmt.muted(`  POST batches to ${siteUrl}/cli/ingest/<key>, or set it as the SDK's ingestKey.`),
    fmt.muted(`  Check it: cast sources test ${source.name} --key -`),
  ].join("\n");
}

/** One harmless batch: a counted event, never stored or announced. */
export function testBatch(now: number = Date.now()) {
  return { sdk: { name: "cast", version: "1" }, items: [{ type: "event", name: "codecast.test", at: now }] };
}

export function registerSourcesCommand(program: Command, deps: PublishDeps): void {
  const sources = program.command("sources").description(commandGroup("sources").description);

  sources
    .command("ls")
    .alias("list")
    .description("The workspace's sources with their state")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { team?: string; json?: boolean }) => {
      const rows: SourceRow[] = await scopedRead(deps, "/cli/sources/list", {}, o.team);
      emit(o.json, rows, () => formatSourceList(rows));
    });

  sources
    .command("show")
    .description("One source: state, key prefix, promotion and settings")
    .argument("<source>", "Name or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      const row: SourceRow = await scopedRead(deps, "/cli/sources/get", { source: ref }, o.team);
      emit(o.json, row, () => formatSourceDetail(row));
    });

  sources
    .command("add")
    .description(`Add a source (${SOURCE_PROVIDERS.join(", ")}); sdk and http print their ingest key once`)
    .argument("<provider>", SOURCE_PROVIDERS.join(" | "))
    .argument("[name]", "Unique in the workspace; --source filters use it (default: the provider)")
    .option("--project <ref>", "Project its signals file under (default: the repo profile's [line] project)")
    .option("--org <slug>", "Sentry organization slug")
    .option("--projects <a,b>", "Sentry project slugs to mirror")
    .option("--host <url>", "PostHog host (https://us.posthog.com, or self-hosted)")
    .option("--project-id <id>", "PostHog project id")
    .option("--base-url <url>", "App connector base url (its manifest is <base-url>/codecast/manifest)")
    .option("--environments <a,b>", "Only these environments")
    .option("--allowed-origins <a,b>", "Origins a browser SDK may post from")
    .option("--fingerprint-prefix <prefix>", "Fingerprints become <prefix>:<kind>:<fp>, joining causes a finder files the same way")
    .option("--promote <transitions>", "Transitions that become signals on the line (default: new, regressed)")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (provider: string, name: string | undefined, o: SourceAddOptions & { team?: string; json?: boolean }) => {
      let body: Record<string, unknown>;
      try {
        body = sourceAddBody(provider, name, { ...o, project: o.project || lineDefaults().project });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const result = await scopedWrite(deps, "/cli/sources/create", body, o.team);
      const source: SourceRow = result.source;
      emit(o.json, result, () => {
        if (result.ingest_key) return formatNewKey(source, result.ingest_key, deps.getCliEndpoint().siteUrl);
        const connect = KEYED_SOURCE_PROVIDERS.includes(source.provider) ? "" : `\n${fmt.muted(`  Reads through the workspace's ${source.provider} connection: cast integrations connect ${source.provider}`)}`;
        return `${fmt.success(source.short_id)} ${source.name} (${source.provider})${connect}`;
      });
    });

  const key = sources.command("key").description("The ingest key of a keyed source");
  key
    .command("rotate")
    .description("A new ingest key; the old one stops working at once")
    .argument("<source>", "Name or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      const result = await scopedWrite(deps, "/cli/sources/rotate-key", { source: ref }, o.team);
      emit(o.json, result, () => formatNewKey(result.source, result.ingest_key, deps.getCliEndpoint().siteUrl));
    });

  for (const [verb, status, what] of [["pause", "paused", "Stop taking batches and polls"], ["resume", "active", "Take batches and polls again, clearing the last error"]] as const) {
    sources
      .command(verb)
      .description(what)
      .argument("<source>", "Name or src-N")
      .option(...TEAM_OPTION)
      .option(...JSON_OPTION)
      .action(async (ref: string, o: { team?: string; json?: boolean }) => {
        const result = await scopedWrite(deps, "/cli/sources/update", { source: ref, status }, o.team);
        emit(o.json, result, () => formatSourceLine(result.source));
      });
  }

  sources
    .command("rm")
    .alias("remove")
    .description("Remove a source and its groups; the timeline keeps its rows")
    .argument("<source>", "Name or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      const result = await scopedWrite(deps, "/cli/sources/remove", { source: ref }, o.team);
      emit(o.json, result, () => `${fmt.success("removed")} ${result.removed}`);
    });

  sources
    .command("test")
    .description("Post one harmless batch through the ingest door with a keyed source's key, and print what the door answered")
    .argument("<source>", "Name or src-N")
    .option("--key <key>", stdinText("The source's ingest key (default: $CODECAST_INGEST_KEY)"))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { key?: string; team?: string; json?: boolean }) => {
      const source: SourceRow = await scopedRead(deps, "/cli/sources/get", { source: ref }, o.team);
      if (!source.keyed) fail(`${source.name} is a ${source.provider} source and has no ingest key; check its connection with cast integrations ls`);
      const ingestKey = (o.key ?? process.env.CODECAST_INGEST_KEY ?? "").trim();
      if (!ingestKey) fail(`Pass the key: cast sources test ${source.name} --key - (it starts ${source.key_prefix ?? "cc_ing_"})`);
      if (source.key_prefix && !ingestKey.startsWith(source.key_prefix)) fail(`That key is not ${source.name}'s (its key starts ${source.key_prefix})`);
      const { siteUrl } = deps.getCliEndpoint();
      const response = await fetch(`${siteUrl}/cli/ingest/${encodeURIComponent(ingestKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testBatch()),
      });
      const text = await response.text();
      let answer: any = text;
      try {
        answer = JSON.parse(text);
      } catch {}
      const result = { status: response.status, answer };
      if (o.json) {
        emit(true, result, () => "");
      } else if (response.ok) {
        console.log(`${fmt.success(String(response.status))} the door took the batch (${answer?.accepted ?? "?"} accepted, ${answer?.dropped ?? 0} dropped)`);
      } else {
        console.log(`${fmt.error(String(response.status))} ${typeof answer === "string" ? answer.slice(0, 200) : answer?.error ?? JSON.stringify(answer)}`);
      }
      if (!response.ok) process.exit(1);
    });

}
