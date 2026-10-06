// `cast sources` (docs/architecture/external-data.md X1, X10): the feeds of
// errors, jobs, checks and metrics into a workspace.
//
//   cast sources ls | show <source> | add <provider> [name] | key rotate <source>
//   cast sources pause|resume|rm <source> | test <source> [--key -]
//
// Routes: /cli/sources/* in http.ts (ingest.ts). A keyed source (sdk, http)
// gets a write-only ingest key, printed once by add and by key rotate; only
// its hash is stored. A sentry, posthog or app source reads through the
// workspace's connection, made with `cast integrations connect <provider>`;
// an app source given --base-url makes that connection itself, with no
// secret (codecast signs every request, X8).
//
// add and key rotate also record the source (and a key) in the checkout's
// codecast.json, the committed config a product reads instead of env vars
// (codecastJson.ts).
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, csv, emit, fail, optionKey, scopedRead, scopedWrite, sparkline } from "./externalDataCli.js";
import { stdinText } from "./sendBody.js";
import { codecastJsonPath, committedIngestKey, writeCodecastJson } from "./codecastJson.js";
import { lineProjectFor } from "./signalCommand.js";
import { ADDABLE_SOURCE_PROVIDERS, GITHUB_CI_SOURCE_NAME, KEYED_SOURCE_PROVIDERS, SOURCE_CONFIG_FIELDS, SOURCE_PROVIDERS, SYSTEM_SOURCE_PROVIDERS, eventNameRows, type EventNameCounts, type SourceProvider } from "@codecast/shared/contracts/ingest";
import { replayBackfillLine, type ReplayBackfill } from "@codecast/shared/contracts/replay";

export interface SourceRow {
  _id: string;
  short_id: string;
  name: string;
  provider: SourceProvider;
  status: "active" | "paused" | "error";
  /** The access key, team:<id> or user:<id>. */
  workspace?: string;
  last_error?: string;
  last_event_at?: number;
  last_poll_at?: number;
  key_prefix?: string;
  keyed?: boolean;
  events_today?: number;
  dropped_today?: number;
  groups_open?: number;
  event_names?: EventNameCounts[];
  promote?: string[];
  fingerprint_prefix?: string;
  config?: Record<string, unknown>;
  /** A PostHog or Sentry source's bulk import of its recordings (`cast replay import`). */
  replay_backfill?: ReplayBackfill;
}

/** `cast sources add` flags: the shared ones, plus one per SOURCE_CONFIG_FIELDS entry, keyed by commander's name for it. */
export interface SourceAddOptions {
  project?: string;
  baseUrl?: string;
  fingerprintPrefix?: string;
  promote?: string;
  [configFlag: string]: string | boolean | undefined;
}

