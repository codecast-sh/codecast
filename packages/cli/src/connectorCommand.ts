// `cast connector` (docs/architecture/external-data.md X8, X10): what a
// product lets codecast read and do. The product declares named readers and
// actions in its manifest; codecast calls them with the workspace's secret,
// hands the answer back, and stores only an audit row per call. An action
// runs only once a person grants it in the browser, a high-risk one only with
// --yes. `grant` and `revoke` here only print where that person does it: an
// agent's CLI never grants. A Sentry source's writes (issue.resolve,
// issue.ignore) are granted the same way and listed by `actions`.
//
//   cast connector ls | readers <source> | actions <source> | calls <source> | refresh <source>
//   cast connector read <source> <reader> [--arg k=v ...] [--args -]
//   cast connector do <source> <action> [--arg k=v ...] [--args -] [--yes] [--idempotency-key k]
//   cast connector grant|revoke <source> <action>   (prints the browser page where a person does it)
//
// Routes: /cli/connector/* in http.ts (sources/app.ts). The token is `connector`
// because `cast app` drives the codecast app itself.
import type { Command } from "commander";
import type { PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { JSON_OPTION, TEAM_OPTION, ago, collect, emit, fail, scopedRead, scopedWrite } from "./externalDataCli.js";
import { stdinText } from "./sendBody.js";
import { formatSourceList, type SourceRow } from "./sourcesCommand.js";
import { webBaseUrl } from "./config/readLocalConfig.js";
import {
  coerceArgs,
  grantPagePath,
  grantableActions,
  parseAppManifest,
  type AppManifest,
  type AppReader,
  type GrantableAction,
  type JsonSchema,
} from "@codecast/shared/contracts/appConnector";

export interface Capabilities {
  source: { short_id: string; name: string; provider?: string; status: string; last_error?: string };
  manifest_json: string | null;
  manifest_fetched_at: number | null;
  grants: { action: string; until?: number; granted_at: number }[];
  watch_state: { key: string; polled_at: number; ok?: boolean; error?: string }[];
}

export interface CallResult {
  ok: boolean;
  status?: number;
  text?: string;
  content_type?: string;
  bytes?: number;
  ms?: number;
  error?: string;
  denied?: boolean;
}

/** `k=v` as a pair; the value may itself hold `=`. */
export function splitArg(raw: string): [string, string] {
  const at = raw.indexOf("=");
  if (at <= 0) throw new Error(`--arg ${raw}: use key=value`);
  return [raw.slice(0, at).trim(), raw.slice(at + 1)];
}

/**
 * The args a call sends: the --args JSON object, then each --arg read by the
 * declared input's property types (coerceArgs), the later winning. The server
 * validates the result against the same schema.
 */
export function callArgs(json: string | undefined, pairs: string[], schema: JsonSchema | undefined): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (json?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("--args is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--args must be a JSON object");
    base = parsed as Record<string, unknown>;
  }
  return { ...base, ...coerceArgs(schema, pairs.map(splitArg)) };
}

export function manifestOf(caps: Capabilities): AppManifest | null {
  if (!caps.manifest_json) return null;
  const parsed = parseAppManifest(JSON.parse(caps.manifest_json));
  return parsed.ok ? parsed.manifest : null;
}

function inputLine(schema: JsonSchema | undefined): string {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return "";
  const required = new Set(schema?.required ?? []);
  return props.map(([k, p]) => `${k}${required.has(k) ? "" : "?"}:${Array.isArray(p.type) ? p.type.join("|") : p.type ?? "any"}`).join(" ");
}

export function formatReaders(readers: AppReader[]): string {
  if (!readers.length) return "No readers declared.";
  return readers.map((r) => `${fmt.highlight(r.name)}  ${r.title}${r.description ? fmt.muted(` · ${r.description}`) : ""}\n  ${fmt.muted(inputLine(r.input) || "no args")}`).join("\n");
}

