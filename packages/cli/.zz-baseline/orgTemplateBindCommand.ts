// The daemon's half of the web's host step for a role hired from a template
// (docs/architecture/org-hire.md H3, H4): an `org_template_bind` command
// carries the instance, its checkout and the secrets a person typed, each
// sealed to this device's provider-key public key. The daemon decrypts every
// secret into a 0600 file of its own, then runs the very command a person
// would at the terminal, `cast org template bind`, with `--secret key=path`.
// The value therefore reaches the server only as ciphertext this device alone
// can open, and the CLI's own rule (a path recorded by hash, contents never
// leaving the machine) holds unchanged. Pure w.r.t. the runner and the config
// dir, so the whole path is unit tested without a daemon.
import * as fs from "node:fs";
import * as path from "node:path";
import { ORG_TEMPLATE_SECRETS_DIR, type OrgTemplateBindArgs, type OrgTemplateBindResult } from "@codecast/shared/contracts/orgTemplateBind";
import { decryptProviderKeyPayload } from "./providerKeyCrypto.js";
import { atomicWriteFile } from "./atomicWrite.js";

export type CastRunner = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const slug = /^[a-z][a-z0-9-]{0,47}$/;
const inputKey = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** Parse the command's args, refusing anything the CLI would not accept as its own arguments. */
export function parseBindArgs(argsJson: string | undefined): OrgTemplateBindArgs {
  let parsed: any;
  try { parsed = argsJson ? JSON.parse(argsJson) : {}; } catch { throw new Error("org_template_bind: bad JSON args"); }
  if (typeof parsed.instance !== "string" || !slug.test(parsed.instance)) throw new Error("org_template_bind: instance must be a slug");
  if (typeof parsed.instance_key !== "string" || !parsed.instance_key) throw new Error("org_template_bind: missing instance_key");
  if (typeof parsed.dir !== "string" || !path.isAbsolute(parsed.dir)) throw new Error("org_template_bind: dir must be an absolute path");
  const ws = parsed.workspace;
  if (!ws || (ws.kind !== "team" && ws.kind !== "user") || typeof ws.id !== "string" || !ws.id) throw new Error("org_template_bind: workspace must name a team or a user");
  const secrets = Array.isArray(parsed.secrets) ? parsed.secrets : [];
  for (const s of secrets) {
    if (typeof s?.key !== "string" || !inputKey.test(s.key)) throw new Error("org_template_bind: a secret's key is not an input key");
    if (!s.payload || typeof s.payload.epk !== "string" || typeof s.payload.iv !== "string" || typeof s.payload.ct !== "string") throw new Error(`org_template_bind: secret ${s.key} is not sealed`);
  }
  return { instance_key: parsed.instance_key, instance: parsed.instance, dir: parsed.dir, workspace: { kind: ws.kind, id: ws.id }, secrets };
}

/** Where this device keeps the secret files it received for an instance. */
export function secretsDir(configDir: string, instance: string): string {
  return path.join(configDir, ORG_TEMPLATE_SECRETS_DIR, instance);
}

/**
 * Run the host step. Every secret is decrypted and written (0600, in a 0700
 * directory) before the CLI runs, so a bad payload fails the whole command
 * without a half bound instance; the CLI then records each path by hash.
 * On a CLI failure the last lines of its stderr are the error a person reads
 * on the role page. Nothing here logs a secret's value.
 */
export async function runOrgTemplateBind(configDir: string, argsJson: string | undefined, runCast: CastRunner): Promise<OrgTemplateBindResult> {
  const args = parseBindArgs(argsJson);
  const dirStat = fs.statSync(args.dir, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory()) throw new Error(`The project checkout ${args.dir} is not on this machine`);
  const paths: Record<string, string> = {};
  if (args.secrets.length) {
    const dir = secretsDir(configDir, args.instance);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    for (const s of args.secrets) {
      let value: string;
      try { value = decryptProviderKeyPayload(configDir, s.payload); }
      catch (err) { throw new Error(`Secret ${s.key} could not be opened on this machine (${err instanceof Error ? err.message : String(err)}); it was sealed to another device's key`); }
      if (!value) throw new Error(`Secret ${s.key} is empty`);
      const file = path.join(dir, s.key.replace(/[^a-z0-9_.-]/gi, "_"));
      atomicWriteFile(file, value, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      paths[s.key] = file;
    }
  }
  const cli = ["org", "template", "bind", args.instance, "--dir", args.dir, ...(args.workspace.kind === "team" ? ["--team", args.workspace.id] : ["--personal"]), "--json"];
  for (const [key, file] of Object.entries(paths)) cli.push("--secret", `${key}=${file}`);
  const res = await runCast(cli);
  if (res.code !== 0) {
    // The CLI's own sentence when it printed one, else the last lines it wrote.
    const lines = (res.stderr || res.stdout).trim().split("\n").filter(Boolean);
    const said = [...lines].reverse().find((l) => /^error:/i.test(l));
    const tail = said ? said.replace(/^error:\s*/i, "") : lines.slice(-6).join("\n");
    throw new Error(tail || `cast org template bind exited ${res.code}`);
  }
  let receipt: any = {};
  try { receipt = JSON.parse(res.stdout); } catch { /* the CLI printed something else; the phase below says so */ }
  return { instance: args.instance, phase: typeof receipt.phase === "string" ? receipt.phase : "unknown", bound: Object.keys(paths), ...(receipt.host?.machine ? { host: receipt.host.machine } : {}) };
}
