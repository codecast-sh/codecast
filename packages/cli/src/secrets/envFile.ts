// `vault://<name>` and `vault://<name>/<field>` as values in an env file
// (docs/architecture/vault.md, Second round). `cast vault run --env-file`
// loads the files, passes literal values through, and fills each reference
// from the one Vault read the command makes. A file of references names
// secrets and holds no value, so it is safe to commit.
import * as fs from "node:fs";
import { secretNameProblem, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { parseDotenv } from "../knownValueRedaction.js";
import { fieldValue, type GetField, type ReadSecret } from "./inject.js";
import { gapLine, metaFor } from "./projectMap.js";

export type RefField = Exclude<GetField, "totp">;
export type EnvRef = { secret: string; field?: RefField };
export type EnvEntry = { literal: string } | { ref: EnvRef };

const PREFIX = "vault://";

const REF_FIELDS: readonly string[] = ["value", "username", "password", "content"] satisfies RefField[];
/** The fields a reference may name on each kind; a sign-in fills no env var. */
const FIELDS: Record<SecretKind, readonly RefField[]> = { key: ["value"], login: ["username", "password"], file: ["content"], signin: [] };

/** A value's reference, null for a literal, or the sentence saying what is wrong with it. */
export function parseVaultRef(value: string): EnvRef | { error: string } | null {
  if (!value.startsWith(PREFIX)) return null;
  const [secret = "", field, ...extra] = value.slice(PREFIX.length).split("/");
  if (extra.length || field === "" || secretNameProblem(secret) !== null) {
    return { error: `${value} is not a reference: write vault://<name> or vault://<name>/<field>, with the secret's name` };
  }
  if (field === undefined) return { secret };
  if (!REF_FIELDS.includes(field)) {
    return { error: `${value} names no field ${field}: use ${REF_FIELDS.join(", ")}` };
  }
  return { secret, field: field as RefField };
}

/**
 * The env files in order, a later line or file winning a var. Nothing is
 * read from the Vault here; `problems` names each unreadable file and
 * malformed reference.
 */
export function readEnvFiles(paths: readonly string[], readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8")): { entries: Map<string, EnvEntry>; problems: string[] } {
  const entries = new Map<string, EnvEntry>();
  const problems: string[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = readFile(p);
    } catch {
      problems.push(`Cannot read ${p}: pass the path of a readable env file`);
      continue;
    }
    for (const [name, value] of parseDotenv(text)) {
      const ref = parseVaultRef(value);
      if (ref && "error" in ref) problems.push(`${name}: ${ref.error}`);
      else entries.set(name, ref ? { ref } : { literal: value });
    }
  }
  return { entries, problems };
}

const refs = (entries: Map<string, EnvEntry>): Array<[string, EnvRef]> =>
  [...entries].flatMap(([v, e]) => ("ref" in e ? [[v, e.ref] as [string, EnvRef]] : []));

/** The secrets the references name, for the one read. */
export function referencedSecrets(entries: Map<string, EnvEntry>): string[] {
  return [...new Set(refs(entries).map(([, r]) => r.secret))];
}

/**
 * Each reference the Vault cannot fill, with the command that fixes it,
 * judged from list metadata before any read. A name resolves the way the
 * read will (metaFor, with the repo's `prefer`), so the two never disagree.
 */
export function unresolvedRefs(entries: Map<string, EnvEntry>, metas: Pick<SecretMeta, "name" | "short_id" | "status" | "kind" | "workspace">[], prefer?: string): string[] {
  const out: string[] = [];
  for (const [envVar, { secret, field }] of refs(entries)) {
    const meta = metaFor(metas, secret, prefer);
    if (meta && "line" in meta) out.push(`${envVar}: ${meta.line}`);
    else if (!meta || meta.status !== "ready" || meta.kind === "signin") out.push(gapLine(envVar, secret, meta));
    else if (field && !FIELDS[meta.kind].includes(field)) {
      out.push(`${envVar}: ${secret} is a ${meta.kind}, which has no ${field}. Use ${FIELDS[meta.kind].map((f) => `${PREFIX}${secret}/${f}`).join(" or ")}`);
    }
  }
  return out;
}

/**
 * The env the files give: literals as written, each reference filled from
 * the read secrets: without a field, a key's value, a login's password or a
 * file secret's temp path (from `paths`). `problems` names a reference whose
 * secret has no such value, with its fix.
 */
export function envFromFiles(entries: Map<string, EnvEntry>, secrets: readonly ReadSecret[], paths: ReadonlyMap<string, string>): { env: Record<string, string>; problems: string[] } {
  const byName = new Map(secrets.map((s) => [s.name, s]));
  const env: Record<string, string> = {};
  const problems: string[] = [];
  for (const [envVar, e] of entries) {
    if ("literal" in e) {
      env[envVar] = e.literal;
      continue;
    }
    const s = byName.get(e.ref.secret);
    const got = !s ? { error: `${e.ref.secret} was not read` }
      : e.ref.field ? fieldValue(s, e.ref.field)
      : s.kind === "file" ? (paths.has(s.name) ? { value: paths.get(s.name)! } : { error: `${s.name} is a file secret with no temp file` })
      : fieldValue(s, s.kind === "login" ? "password" : "value");
    if ("value" in got) env[envVar] = got.value;
    else problems.push(`${envVar}: ${got.error}`);
  }
  return { env, problems };
}
