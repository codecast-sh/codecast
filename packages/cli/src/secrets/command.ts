// `cast vault` (docs/architecture/vault.md): the team's keys, logins and
// files, for agents. Values come in through a hidden prompt, stdin, a file or
// the environment, never argv, and go out substituted where they are needed
// (`run`), or on stdout for a pipe (`get`, `env`, `otp`). Every read names the
// calling session so the audit trail says which agent used what.
//
// Routes: /cli/vault/* in http.ts (convex/secrets.ts). Writes name their
// workspace (--team, the repo profile's, else the active team, else
// personal); the server refuses a write that names none.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { fmt } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { JSON_OPTION, ago, collect, emit, fail, formatAge } from "../externalDataCli.js";
import { promptHiddenSecret } from "../hiddenSecret.js";
import { lineDefaults } from "../lineScope.js";
import { loadWorkspaceRoster, resolveWorkspaceForWrite, workspaceLabel } from "../resolveWorkspace.js";
import { readStdinBody } from "../sendBody.js";
import { askLine, askYesNo } from "../terminalAsk.js";
import {
  SECRET_HEALTH_DAYS,
  SECRET_KINDS,
  envFor,
  payloadFingerprint,
  secretHealth,
  totp,
  validatePayload,
  type LoginPayload,
  type SecretHealth,
  type SecretKind,
  type SecretMeta,
  type SecretPayload,
  type SecretReadPurpose,
  type SecretVersionMeta,
} from "@codecast/shared/contracts/secrets";
import { argsAfterGroup, filesCommandFor, splitRunArgs } from "./argv.js";
import {
  defaultField,
  exportLines,
  fieldValue,
  getFieldRefusal,
  materialize,
  readPayload,
  runWith,
  type GetField,
  type ReadSecret,
  type ValueIO,
  type ValueOptions,
} from "./inject.js";
import { NEEDS_APPROVAL_EXIT, exitForApproval, isNeedsApproval } from "./approval.js";
import { envFromFiles, readEnvFiles, referencedSecrets, unresolvedRefs } from "./envFile.js";
import { envToSecret, gapLine, planProjectRead, preferredWorkspace, projectVault, varsBySecret, type VaultMap } from "./projectMap.js";
import { refreshDaemonRedaction } from "./redactionSource.js";

const WRITE_TEAM_OPTION = ["--team <name|id|personal>", "Where it goes (default: the repo profile's team, else your active team, else personal)"] as const;
const WHY_OPTION = ["--why <text>", "What you need it for; an Ask first secret puts it in the question a person answers"] as const;
const ASK_FIRST_HELP = `An Ask first secret this session has no approval for reads nothing: the decision to wait on is printed and the exit code is ${NEEDS_APPROVAL_EXIT}.`;
const cwd = () => process.env.CODECAST_CWD || process.cwd();
/** A login with 2FA and no terminal: the password and the setup key as two stdin lines (or the key from --totp-from-env). */
const totpExample = (verb: string) => `Example: printf '%s\\n%s\\n' "$PW" "$SEED" | cast vault ${verb} --totp`;

/**
 * Values from this terminal. Piped stdin is read once: line by line for the
 * hidden prompts, whole and byte for byte for a file secret (a PEM keeps its
 * final newline).
 */
export function terminalIO(tty: boolean = !!process.stdin.isTTY, readStdin: () => string = () => fs.readFileSync(0, "utf-8")): ValueIO {
  return {
    tty,
    hidden: async (prompts) => {
      if (!tty) {
        const lines = readStdinBody(readStdin).split("\n");
        return prompts.map((_, i) => (lines[i] ?? "").trim());
      }
      const out: string[] = [];
      for (const p of prompts) out.push(await promptHiddenSecret(p));
      return out;
    },
    ask: askLine,
    stdin: readStdin,
    env: process.env,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };
}

/** The session this command runs in, so the backend can name it in the audit trail. */
function conversationOf(deps: PublishDeps): { conversation?: string } {
  const id = deps.detectCurrentSessionId();
  return id ? { conversation: id } : {};
}