/** The wire body for `cast sources add`, or the one line that says what is wrong. */
export function sourceAddBody(providerRaw: string, name: string | undefined, o: SourceAddOptions): Record<string, unknown> {
  const provider = providerRaw.trim().toLowerCase();
  if ((SYSTEM_SOURCE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`codecast creates the ${provider} source itself: ${GITHUB_CI_SOURCE_NAME} appears the first time CI on a repository's default branch reports, and triggers name it with --source ${GITHUB_CI_SOURCE_NAME}`);
  }
  if (!(ADDABLE_SOURCE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider "${providerRaw}". Providers: ${ADDABLE_SOURCE_PROVIDERS.join(", ")}`);
  }
  const config: Record<string, unknown> = {};
  for (const field of SOURCE_CONFIG_FIELDS) {
    const given = o[optionKey(field.flag)];
    const raw = typeof given === "string" ? given : undefined;
    const value = field.list ? csv(raw) : raw?.trim() || undefined;
    if (value === undefined) continue;
    // A flag for another provider is a visible mistake, not a setting dropped in silence.
    if (!field.providers.includes(provider as SourceProvider)) throw new Error(`--${field.flag} does not apply to a ${provider} source`);
    config[field.key] = value;
  }
  return {
    provider,
    name: name?.trim() || provider,
    ...(Object.keys(config).length ? { config } : {}),
    ...(o.project?.trim() ? { project: o.project.trim() } : {}),
    ...(o.fingerprintPrefix?.trim() ? { fingerprint_prefix: o.fingerprintPrefix.trim() } : {}),
    ...(csv(o.promote) ? { promote: csv(o.promote) } : {}),
    ...appBaseUrl(provider, o.baseUrl),
  };
}

function appBaseUrl(provider: string, raw: unknown): { base_url?: string } {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return {};
  if (provider !== "app") throw new Error(`--base-url belongs to an app source, not ${provider}`);
  return { base_url: url };
}

/**
 * Record a source (and a keyed source's new key) in codecast.json, and say
 * what was written. The file holds nothing secret, so it is meant to be
 * committed; the product reads it instead of env vars.
 */
export function recordInCodecastJson(
  source: Pick<SourceRow, "name" | "short_id" | "workspace">,
  opts: { cwd: string; write: string | boolean | undefined; ingestKey?: string; endpoint: string },
): string {
  const file = codecastJsonPath(opts.cwd, opts.write);
  if (!file) return opts.write === false ? "" : fmt.muted("  Not in a checkout, so no codecast.json was written: pass --write <path> to record it.");
  if (!source.workspace) return "";
  const out = writeCodecastJson(file, { name: source.name, source: { id: source.short_id, workspace: source.workspace }, ingestKey: opts.ingestKey, endpoint: opts.endpoint });
  if ("error" in out) return fmt.error(`  ${out.path} ${out.error}`);
  if (!out.changes.length) return fmt.muted(`  ${out.path} already records it`);
  return [fmt.success(`  wrote ${out.path}`), ...out.changes.map((c) => fmt.muted(`    ${c}`)), fmt.muted("  Commit it: it holds no secret, and the app reads it instead of env vars.")].join("\n");
}

export function formatSourceLine(s: SourceRow, now: number = Date.now()): string {
  const status = s.status === "active" ? fmt.success(s.status) : s.status === "error" ? fmt.error(s.status) : fmt.warning(s.status);
  const parts = [`${s.groups_open ?? 0} open`, `${s.events_today ?? 0} today`];
  if (s.dropped_today) parts.push(`${s.dropped_today} dropped`);
  parts.push(`last event ${ago(s.last_event_at, now)}`);
  return `${fmt.id(s.short_id)}  ${s.name}  ${fmt.muted(s.provider)}  ${status}  ${fmt.muted(parts.join(" · "))}`;
}

/** The source's line, and under it why it stopped or what its last poll hit (a lost connection names how to reconnect). */
function sourceHead(s: SourceRow, now: number): string[] {
  return [formatSourceLine(s, now), ...(s.last_error ? [fmt.error(`  ${s.last_error}`)] : [])];
}

export function formatSourceList(rows: SourceRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No sources. Add one: cast sources add sdk <name>";
  return rows.flatMap((s) => sourceHead(s, now)).join("\n");
}

export function formatSourceDetail(s: SourceRow, now: number = Date.now()): string {
  const lines = sourceHead(s, now);
  if (s.keyed) lines.push(fmt.muted(`  ingest key ${s.key_prefix ?? "?"}… (cast sources key rotate ${s.name} for a new one)`));
  if (s.last_poll_at) lines.push(fmt.muted(`  last poll ${ago(s.last_poll_at, now)}`));
  if (s.promote?.length) lines.push(fmt.muted(`  promotes ${s.promote.join(", ")} to signals`));
  if (s.fingerprint_prefix) lines.push(fmt.muted(`  fingerprints as ${s.fingerprint_prefix}:<kind>:<fp>`));
  if (s.replay_backfill) lines.push(fmt.muted(`  recordings: ${replayBackfillLine(s.replay_backfill, now)}`));
  for (const [k, v] of Object.entries(s.config ?? {})) lines.push(fmt.muted(`  ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`));
  const events = eventNameRows(s.event_names, now);
  if (events.length) {
    lines.push(fmt.muted("  events, last 24h and 72h by hour:"));
    const width = Math.max(...events.map((e) => e.name.length));
    for (const e of events) lines.push(`    ${e.name.padEnd(width)}  ${String(e.day).padStart(6)}  ${fmt.muted(sparkline(e.hourly))}`);
  }
  return lines.join("\n");
}

/** What to tell a person who just made a keyed source: the key, once, and how it is used. */
export function formatNewKey(source: SourceRow, key: string, siteUrl: string): string {
  return [
    `${fmt.success(source.short_id)} ${source.name}: ingest key (shown once; write-only, so it is safe to commit)`,
    "",
    `  ${key}`,
    "",
    fmt.muted(`  The SDK reads it from codecast.json; any HTTP client POSTs batches to ${siteUrl}/cli/ingest/<key>.`),
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

  const add = sources
    .command("add")
    .description(`Add a source (${ADDABLE_SOURCE_PROVIDERS.join(", ")}). sdk and http print their ingest key once; sentry, posthog and app read through the workspace's connection, which holds the host, base url and secret (cast integrations connect <provider>)`)
    .argument("<provider>", ADDABLE_SOURCE_PROVIDERS.join(" | "))
    .argument("[name]", "Unique in the workspace; --source filters use it (default: the provider)")
    .option("--project <ref>", "Project its signals file under (default: the repo profile's [line] project, when --team is the profile's workspace)");
  for (const field of SOURCE_CONFIG_FIELDS) {
    const only = field.providers.length < SOURCE_PROVIDERS.length ? ` (${field.providers.join(", ")})` : "";
    add.option(`--${field.flag} <${field.list ? "a,b" : "value"}>`, `${field.help}${only}`);
  }
  add
    .option("--fingerprint-prefix <prefix>", "Fingerprints become <prefix>:<kind>:<fp>, joining causes a finder files the same way")
    .option("--promote <transitions>", "Transitions that become signals on the line (default: new, regressed)")
    .option("--base-url <url>", "app: where the app answers; connects it with no secret, since codecast signs every request")
    .option("--write <path>", "The codecast.json to record the source in (default: the nearest one up to the checkout root, else the root's)")
    .option("--no-write", "Record nothing in codecast.json")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (provider: string, name: string | undefined, o: SourceAddOptions & { team?: string; json?: boolean; write?: string | boolean }) => {
      let body: Record<string, unknown>;
      try {
        body = sourceAddBody(provider, name, { ...o, project: lineProjectFor(o.team, o.project) });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const result = await scopedWrite(deps, "/cli/sources/create", body, o.team);
      const source: SourceRow = result.source;
      const { siteUrl } = deps.getCliEndpoint();
      // Keyed sources and app connectors are what a product reads codecast.json for.
      const recorded = KEYED_SOURCE_PROVIDERS.includes(source.provider) || source.provider === "app"
        ? recordInCodecastJson(source, { cwd: process.cwd(), write: o.write, ingestKey: result.ingest_key, endpoint: `${siteUrl}/cli/ingest` })
        : "";
      emit(o.json, result, () => {
        const tail = recorded ? `\n${recorded}` : "";
        if (result.ingest_key) return `${formatNewKey(source, result.ingest_key, siteUrl)}${tail}`;
        if (source.provider === "app" && body.base_url) {
          return `${fmt.success(source.short_id)} ${source.name} (app, signed: no secret)${tail}\n${fmt.muted("  Deploy the app with codecast.json and verify the signature (@platform/analytics/codecast-verify), then: cast connector refresh " + source.name)}`;
        }
        // The connect command names the same workspace the source landed in.
        const where = source.workspace?.startsWith("user:") ? "--personal" : `--team ${o.team && o.team !== "personal" ? o.team : "<name>"}`;
        const connect = KEYED_SOURCE_PROVIDERS.includes(source.provider)
          ? ""
          : `\n${fmt.muted(source.provider === "app" ? `  Reads through the workspace's app connection: pass --base-url, or cast integrations connect app ${where} --base-url <url> --signed` : `  Reads through the workspace's ${source.provider} connection: cast integrations connect ${source.provider} ${where}`)}`;
        return `${fmt.success(source.short_id)} ${source.name} (${source.provider})${connect}${tail}`;
      });
    });

  const key = sources.command("key").description("The ingest key of a keyed source");
  key
    .command("rotate")
    .description("A new ingest key; the old one stops working at once")
    .argument("<source>", "Name or src-N")
    .option("--write <path>", "The codecast.json to record the new key in (default: the nearest one up to the checkout root, else the root's)")
    .option("--no-write", "Record nothing in codecast.json")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { team?: string; json?: boolean; write?: string | boolean }) => {
      const result = await scopedWrite(deps, "/cli/sources/rotate-key", { source: ref }, o.team);
      const { siteUrl } = deps.getCliEndpoint();
      const recorded = recordInCodecastJson(result.source, { cwd: process.cwd(), write: o.write, ingestKey: result.ingest_key, endpoint: `${siteUrl}/cli/ingest` });
      emit(o.json, result, () => `${formatNewKey(result.source, result.ingest_key, siteUrl)}${recorded ? `\n${recorded}` : ""}`);
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
    .option("--key <key>", stdinText("The source's ingest key (default: codecast.json's ingestKey, then $CODECAST_INGEST_KEY)"))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { key?: string; team?: string; json?: boolean }) => {
      const source: SourceRow = await scopedRead(deps, "/cli/sources/get", { source: ref }, o.team);
      if (!source.keyed) fail(`${source.name} is a ${source.provider} source and has no ingest key; check its connection with cast integrations ls`);
      const ingestKey = (o.key ?? committedIngestKey(process.cwd()) ?? process.env.CODECAST_INGEST_KEY ?? "").trim();
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
