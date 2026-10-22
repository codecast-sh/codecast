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
import * as readline from "node:readline";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { fmt } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { JSON_OPTION, ago, collect, emit, fail } from "../externalDataCli.js";
import { promptHiddenSecret } from "../hiddenSecret.js";
import { lineDefaults } from "../lineScope.js";
import { loadWorkspaceRoster, resolveWorkspaceForWrite, workspaceLabel } from "../resolveWorkspace.js";
import { readStdinBody } from "../sendBody.js";
import {
  SECRET_KINDS,
  payloadFingerprint,
  totp,
  validatePayload,
  type LoginPayload,
  type SecretKind,
  type SecretMeta,
  type SecretPayload,
  type SecretReadPurpose,
} from "@codecast/shared/contracts/secrets";
import {
  argsAfterGroup,
  defaultField,
  exportLines,
  fieldValue,
  filesCommandFor,
  materialize,
  readPayload,
  runWith,
  splitRunArgs,
  type GetField,
  type ReadSecret,
  type ValueIO,
  type ValueOptions,
} from "./inject.js";
import { envToSecret, gapLine, projectVault, varsBySecret, type VaultMap } from "./projectMap.js";

const WRITE_TEAM_OPTION = ["--team <name|id|personal>", "Where it goes (default: the repo profile's team, else your active team, else personal)"] as const;
const cwd = () => process.env.CODECAST_CWD || process.cwd();

function terminalIO(): ValueIO {
  const tty = !!process.stdin.isTTY;
  return {
    tty,
    hidden: async (prompts) => {
      if (!tty) {
        const lines = readStdinBody().split("\n");
        return prompts.map((_, i) => (lines[i] ?? "").trim());
      }
      const out: string[] = [];
      for (const p of prompts) out.push(await promptHiddenSecret(p));
      return out;
    },
    ask: (q) => question(q),
    stdin: () => readStdinBody(),
    env: process.env,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };
}

function question(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => (rl.close(), resolve(a))));
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

async function readSecrets(deps: PublishDeps, refs: string[], purpose: SecretReadPurpose): Promise<ReadSecret[]> {
  const res = await apiPost(deps, "/cli/vault/read", { refs, purpose, ...conversationOf(deps) });
  return res.secrets;
}