/** The actions a source can be granted: an app's declared ones, or a vendor source's writes. */
export function actionsOf(caps: Capabilities): readonly (GrantableAction & { input?: JsonSchema })[] {
  return grantableActions(caps.source.provider ?? "app", manifestOf(caps));
}

/**
 * What `cast connector grant|revoke` prints: grants are a person's, made in
 * the browser, so the verb names the page and the action and fails.
 */
export function grantElsewhere(verb: "grant" | "revoke", caps: Capabilities, action: string, webBase: string): string {
  const known = actionsOf(caps).map((a) => a.name);
  if (!known.includes(action)) return `${caps.source.name} has no action ${action} (it has: ${known.join(", ") || "none"})`;
  return `${verb === "grant" ? "Granting" : "Revoking"} ${action} on ${caps.source.name} is a person's call, made in the browser: ${webBase}${grantPagePath(caps.source.short_id)}`;
}

export function formatActions(actions: readonly (GrantableAction & { input?: JsonSchema })[], grants: Capabilities["grants"], now: number = Date.now()): string {
  if (!actions.length) return "No actions declared.";
  return actions
    .map((a) => {
      const g = grants.find((x) => x.action === a.name);
      const grant = g ? fmt.success(`granted${g.until ? ` until ${new Date(g.until).toISOString().slice(0, 10)}` : ""}`) : fmt.muted("not granted");
      const flags = [a.risk === "high" ? fmt.error("high risk") : "", a.idempotent ? "" : "needs --idempotency-key"].filter(Boolean).join(", ");
      return `${fmt.highlight(a.name)}  ${a.title}  ${grant}${flags ? `  ${flags}` : ""}${a.description ? fmt.muted(` · ${a.description}`) : ""}\n  ${fmt.muted(inputLine(a.input) || "no args")}`;
    })
    .join("\n");
}