/** Where a write lands, resolved the way every CLI write resolves, then said out loud. */
async function writeWhere(deps: PublishDeps, team: string | undefined): Promise<{ body: { team_id: string } | { personal: true }; label: string }> {
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  try {
    const ws = resolveWorkspaceForWrite(roster, team || lineDefaults().team);
    return { body: ws.kind === "team" ? { team_id: ws.teamId } : { personal: true }, label: workspaceLabel(ws) };
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The values, or (Ask first) the decision to wait on and exit
 * NEEDS_APPROVAL_EXIT, having read nothing. Before a value goes anywhere, this
 * machine's daemon takes the Vault's current values into redaction, so one
 * stored or rotated a moment ago is already redacted where the output lands.
 */
async function readSecrets(deps: PublishDeps, refs: string[], purpose: SecretReadPurpose, why?: string): Promise<ReadSecret[]> {
  const prefer = await preferredWorkspace(deps);
  const res = await apiPost(deps, "/cli/vault/read", { refs, purpose, ...(why ? { why } : {}), ...(prefer ? { prefer } : {}), ...conversationOf(deps) });
  if (isNeedsApproval(res)) exitForApproval(res, why);
  await refreshDaemonRedaction();
  return res.secrets;
}

/** `--yes`, else a yes on a terminal; off one, `refusal` (which names the --yes command) and exit 1. */
async function confirmed(o: { yes?: boolean }, ask: string, refusal: string): Promise<boolean> {
  if (o.yes) return true;
  if (!process.stdin.isTTY) fail(refusal);
  return askYesNo(`${ask} [y/N] `);
}

/** This checkout's [vault], with a broken manifest reported as the line it names. */
function projectMap(): VaultMap | null {
  try {
    return projectVault(cwd());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What `run` and `env` read: the names given and `referenced` (the vault://
 * secrets of the env files given, which may be none); with no names, the
 * ready part of the project's [vault] map (planProjectRead) instead. Each gap
 * in the map prints its fix, and a required one stops the command before any
 * read. `map` goes to materialize either way (names win there). With nothing
 * to read, a refusal that shows the form.
 */
async function refsFor(
  deps: PublishDeps,
  o: { names: string[]; example: string; referenced?: string[]; files: boolean; listMetas: () => Promise<SecretMeta[]> },
): Promise<{ refs: string[]; map: Record<string, string> | null }> {
  const project = projectMap();
  if (!o.names.length && !project && !o.referenced) fail(`Name the secrets, or map them in .codecast/workspace.toml under [vault]: ${o.example}`);
  const map = project && envToSecret(project);
  let fromMap: string[] = [];
  if (project && !o.names.length) {
    const plan = planProjectRead(project, await o.listMetas(), await preferredWorkspace(deps), { files: o.files });
    const blocking = plan.gaps.filter((g) => g.required);
    if (blocking.length) fail(`Required in [vault], so nothing ran:\n${blocking.map((g) => g.line).join("\n")}`);
    for (const gap of plan.gaps) console.error(fmt.muted(`${gap.line}. Going without it`));
    fromMap = plan.read;
  }
  return { refs: [...new Set([...o.names, ...fromMap, ...(o.referenced ?? [])])], map };
}

/** One /cli/vault/list per command, however many checks ask for it. */
function metasOnce(deps: PublishDeps): () => Promise<SecretMeta[]> {
  let metas: Promise<SecretMeta[]> | undefined;
  return () => (metas ??= apiPost(deps, "/cli/vault/list", {}, { read: true }));
}

async function payloadFor(kind: SecretKind, o: ValueOptions): Promise<SecretPayload> {
  let raw: SecretPayload;
  try {
    raw = await readPayload(kind, o, terminalIO());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const checked = validatePayload(kind, raw);
  if ("error" in checked) fail(checked.error);
  return checked.payload;
}

const valueOptions = (cmd: Command) =>
  cmd
    .option("--username <name>", "A login's username (not secret, so a flag)")
    .option("--totp", "A login's 2FA: the setup key or otpauth:// link from a hidden prompt, or piped as the line after the password")
    .option("--totp-from-env <VAR>", "A login's 2FA setup key or otpauth:// link from this environment variable")
    .option("--file <path>", "A file secret's content, read from this path")
    .option("--from-env <VAR>", "Take the value (a login's password) from this environment variable");

const kindOf = (raw: string | undefined, allowed: readonly SecretKind[]): SecretKind => {
  const kind = (raw ?? "key") as SecretKind;
  if (!allowed.includes(kind)) fail(`--kind takes ${allowed.join(", ")}`);
  return kind;
};

// ── Lines ───────────────────────────────────────────────────────────────────

const session = (id: string | undefined) => (id ? id.slice(0, 7) : undefined);

/** A sign-in's sites, else the env vars a secret fills under run (envFor); the ones only its name implies are muted. */
function bindingOf(s: SecretMeta): string {
  if (s.kind === "signin") return s.sites?.join(",") ?? "";
  const vars = envFor(s).map((b) => b.var).join(",");
  return s.env?.length ? vars : fmt.muted(vars);
}

const HEALTH_WORD: Record<SecretHealth, string> = { expired: "expired", expiring: "expiring", stale: "stale", unused: "never used" };

/** A ready secret's health as one short token, colored by urgency; "" when nothing needs a look. */
export function healthToken(s: SecretMeta, now: number = Date.now()): string {
  const h = secretHealth(s, now);
  if (!h) return "";
  const word = h === "expiring" ? `expiring ${untilText(s.signin_expires_at!, now)}` : HEALTH_WORD[h];
  return h === "expired" ? fmt.error(word) : fmt.warning(word);
}

/** A ready row's flags after its binding: Ask first, and the earlier values restore can put back. */
function markers(s: SecretMeta): string[] {
  return [s.ask_first ? fmt.warning("ask-first") : "", s.version_count ? fmt.muted(`${s.version_count} earlier`) : ""];
}

const kindText = (s: SecretMeta) => `${s.kind}${s.has_otp ? "+2fa" : ""}`;

/** One list row; `projectVars` are the env vars this checkout's [vault] fills from it. */
export function formatSecretLine(s: SecretMeta, scope: string, now: number = Date.now(), projectVars?: string[]): string {
  const project = projectVars?.length ? fmt.highlight(`project ${projectVars.join(",")}`) : "";
  if (s.status === "requested") {
    const who = s.requested_by_name ? ` by ${s.requested_by_name}` : "";
    const from = s.requested_from_conversation ? ` from ${session(s.requested_from_conversation)}` : "";
    return [fmt.id(s.short_id), fmt.warning("requested"), s.name, s.kind, bindingOf(s), project, fmt.muted(scope), fmt.muted(`asked${who}${from}${s.request_why ? `: ${s.request_why}` : ""}`)].filter(Boolean).join("  ");
  }
  const health = healthToken(s, now);
  const used = s.last_used_at ? `used ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : secretHealth(s, now) === "unused" ? "" : "never used";
  return [fmt.id(s.short_id), s.name, kindText(s), bindingOf(s), project, fmt.muted(scope), ...markers(s), health, used && fmt.muted(used)].filter(Boolean).join("  ");
}

/** The [vault] lines naming a secret the Vault does not hold, each with the request that fixes it. */
export function unmappedLines(map: VaultMap, rows: Pick<SecretMeta, "name">[]): string[] {
  const held = new Set(rows.map((r) => r.name));
  return Object.entries(map).filter(([, b]) => !held.has(b.secret)).map(([v, b]) => fmt.warning(gapLine(v, b.secret, null)));
}

async function scopeNamer(deps: PublishDeps, rows: SecretMeta[]): Promise<(s: SecretMeta) => string> {
  if (!rows.some((r) => r.workspace.startsWith("team:"))) return () => "personal";
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  const names = new Map(roster.teams.map((t) => [t._id, t.name]));
  return (s) => (s.workspace.startsWith("team:") ? names.get(s.team_id ?? "") || "team" : "personal");
}

type SecretEvent = { kind: string; at: number; purpose?: string; actor_name?: string; session_short_id?: string; session_title?: string; decision_short_id?: string };

export function formatShow(s: SecretMeta, scope: string, events: SecretEvent[], now: number = Date.now()): string {
  const row = (label: string, value: string | undefined) => (value ? `  ${fmt.label(label.padEnd(12))}${value}` : null);
  const lines = [
    `${fmt.id(s.short_id)}  ${fmt.highlight(s.name)}  ${kindText(s)}  ${fmt.muted(scope)}${s.status === "requested" ? `  ${fmt.warning("requested")}` : ""}`,
    row("health", healthToken(s, now) || undefined),
    row("ask first", s.ask_first ? `on  ${fmt.muted("a person approves each session's first read")}` : undefined),
    row("env", s.kind === "signin" ? undefined : `${envFor(s).map((b) => b.var).join(", ")}${s.env?.length ? "" : `  ${fmt.muted("from its name")}`}`),
    row("sites", s.sites?.join(", ")),
    row("expires", s.kind === "signin" ? signinExpiry(s.signin_expires_at, now) : undefined),
    row("fingerprint", s.fingerprint),
    row("2fa", s.has_otp ? `seed stored  ${fmt.muted(`cast vault otp ${s.name}`)}` : undefined),
    row("earlier", s.version_count ? `${s.version_count} value${s.version_count === 1 ? "" : "s"}  ${fmt.muted(`cast vault restore ${s.name} lists them`)}` : undefined),
    row("note", s.note),
    row("asked", s.status === "requested" ? `${s.requested_by_name ?? "someone"}${s.request_why ? `: ${s.request_why}` : ""}` : undefined),
    row("created", `${ago(s.created_at, now)}${s.created_by_name ? ` by ${s.created_by_name}` : ""}${s.rotated_at ? `, rotated ${ago(s.rotated_at, now)}${s.updated_by_name ? ` by ${s.updated_by_name}` : ""}` : ""}`),
    row("used", s.last_used_at ? `${s.use_count ?? 0}x, last ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : "never"),
  ].filter((l): l is string => l !== null);
  if (events.length) {
    lines.push("", fmt.label("activity"));
    for (const e of events.slice(0, 15)) {
      const what = e.purpose ? `${e.kind} (${e.purpose})` : e.kind;
      const where = [e.decision_short_id, e.session_short_id && `${e.session_short_id}${e.session_title ? ` ${fmt.muted(e.session_title)}` : ""}`].filter(Boolean).map((w) => `  ${w}`).join("");
      lines.push(`  ${fmt.muted(ago(e.at, now).padEnd(10))}${what.padEnd(16)} ${e.actor_name ?? ""}${where}`);
    }
  }
  return lines.join("\n");
}

/** A time ahead: "in 10d". */
const untilText = (at: number, now: number) => `in ${formatAge(at - now).replace(/ ago$/, "")}`;

/** When a sign-in's cookies run out, as `show` says it. */
function signinExpiry(at: number | undefined, now: number): string {
  if (at === undefined) return "when the browser closes";
  const date = new Date(at).toISOString().slice(0, 10);
  if (at <= now) return fmt.warning(`expired ${ago(at, now)} (${date}): save it again with cast vault save-signin`);
  const left = `${untilText(at, now)} (${date})`;
  return at - now < 3 * 86_400_000 ? fmt.warning(left) : left;
}

/** `restore`'s list: number (1 the newest), when and by whom it was replaced, its fingerprint, how long it stays. */
export function formatVersions(name: string, versions: SecretVersionMeta[], now: number = Date.now()): string {
  const lines = versions.map((v, i) =>
    [fmt.id(String(i + 1).padStart(2)), `replaced ${ago(v.rotated_at, now)}${v.rotated_by_name ? ` by ${v.rotated_by_name}` : ""}`, v.fingerprint ?? "", fmt.muted(`kept ${untilText(v.expires_at, now)}`)].filter(Boolean).join("  "),
  );
  return [...lines, fmt.muted(`Put one back: cast vault restore ${name} <number>`)].join("\n");
}

/** The version a restore argument names: its list number (1 the newest), its rotated_at, or its id. */
export function pickVersion(versions: SecretVersionMeta[], arg: string): SecretVersionMeta | undefined {
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 1 && n <= versions.length) return versions[n - 1];
  return versions.find((v) => v._id === arg || String(v.rotated_at) === arg);
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerVaultCommand(program: Command, deps: PublishDeps): void {
  const filesGuard = () => {
    const files = filesCommandFor(argsAfterGroup((program as any).rawArgs ?? []));
    if (files) fail(`Files moved: ${files}`);
  };

  const list = async (o: { json?: boolean; stale?: boolean }) => {
    const all: SecretMeta[] = await apiPost(deps, "/cli/vault/list", {}, { read: true });
    const now = Date.now();
    const rows = o.stale ? all.filter((r) => secretHealth(r, now)) : all;
    const map = projectMap();
    const uses = map ? varsBySecret(map) : new Map<string, string[]>();
    if (o.json) {
      return emit(true, rows.map((r) => {
        const health = secretHealth(r, now);
        return { ...r, ...(uses.has(r.name) ? { project_env: uses.get(r.name) } : {}), ...(health ? { health } : {}) };
      }), () => "");
    }
    const missing = map && !o.stale ? unmappedLines(map, rows) : [];
    if (!rows.length && !missing.length) {
      return console.log(o.stale ? "Nothing needs a look: no secret is expired, expiring, never used or stale" : "The vault is empty. Store a key: cast vault add stripe-test --env STRIPE_SECRET_KEY");
    }
    const scope = await scopeNamer(deps, rows);
    console.log([...rows.map((s) => formatSecretLine(s, scope(s), now, uses.get(s.name))), ...missing].join("\n"));
  };

  const vault = program
    .command("vault")
    .alias("secrets")
    .description(commandGroup("vault").description)
    .argument("[args...]")
    // The old Files verbs carry their own flags (mirror --on); they reach filesGuard, not a parse error.
    // No options here: commander hands a parent's option to the parent even
    // after a verb, so `cast vault ls --json` would lose its --json.
    .allowUnknownOption()
    .hook("preSubcommand", filesGuard)
    .action(async (args: string[]) => {
      filesGuard();
      const rest = args.filter((a) => a !== "--json");
      if (rest.length) fail(`No vault verb "${rest[0]}": cast vault --help lists them`);
      await list({ json: rest.length < args.length });
    });

  vault
    .command("ls")
    .alias("list")
    .summary("Every secret you can use, open requests first; --stale for the ones that need a look").description(
      "Every secret you can use, open requests first\n\n" +
      "A ready secret that needs a look carries one health word, and --stale lists only those:\n" +
      `  expired     a sign-in whose cookies ran out: save it again with cast vault save-signin\n` +
      `  expiring    a sign-in whose cookies run out within ${SECRET_HEALTH_DAYS.expiring} days\n` +
      `  never used  stored over ${SECRET_HEALTH_DAYS.unused} day ago and never read by an agent\n` +
      `  stale       last read over ${SECRET_HEALTH_DAYS.stale} days ago: still needed, or rm it\n\n` +
      "Example: cast vault ls --stale --json",
    )
    .option("--stale", "Only secrets that need a look: expired, expiring, never used or stale")
    .option(...JSON_OPTION)
    .action(list);

  valueOptions(
    vault
      .command("add")
      .summary("Store a secret. The value comes from a hidden prompt, stdin, --file or --from-env, never an argument").description("Store a secret. The value comes from a hidden prompt, stdin, --file or --from-env, never an argument\n\n" +
        "Under cast vault run a key fills its --env vars (else NAME_UPPER), a login NAME_USERNAME and NAME_PASSWORD, a file the path of its temp file in its --env var (else NAME_UPPER_FILE); add prints the vars.\n\n" +
        "Example: cast vault add stripe-test --env STRIPE_SECRET_KEY --site dashboard.stripe.com\n" +
        totpExample("add github-bot --kind login --username ci-bot"))
      .argument("<name>", "Lowercase slug, like stripe-test")
      .option("--kind <kind>", "key (default), login or file")
      .option("--env <VAR>", "Env var it fills under cast vault run (repeatable; a login takes USER then PASSWORD)", collect, [])
      .option("--site <host>", "Site it is for (repeatable)", collect, [])
      .option("--note <text>", "What it is for"),
  )
    .option(...WRITE_TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (name: string, o: ValueOptions & { kind?: string; env: string[]; site: string[]; note?: string; team?: string; json?: boolean }) => {
      const kind = kindOf(o.kind, ["key", "login", "file"]);
      const where = await writeWhere(deps, o.team);
      const payload = await payloadFor(kind, o);
      const res = await apiPost(deps, "/cli/vault/create", {
        name,
        kind,
        payload,
        ...(o.env.length ? { env: o.env } : {}),
        ...(o.site.length ? { sites: o.site } : {}),
        ...(o.note ? { note: o.note } : {}),
        ...where.body,
      });
      const print = payloadFingerprint(kind, payload);
      const vars = envFor({ name: res.name, kind, env: o.env }).map((b) => b.var);
      emit(o.json, { ...res, fingerprint: print, env_vars: vars }, () => `${fmt.success("stored")} ${fmt.id(res.short_id)} ${res.name} in ${where.label}  ${fmt.muted(`run fills ${vars.join(", ")}`)}${print ? `  ${fmt.muted(print)}` : ""}`);
    });

  valueOptions(
    vault
      .command("rotate")
      .summary("Replace a secret's value; same prompts as add").description("Replace a secret's value; same prompts as add\n\nExample: printf %s \"$NEW_KEY\" | cast vault rotate stripe-test\n" + totpExample("rotate github-bot"))
      .argument("<name>", "Name or sec-N"),
  )
    .option(...JSON_OPTION)
    .action(async (ref: string, o: ValueOptions & { json?: boolean }) => {
      const meta: SecretMeta = await apiPost(deps, "/cli/vault/show", { ref }, { read: true });
      const payload = await payloadFor(meta.kind, o);
      const res = await apiPost(deps, "/cli/vault/rotate", { ref: meta.short_id, payload });
      const print = payloadFingerprint(meta.kind, payload);
      emit(o.json, { ...res, fingerprint: print }, () => `${fmt.success("rotated")} ${fmt.id(res.short_id)} ${res.name}${print ? `  ${fmt.muted(print)}` : ""}`);
    });

  valueOptions(
    vault
      .command("fill")
      .alias("fulfill")
      .summary("Give a requested secret its value; every session that asked is told it is ready").description("Give a requested secret its value; every session that asked is told it is ready\n\nExample: cast vault fill github-bot --username ci-bot\n" + totpExample("fill github-bot --username ci-bot"))
      .argument("<name>", "Name or sec-N of the request"),
  )
    .option(...JSON_OPTION)
    .action(async (ref: string, o: ValueOptions & { json?: boolean }) => {
      const meta: SecretMeta = await apiPost(deps, "/cli/vault/show", { ref, status: "requested" }, { read: true });
      const payload = await payloadFor(meta.kind, o);
      const res = await apiPost(deps, "/cli/vault/fulfill", { ref: meta.short_id, payload });
      emit(o.json, res, () => `${fmt.success("filled")} ${fmt.id(res.short_id)} ${res.name}${res.delivered ? fmt.muted("  the asking sessions were told") : ""}`);
    });

  vault
    .command("get")
    .summary("Print one value raw on stdout, for a pipe or $(…). Never into your own output: prefer cast vault run").description(
      "Print one value raw on stdout, for a pipe or $(…). Never into your own output: prefer cast vault run\n\n" +
      "What it prints, by kind (default first):\n" +
      "  key     value\n" +
      "  login   password; --field username, or --field totp for the current 2FA code (as cast vault otp prints it)\n" +
      "  file    content\n" +
      "A saved sign-in prints nothing: cast browser open loads it. A field the kind lacks is refused.\n\n" +
      `${ASK_FIRST_HELP}\n\nExample: gh auth login --with-token < <(cast vault get github-bot)\nExample: cast vault get github-login --field username`,
    )
    .argument("<name>", "Name or sec-N")
    .option("--field <field>", "value (key), password, username or totp (login), content (file); default: the kind's first")
    .option(...WHY_OPTION)
    .action(async (ref: string, o: { field?: string; why?: string }) => {
      const field = o.field as GetField | undefined;
      if (field && !["value", "username", "password", "totp", "content"].includes(field)) fail("--field takes value, username, password, totp or content");
      const [s] = await readSecrets(deps, [ref], field === "totp" ? "otp" : "get", o.why);
      const refusal = field && getFieldRefusal(s!, field);
      if (refusal) fail(refusal);
      const want = field ?? defaultField(s!.kind);
      let value: string;
      if (want === "totp") value = (await codeFor(s!)).code;
      else {
        const got = want ? fieldValue(s!, want) : fieldValue(s!, "value");
        if ("error" in got) fail(got.error);
        value = got.value;
      }
      process.stdout.write(process.stdout.isTTY && !value.endsWith("\n") ? `${value}\n` : value);
    });

  vault
    .command("run")
    .summary("Run a command with secrets in its env: keys as their env vars, a login as NAME_USERNAME/NAME_PASSWORD, a file as the path of a 0600 temp file in its --env var, else NAME_FILE, removed afterwards. cast vault ls names each secret's vars. The exit code is the command's").description(
      "Run a command with secrets in its env: keys as their env vars, a login as NAME_USERNAME/NAME_PASSWORD, a file as the path of a 0600 temp file in its --env var, else NAME_FILE, removed afterwards. cast vault ls names each secret's vars. The exit code is the command's\n\n" +
      "--env-file loads an env file whose values may be references: vault://<name> (a key's value, a login's password, a file's temp path) or vault://<name>/<field> (value, username, password, content). " +
      "Literal values pass through; every reference is filled from one Vault read, and an unresolved one stops the run with its fix. " +
      "A file that holds only references names secrets and holds no value, so it is safe to commit.\n\n" +
      `${ASK_FIRST_HELP} The command does not start.\n\n` +
      "Example: cast vault run stripe-test staging-db -- npm test\n" +
      "Example: cast vault run --env-file .env.vault -- npm test   (.env.vault: STRIPE_SECRET_KEY=vault://stripe-test)",
    )
    .argument("[names...]", "Names or sec-N, then -- and the command")
    .option("--env-file <path>", "An env file to load, vault:// values filled from the Vault (repeatable; a later file wins a var)")
    .option(...WHY_OPTION)
    .allowUnknownOption()
    .action(async () => {
      const split = splitRunArgs((program as any).rawArgs ?? []);
      if (!split || !split.command.length) fail("Put the command after --: cast vault run stripe-test -- npm test");
      if (split.envFiles.includes("")) fail("--env-file takes a path: cast vault run --env-file .env -- npm test");
      const files = readEnvFiles(split.envFiles.map((p) => path.resolve(cwd(), p)));
      if (files.problems.length) fail(files.problems.join("\n"));
      const referenced = referencedSecrets(files.entries);
      const listMetas = metasOnce(deps);
      if (referenced.length) {
        const gaps = unresolvedRefs(files.entries, await listMetas(), await preferredWorkspace(deps));
        if (gaps.length) fail(`Unresolved vault:// references, so nothing ran:\n${gaps.join("\n")}`);
      }
      const { refs, map } = await refsFor(deps, {
        names: split.names,
        example: "cast vault run stripe-test -- npm test",
        referenced: split.envFiles.length ? referenced : undefined,
        files: true,
        listMetas,
      });
      const secrets = refs.length ? await readSecrets(deps, refs, "run", split.why) : [];
      // An empty map keeps a secret named only in an env file from adding its own env names.
      const m = materialize(secrets, { map: map ?? {}, named: split.names });
      const fromFiles = envFromFiles(files.entries, secrets, m.paths);
      if (fromFiles.problems.length) {
        m.cleanup();
        fail(`Unresolved vault:// references, so nothing ran:\n${fromFiles.problems.join("\n")}`);
      }
      if (m.skipped.length) console.error(fmt.muted(`${m.skipped.join(", ")}: a saved sign-in has no env var; cast browser open uses it`));
      process.exit(await runWith(split.command, { ...m.env, ...fromFiles.env }, m.cleanup));
    });

  vault
    .command("env")
    .summary("Print export NAME='value' lines for eval. A file secret is left out: use cast vault run for it").description(`Print export NAME='value' lines for eval. A file secret is left out: use cast vault run for it\n\n${ASK_FIRST_HELP}\n\nExample: eval "$(cast vault env stripe-test)"`)
    .argument("[names...]", "Names or sec-N")
    .option(...WHY_OPTION)
    .action(async (names: string[], o: { why?: string }) => {
      const { refs, map } = await refsFor(deps, { names, example: "eval \"$(cast vault env stripe-test)\"", files: false, listMetas: metasOnce(deps) });
      const m = materialize(refs.length ? await readSecrets(deps, refs, "env", o.why) : [], { map, named: names, writeFiles: false });
      if (m.skipped.length) console.error(fmt.muted(`left out ${m.skipped.join(", ")}: use cast vault run for files and sign-ins`));
      const out = exportLines(m.env);
      if (out) console.log(out);
    });

  vault
    .command("otp")
    .summary("Print a login's current 2FA code on stdout; the seconds it stays valid go to stderr on a terminal").description(`Print a login's current 2FA code on stdout; the seconds it stays valid go to stderr on a terminal\n\n${ASK_FIRST_HELP}\n\nExample: cast vault otp github-bot`)
    .argument("<name>", "Name or sec-N of a login with a 2FA seed")
    .option(...WHY_OPTION)
    .action(async (ref: string, o: { why?: string }) => {
      const [s] = await readSecrets(deps, [ref], "otp", o.why);
      const { code, remaining } = await codeFor(s!);
      console.log(code);
      if (process.stderr.isTTY) console.error(fmt.muted(`${remaining}s left`));
    });

  vault
    .command("request")
    .summary("Ask a person for a secret you do not have. They fill it from a card in this conversation or on the Vault page, never in chat; a message arrives here when it is ready").description("Ask a person for a secret you do not have. They fill it from a card in this conversation or on the Vault page, never in chat; a message arrives here when it is ready\n\nExample: cast vault request stripe-test --env STRIPE_SECRET_KEY --why \"run the billing tests\"")
    .argument("<name>", "The name it should have, like stripe-test")
    .option("--kind <kind>", "key (default), login, file or signin")
    .option("--env <VAR>", "Env var it should fill (repeatable)", collect, [])
    .option("--site <host>", "Site it is for (repeatable)", collect, [])
    .option("--why <text>", "What you need it for, shown to the person")
    .option(...WRITE_TEAM_OPTION)
    .option(...JSON_OPTION)
    .action(async (name: string, o: { kind?: string; env: string[]; site: string[]; why?: string; team?: string; json?: boolean }) => {
      // Sent only when given: an open request keeps the kind its first asker named.
      const kind = o.kind ? kindOf(o.kind, SECRET_KINDS) : undefined;
      const where = await writeWhere(deps, o.team);
      const convo = conversationOf(deps);
      const res = await apiPost(deps, "/cli/vault/request", {
        name,
        ...(kind ? { kind } : {}),
        ...(o.why ? { why: o.why } : {}),
        ...(o.env.length ? { env: o.env } : {}),
        ...(o.site.length ? { sites: o.site } : {}),
        ...convo,
        ...where.body,
      });
      emit(o.json, res, () => {
        if (res.exists) return res.message;
        const lines = [`${fmt.warning("requested")} ${fmt.id(res.short_id)} ${res.name} in ${where.label}`];
        if (!convo.conversation) lines.push("No session detected, so no conversation will be told: a person fills it on the Vault page");
        else lines.push(
          "A person fills it from the card in this conversation or on the Vault page; a message arrives here when it is ready.",
          `End your turn dormant naming it: cast state --status dormant "Waiting on ${res.short_id} (${res.name}) from the Vault"`,
        );
        return lines.join("\n");
      });
    });

  vault
    .command("save-signin")
    .summary("Save a site's sign-in from the agent browser (or --from-chrome, your own Chrome here); cast browser open then starts every agent signed in").description("Save a site's sign-in from the agent browser (or --from-chrome, your own Chrome here); cast browser open then starts every agent signed in. Saving again replaces it; an open request's name is filled\n\nExample: cast vault save-signin vercel.com")
    .argument("<site>", "Host or URL, like vercel.com")
    .option("--name <name>", "Name it (default: <site>-signin)")
    .option("--from-chrome", "Read the sign-in out of your own Chrome on this machine; a person's terminal only, refused in an agent session")
    .option("--check", "With --from-chrome: count the site's cookies there and store nothing")
    .option(...WRITE_TEAM_OPTION)
    .option("--personal", "Only you can use it")
    .option(...JSON_OPTION)
    .action(async (site: string, o: { name?: string; fromChrome?: boolean; check?: boolean; team?: string; personal?: boolean; json?: boolean }) => {
      const { checkChromeSignin, saveSignin, SigninRefused } = await import("./signinCommand.js");
      try {
        if (o.check) {
          if (!o.fromChrome) throw new SigninRefused("--check reads your own Chrome: pass --from-chrome too");
          const res = checkChromeSignin(site);
          return console.log(o.json ? JSON.stringify(res) : res.cookies ? `${res.cookies} cookies for ${res.host}${res.account_hint ? `, signed in as ${res.account_hint}` : ""}` : `Chrome here is not signed in to ${res.host}`);
        }
        const where = await writeWhere(deps, o.personal ? "personal" : o.team);
        const res = await saveSignin(deps, site, { name: o.name, where: where.body, fromChrome: o.fromChrome });
        // One compact line under --json: the daemon reads the outcome from the last line of stdout.
        console.log(o.json ? JSON.stringify(res) : `${fmt.success(res.action)} ${fmt.id(res.short_id)} ${res.name} in ${where.label}  ${fmt.muted(`${res.cookies} cookies for ${res.host}${res.account_hint ? `, signed in as ${res.account_hint}` : ""}`)}`);
      } catch (err) {
        if (!(err instanceof SigninRefused)) throw err;
        if (o.json) console.log(JSON.stringify({ ok: false, reason: err.message }));
        fail(err.message);
      }
    });

  vault
    .command("show")
    .summary("A secret's details and recent use, by whom and from which session; never its value").description("A secret's details and recent use, by whom and from which session; never its value\n\nExample: cast vault show stripe-test")
    .argument("<name>", "Name or sec-N")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { json?: boolean }) => {
      const meta: SecretMeta = await apiPost(deps, "/cli/vault/show", { ref }, { read: true });
      const events: SecretEvent[] = await apiPost(deps, "/cli/vault/events", { ref: meta.short_id }, { read: true });
      if (o.json) return emit(true, { ...meta, events }, () => "");
      const scope = await scopeNamer(deps, [meta]);
      console.log(formatShow(meta, scope(meta), events));
    });

  vault
    .command("rm")
    .alias("remove")
    .summary("Delete a secret. Asks on a terminal; pass --yes otherwise. Its activity stays").description("Delete a secret. Asks on a terminal; pass --yes otherwise. Its activity stays\n\nExample: cast vault rm old-key --yes")
    .argument("<name>", "Name or sec-N")
    .option("--yes", "Delete without asking")
    .option(...JSON_OPTION)
    .action(async (ref: string, o: { yes?: boolean; json?: boolean }) => {
      if (!(await confirmed(o, `Delete ${ref} for everyone who uses it?`, `Deleting ${ref} cannot be undone. Re-run with --yes: cast vault rm ${ref} --yes`))) return console.log("Kept");
      const res = await apiPost(deps, "/cli/vault/rm", { ref });
      emit(o.json, res, () => `${fmt.success("deleted")} ${fmt.id(res.short_id)} ${res.name}`);
    });

  vault
    .command("restore")
    .summary("Put back a value that rotate replaced in the last 7 days. With no version, list them").description("Put back a value that rotate replaced in the last 7 days. With no version, list them: when each was replaced, by whom, its fingerprint. Restoring swaps, so the value it replaces can be put back the same way. Asks on a terminal; pass --yes otherwise\n\nExample: cast vault restore stripe-test\nExample: cast vault restore stripe-test 1 --yes")
    .argument("<name>", "Name or sec-N")
    .argument("[version]", "Its number in the list (1 is the newest), or its rotated_at")
    .option("--yes", "Restore without asking")
    .option(...JSON_OPTION)
    .action(async (ref: string, version: string | undefined, o: { yes?: boolean; json?: boolean }) => {
      const meta: SecretMeta = await apiPost(deps, "/cli/vault/show", { ref }, { read: true });
      const versions: SecretVersionMeta[] = await apiPost(deps, "/cli/vault/versions", { ref: meta.short_id }, { read: true });
      if (version === undefined) {
        if (o.json) return emit(true, versions, () => "");
        return console.log(versions.length ? formatVersions(meta.name, versions) : `${meta.name} has no earlier value: rotate keeps the one it replaces for 7 days`);
      }
      const ver = pickVersion(versions, version);
      if (!ver) fail(`${meta.name} has no version ${version}: cast vault restore ${meta.name} lists them`);
      const what = `the value replaced ${ago(ver.rotated_at)}${ver.fingerprint ? ` (${ver.fingerprint})` : ""}`;
      if (!(await confirmed(o, `Put back ${what} as ${meta.name} for everyone who uses it?`, `Restoring changes ${meta.name} for everyone who uses it. Re-run with --yes: cast vault restore ${meta.name} ${version} --yes`))) return console.log("Kept");
      const res = await apiPost(deps, "/cli/vault/restore", { ref: meta.short_id, version: ver._id });
      emit(o.json, res, () => `${fmt.success("restored")} ${fmt.id(res.short_id)} ${res.name}  ${fmt.muted(`${what}; the value it replaced is now version 1`)}`);
    });

  vault
    .command("ask-first")
    .summary("Turn Ask first on: an agent's read waits on a person's approval, once per session. Only a person turns it off, on the Vault page").description("Turn Ask first on: an agent's read waits on a person's approval, once per session. Only a person turns it off, on the Vault page, since this CLI's token is the one the gated agent holds\n\nExample: cast vault ask-first stripe-live on")
    .argument("<name>", "Name or sec-N")
    .argument("<on>", "on (off is refused here: a person turns it off on the Vault page)")
    .option(...JSON_OPTION)
    .action(async (ref: string, state: string, o: { json?: boolean }) => {
      if (state === "off") fail(`Only a person turns Ask first off: switch it off in ${ref}'s panel on the Vault page`);
      if (state !== "on") fail(`Ask first takes on: cast vault ask-first ${ref} on`);
      const res = await apiPost(deps, "/cli/vault/ask-first", { ref, ask_first: true });
      emit(o.json, res, () => `${fmt.success("ask first on")} ${fmt.id(res.short_id)} ${res.name}${fmt.muted("  each session's read waits on a person's approval")}`);
    });
}

async function codeFor(s: ReadSecret): Promise<{ code: string; remaining: number }> {
  const seed = s.kind === "login" ? (s.payload as LoginPayload).totp_seed : undefined;
  if (!seed) fail(`${s.name} has no 2FA seed: add one with cast vault rotate ${s.name} --totp`);
  try {
    return await totp(seed);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