/** This checkout's [vault], with a broken manifest reported as the line it names. */
function projectMap(): VaultMap | null {
  try {
    return projectVault(cwd());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** The names given plus the project's [vault] map (names win in materialize), else a refusal that shows the form. */
function refsFor(names: string[], example: string): { refs: string[]; map: Record<string, string> | null } {
  const project = projectMap();
  const map = project && envToSecret(project);
  if (!names.length && !map) fail(`Name the secrets, or map them in .codecast/workspace.toml under [vault]: ${example}`);
  return { refs: [...new Set([...names, ...Object.values(map ?? {})])], map };
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
    .option("--totp", "A login's 2FA: prompts, hidden, for the setup key or otpauth:// link")
    .option("--file <path>", "A file secret's content, read from this path")
    .option("--from-env <VAR>", "Take the value (a login's password) from this environment variable");

const kindOf = (raw: string | undefined, allowed: readonly SecretKind[]): SecretKind => {
  const kind = (raw ?? "key") as SecretKind;
  if (!allowed.includes(kind)) fail(`--kind takes ${allowed.join(", ")}`);
  return kind;
};

// ── Lines ───────────────────────────────────────────────────────────────────

const session = (id: string | undefined) => (id ? id.slice(0, 7) : undefined);

function bindingOf(s: SecretMeta): string {
  if (s.env?.length) return s.env.join(",");
  if (s.sites?.length) return s.sites.join(",");
  return "";
}

/** One list row; `projectVars` are the env vars this checkout's [vault] fills from it. */
export function formatSecretLine(s: SecretMeta, scope: string, now: number = Date.now(), projectVars?: string[]): string {
  const project = projectVars?.length ? fmt.highlight(`project ${projectVars.join(",")}`) : "";
  if (s.status === "requested") {
    const who = s.requested_by_name ? ` by ${s.requested_by_name}` : "";
    const from = s.requested_from_conversation ? ` from ${session(s.requested_from_conversation)}` : "";
    return [fmt.id(s.short_id), fmt.warning("requested"), s.name, s.kind, bindingOf(s), project, fmt.muted(scope), fmt.muted(`asked${who}${from}${s.request_why ? `: ${s.request_why}` : ""}`)].filter(Boolean).join("  ");
  }
  const used = s.last_used_at ? `used ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : "never used";
  return [fmt.id(s.short_id), s.name, s.kind, bindingOf(s), project, fmt.muted(scope), fmt.muted(used)].filter(Boolean).join("  ");
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

type SecretEvent = { kind: string; at: number; purpose?: string; actor_name?: string; session_short_id?: string; session_title?: string };

export function formatShow(s: SecretMeta, scope: string, events: SecretEvent[], now: number = Date.now()): string {
  const row = (label: string, value: string | undefined) => (value ? `  ${fmt.label(label.padEnd(12))}${value}` : null);
  const lines = [
    `${fmt.id(s.short_id)}  ${fmt.highlight(s.name)}  ${s.kind}  ${fmt.muted(scope)}${s.status === "requested" ? `  ${fmt.warning("requested")}` : ""}`,
    row("env", s.env?.join(", ")),
    row("sites", s.sites?.join(", ")),
    row("fingerprint", s.fingerprint),
    row("note", s.note),
    row("asked", s.status === "requested" ? `${s.requested_by_name ?? "someone"}${s.request_why ? `: ${s.request_why}` : ""}` : undefined),
    row("created", `${ago(s.created_at, now)}${s.created_by_name ? ` by ${s.created_by_name}` : ""}${s.rotated_at ? `, rotated ${ago(s.rotated_at, now)}` : ""}`),
    row("used", s.last_used_at ? `${s.use_count ?? 0}x, last ${ago(s.last_used_at, now)}${s.last_used_by_conversation ? ` by ${session(s.last_used_by_conversation)}` : ""}` : "never"),
  ].filter((l): l is string => l !== null);
  if (events.length) {
    lines.push("", fmt.label("activity"));
    for (const e of events.slice(0, 15)) {
      const what = e.purpose ? `${e.kind} (${e.purpose})` : e.kind;
      const where = e.session_short_id ? `  ${e.session_short_id}${e.session_title ? ` ${fmt.muted(e.session_title)}` : ""}` : "";
      lines.push(`  ${fmt.muted(ago(e.at, now).padEnd(10))}${what.padEnd(16)}${e.actor_name ?? ""}${where}`);
    }
  }
  return lines.join("\n");
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerVaultCommand(program: Command, deps: PublishDeps): void {
  const filesGuard = () => {
    const files = filesCommandFor(argsAfterGroup((program as any).rawArgs ?? []));
    if (files) fail(`Files moved: ${files}`);
  };

  const list = async (o: { json?: boolean }) => {
    const rows: SecretMeta[] = await apiPost(deps, "/cli/vault/list", {}, { read: true });
    const map = projectMap();
    const uses = map ? varsBySecret(map) : new Map<string, string[]>();
    if (o.json) return emit(true, rows.map((r) => (uses.has(r.name) ? { ...r, project_env: uses.get(r.name) } : r)), () => "");
    const missing = map ? unmappedLines(map, rows) : [];
    if (!rows.length && !missing.length) return console.log("The vault is empty. Store a key: cast vault add stripe-test --env STRIPE_SECRET_KEY");
    const scope = await scopeNamer(deps, rows);
    console.log([...rows.map((s) => formatSecretLine(s, scope(s), Date.now(), uses.get(s.name))), ...missing].join("\n"));
  };

  const vault = program
    .command("vault")
    .alias("secrets")
    .description(commandGroup("vault").description)
    .argument("[args...]")
    .option(...JSON_OPTION)
    // The old Files verbs carry their own flags (mirror --on); they reach filesGuard, not a parse error.
    .allowUnknownOption()
    .hook("preSubcommand", filesGuard)
    .action(async (args: string[], o: { json?: boolean }) => {
      filesGuard();
      if (args.length) fail(`No vault verb "${args[0]}": cast vault --help lists them`);
      await list(o);
    });

  vault
    .command("ls")
    .alias("list")
    .summary("Every secret you can use, open requests first").description("Every secret you can use, open requests first\n\nExample: cast vault ls --json")
    .option(...JSON_OPTION)
    .action(list);

  valueOptions(
    vault
      .command("add")
      .summary("Store a secret. The value comes from a hidden prompt, stdin, --file or --from-env, never an argument").description("Store a secret. The value comes from a hidden prompt, stdin, --file or --from-env, never an argument\n\nExample: cast vault add stripe-test --env STRIPE_SECRET_KEY --site dashboard.stripe.com")
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
      emit(o.json, { ...res, fingerprint: print }, () => `${fmt.success("stored")} ${fmt.id(res.short_id)} ${res.name} in ${where.label}${print ? `  ${fmt.muted(print)}` : ""}`);
    });

  valueOptions(
    vault
      .command("rotate")
      .summary("Replace a secret's value; same prompts as add").description("Replace a secret's value; same prompts as add\n\nExample: printf %s \"$NEW_KEY\" | cast vault rotate stripe-test")
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
      .summary("Give a requested secret its value; the session that asked is told it is ready").description("Give a requested secret its value; the session that asked is told it is ready\n\nExample: cast vault fill github-bot --username ci-bot")
      .argument("<name>", "Name or sec-N of the request"),
  )
    .option(...JSON_OPTION)
    .action(async (ref: string, o: ValueOptions & { json?: boolean }) => {
      const meta: SecretMeta = await apiPost(deps, "/cli/vault/show", { ref }, { read: true });
      const payload = await payloadFor(meta.kind, o);
      const res = await apiPost(deps, "/cli/vault/fulfill", { ref: meta.short_id, payload });
      emit(o.json, res, () => `${fmt.success("filled")} ${fmt.id(res.short_id)} ${res.name}${res.delivered ? fmt.muted("  the asking session was told") : ""}`);
    });

  vault
    .command("get")
    .summary("Print one value raw on stdout, for a pipe or $(…). Never into your own output: prefer cast vault run").description("Print one value raw on stdout, for a pipe or $(…). Never into your own output: prefer cast vault run\n\nExample: gh auth login --with-token < <(cast vault get github-bot)")
    .argument("<name>", "Name or sec-N")
    .option("--field <field>", "value, username, password, totp or content (default: the kind's one value)")
    .action(async (ref: string, o: { field?: string }) => {
      const field = o.field as GetField | undefined;
      if (field && !["value", "username", "password", "totp", "content"].includes(field)) fail("--field takes value, username, password, totp or content");
      const [s] = await readSecrets(deps, [ref], field === "totp" ? "otp" : "get");
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
    .summary("Run a command with secrets in its env: keys as their env vars, a login as NAME_USERNAME/NAME_PASSWORD, a file as the path of a 0600 temp file removed afterwards. The exit code is the command's").description("Run a command with secrets in its env: keys as their env vars, a login as NAME_USERNAME/NAME_PASSWORD, a file as the path of a 0600 temp file removed afterwards. The exit code is the command's\n\nExample: cast vault run stripe-test staging-db -- npm test")
    .argument("[names...]", "Names or sec-N, then -- and the command")
    .allowUnknownOption()
    .action(async () => {
      const split = splitRunArgs((program as any).rawArgs ?? []);
      if (!split || !split.command.length) fail("Put the command after --: cast vault run stripe-test -- npm test");
      const { refs, map } = refsFor(split.names, "cast vault run stripe-test -- npm test");
      const secrets = await readSecrets(deps, refs, "run");
      const m = materialize(secrets, { map, named: split.names });
      if (m.skipped.length) console.error(fmt.muted(`${m.skipped.join(", ")}: a saved sign-in has no env var; cast browser open uses it`));
      process.exit(await runWith(split.command, m.env, m.cleanup));
    });

  vault
    .command("env")
    .summary("Print export NAME='value' lines for eval. A file secret is left out: use cast vault run for it").description("Print export NAME='value' lines for eval. A file secret is left out: use cast vault run for it\n\nExample: eval \"$(cast vault env stripe-test)\"")
    .argument("[names...]", "Names or sec-N")
    .action(async (names: string[]) => {
      const { refs, map } = refsFor(names, "eval \"$(cast vault env stripe-test)\"");
      const m = materialize(await readSecrets(deps, refs, "env"), { map, named: names, writeFiles: false });
      if (m.skipped.length) console.error(fmt.muted(`left out ${m.skipped.join(", ")}: use cast vault run for files and sign-ins`));
      const out = exportLines(m.env);
      if (out) console.log(out);
    });

  vault
    .command("otp")
    .summary("Print a login's current 2FA code on stdout; the seconds it stays valid go to stderr on a terminal").description("Print a login's current 2FA code on stdout; the seconds it stays valid go to stderr on a terminal\n\nExample: cast vault otp github-bot")
    .argument("<name>", "Name or sec-N of a login with a 2FA seed")
    .action(async (ref: string) => {
      const [s] = await readSecrets(deps, [ref], "otp");
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
      const kind = kindOf(o.kind, SECRET_KINDS);
      const where = await writeWhere(deps, o.team);
      const convo = conversationOf(deps);
      const res = await apiPost(deps, "/cli/vault/request", {
        name,
        kind,
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
    .option("--from-chrome", "Read the sign-in out of your own Chrome on this machine")
    .option(...WRITE_TEAM_OPTION)
    .option("--personal", "Only you can use it")
    .option(...JSON_OPTION)
    .action(async (site: string, _opts: object, cmd: Command) => {
      // `vault` itself takes --json too, and commander hands it to the parent.
      const o = cmd.optsWithGlobals() as { name?: string; fromChrome?: boolean; team?: string; personal?: boolean; json?: boolean };
      const { saveSignin, SigninRefused } = await import("./signinCommand.js");
      const where = await writeWhere(deps, o.personal ? "personal" : o.team);
      try {
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
      if (!o.yes) {
        if (!process.stdin.isTTY) fail(`Deleting ${ref} cannot be undone. Re-run with --yes: cast vault rm ${ref} --yes`);
        const answer = await question(`Delete ${ref} for everyone who uses it? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) return console.log("Kept");
      }
      const res = await apiPost(deps, "/cli/vault/rm", { ref });
      emit(o.json, res, () => `${fmt.success("deleted")} ${fmt.id(res.short_id)} ${res.name}`);
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