/** A call's answer for a person: the body as sent (JSON pretty), or the refusal. */
export function formatCallResult(r: CallResult): string {
  if (!r.ok) return fmt.error(r.error ?? `failed${r.status ? ` (${r.status})` : ""}`);
  const text = r.text ?? "";
  if (r.content_type?.includes("json") || /^[\[{]/.test(text.trim())) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return text;
}

export function registerConnectorCommand(program: Command, deps: PublishDeps): void {
  const connector = program.command("connector").description(commandGroup("connector").description);

  const caps = async (source: string, team?: string): Promise<Capabilities> => await scopedRead(deps, "/cli/connector/capabilities", { source }, team);
  const needManifest = (c: Capabilities): AppManifest => manifestOf(c) ?? fail(`${c.source.name} has no manifest yet: cast connector refresh ${c.source.name}`);

  connector
    .command("ls")
    .alias("list")
    .description("The workspace's app sources")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (o: { team?: string; json?: boolean }) => {
      const rows: SourceRow[] = (await scopedRead(deps, "/cli/sources/list", {}, o.team)).filter((s: SourceRow) => s.provider === "app");
      emit(o.json, rows, () => (rows.length ? formatSourceList(rows) : "No app sources. Add one: cast sources add app <name> --base-url https://your.app, then cast integrations connect app"));
    });

  connector
    .command("readers")
    .description("What the product lets codecast read")
    .argument("<source>", "App source name or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (source: string, o: { team?: string; json?: boolean }) => {
      const m = needManifest(await caps(source, o.team));
      emit(o.json, m.readers, () => formatReaders(m.readers));
    });

  connector
    .command("actions")
    .description("What codecast may do through a source (an app's declared actions, a Sentry source's resolve and ignore), and which a person granted")
    .argument("<source>", "App or Sentry source name, or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (source: string, o: { team?: string; json?: boolean }) => {
      const c = await caps(source, o.team);
      if ((c.source.provider ?? "app") === "app") needManifest(c);
      const actions = actionsOf(c);
      emit(o.json, { actions, grants: c.grants }, () => formatActions(actions, c.grants));
    });

  const call = (verb: "read" | "do") => {
    const cmd = connector
      .command(verb)
      .argument("<source>", "App source name or src-N")
      .argument(verb === "read" ? "<reader>" : "<action>", verb === "read" ? "A declared reader" : "A granted action")
      .option("--arg <k=v>", "One argument, read by the declared type (repeat it)", collect, [])
      .option("--args <json>", stdinText("All arguments as one JSON object"));
    if (verb === "do") {
      cmd
        .option("--yes", "Confirm a high-risk action for this call")
        .option("--idempotency-key <key>", "Required by a non-idempotent action, so a retry cannot run it twice");
    }
    return cmd.option(...TEAM_OPTION).option(...JSON_OPTION);
  };

  const run = async (verb: "read" | "do", source: string, name: string, o: { arg: string[]; args?: string; yes?: boolean; idempotencyKey?: string; team?: string; json?: boolean }) => {
    let args: Record<string, unknown>;
    try {
      // Typed --arg values need the declared schema; JSON alone does not.
      let schema: JsonSchema | undefined;
      if (o.arg.length) {
        const m = needManifest(await caps(source, o.team));
        schema = (verb === "read" ? m.readers : m.actions).find((d) => d.name === name)?.input;
      }
      args = callArgs(o.args, o.arg, schema);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const body: Record<string, unknown> = { source, [verb === "read" ? "reader" : "action"]: name, args_json: JSON.stringify(args) };
    if (o.yes) body.yes = true;
    if (o.idempotencyKey?.trim()) body.idempotency_key = o.idempotencyKey.trim();
    const res: CallResult = await scopedWrite(deps, `/cli/connector/${verb}`, body, o.team);
    emit(o.json, res, () => formatCallResult(res));
    if (!res.ok) process.exit(1);
  };

  call("read")
    .description("Call a declared reader; the answer comes back here and is not stored")
    .action(async (source: string, reader: string, o) => run("read", source, reader, o));
  call("do")
    .description("Run a granted action")
    .action(async (source: string, action: string, o) => run("do", source, action, o));

  for (const verb of ["grant", "revoke"] as const) {
    connector
      .command(verb)
      .description(verb === "grant" ? "Where a person allows an action: grants are made in the browser, never by an agent" : "Where a person withdraws an action's grant, in the browser")
      .argument("<source>", "App or Sentry source name, or src-N")
      .argument("<action>", "An action the source can be granted")
      .option(...TEAM_OPTION)
      .action(async (source: string, action: string, o: { team?: string }) => fail(grantElsewhere(verb, await caps(source, o.team), action, webBaseUrl())));
  }

  connector
    .command("calls")
    .description("The call audit, newest first: who called what, status, time and size (never bodies)")
    .argument("<source>", "App source name or src-N")
    .option("-n, --limit <n>", "How many", (v: string) => parseInt(v, 10))
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (source: string, o: { limit?: number; team?: string; json?: boolean }) => {
      const rows: any[] = await scopedRead(deps, "/cli/connector/calls", { source, limit: o.limit }, o.team);
      emit(o.json, rows, () =>
        rows.length
          ? rows.map((r) => `${fmt.muted(ago(r.created_at).padEnd(8))}  ${r.kind}  ${r.name}  ${r.status === "ok" ? fmt.success(r.status) : fmt.error(r.status)}${r.http_status ? ` ${r.http_status}` : ""}  ${fmt.muted(`${r.ms}ms ${r.bytes}B`)}${r.error ? `  ${r.error}` : ""}`).join("\n")
          : "No calls yet.");
    });

  connector
    .command("refresh")
    .description("Fetch the product's manifest now")
    .argument("<source>", "App source name or src-N")
    .option(...TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (source: string, o: { team?: string; json?: boolean }) => {
      const res = await scopedWrite(deps, "/cli/connector/refresh", { source }, o.team);
      emit(o.json, res, () => (res.ok ? `${fmt.success("refreshed")} ${res.readers} readers, ${res.actions} actions, ${res.watches} watches` : fmt.error(res.error ?? "refresh failed")));
      if (!res.ok) process.exit(1);
    });
}
