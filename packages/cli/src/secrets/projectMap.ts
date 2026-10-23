// A project's [vault] (.codecast/workspace.toml, checked in workspace/manifest.ts):
// which env vars come from which Vault secrets, so the repo keeps no .env on
// disk. `cast vault run` and `env` with no names use it, `cast vault ls` marks
// what it uses, and `cast dev` starts servers with it (docs/architecture/vault.md).
import * as fs from "node:fs";
import * as path from "node:path";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { apiPost, type PublishDeps } from "../castApi.js";
import { MANIFEST_REL_PATH, parseManifest } from "../workspace/manifest.js";
import type { VaultBinding } from "../workspace/types.js";
import { approvalLines, isNeedsApproval } from "./approval.js";
import { materialize, type ReadSecret } from "./inject.js";

export type VaultMap = Record<string, VaultBinding>;

/**
 * The [vault] of the checkout holding `cwd`, or null when it maps nothing.
 * The walk stops at the repo root, so a stray manifest above it never applies.
 * A malformed manifest throws its ManifestError, which names the bad line.
 */
export function projectVault(cwd: string): VaultMap | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, MANIFEST_REL_PATH);
    if (fs.existsSync(file)) {
      const vault = parseManifest(file)?.vault;
      return vault && Object.keys(vault).length ? vault : null;
    }
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return null;
  }
}

/** ENV_VAR → secret name, the shape `materialize` takes. */
export function envToSecret(map: VaultMap): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([v, b]) => [v, b.secret]));
}

/** The env vars each mapped secret fills, keyed by secret name (for `cast vault ls`). */
export function varsBySecret(map: VaultMap): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [v, b] of Object.entries(map)) out.set(b.secret, [...(out.get(b.secret) ?? []), v]);
  return out;
}

/** A mapped var with no value to give, and the command that fixes it. */
export type VaultGap = { envVar: string; secret: string; required: boolean; line: string };

/** What the fix is for a secret that is absent (null) or still a request. */
export function gapLine(envVar: string, secret: string, meta: Pick<SecretMeta, "short_id" | "status" | "kind"> | null): string {
  if (!meta) return `${envVar}: no secret ${secret} in your Vault. Ask for it: cast vault request ${secret} --env ${envVar}`;
  if (meta.status === "requested") return `${envVar}: ${secret} (${meta.short_id}) is requested and has no value yet. Fill it on the Vault page or with cast vault fill ${secret}`;
  return `${envVar}: ${secret} is a ${meta.kind}, which fills no env var`;
}

/**
 * Split a project's map against what the Vault holds: the names worth
 * reading, and a gap for every var that cannot be filled. A file secret is a
 * gap too, since a server outlives any temp file cast could clean up.
 */
export function planProjectRead(map: VaultMap, metas: Pick<SecretMeta, "name" | "short_id" | "status" | "kind">[]): { read: string[]; gaps: VaultGap[] } {
  const byName = new Map(metas.map((m) => [m.name, m]));
  const read = new Set<string>();
  const gaps: VaultGap[] = [];
  for (const [envVar, { secret, required }] of Object.entries(map)) {
    const meta = byName.get(secret) ?? null;
    if (meta?.status === "ready" && meta.kind === "file") {
      gaps.push({ envVar, secret, required, line: `${envVar}: ${secret} is a file secret; cast dev leaves it out, cast vault run puts it in a temp file` });
    } else if (meta?.status === "ready" && meta.kind !== "signin") read.add(secret);
    else gaps.push({ envVar, secret, required, line: gapLine(envVar, secret, meta) });
  }
  return { read: [...read], gaps };
}

/**
 * The env a project's servers start with: one metadata list, then one read
 * of the ready secrets (recorded against this session, purpose run). Values
 * stay in the returned object; gaps carry only names. A read Ask first holds
 * throws the decision to wait on.
 */
export async function loadProjectEnv(deps: PublishDeps, map: VaultMap, conversation?: string): Promise<{ env: Record<string, string>; gaps: VaultGap[] }> {
  const metas: SecretMeta[] = await apiPost(deps, "/cli/vault/list", {}, { read: true, exitOnError: false });
  const { read, gaps } = planProjectRead(map, metas);
  if (!read.length) return { env: {}, gaps };
  const res = await apiPost(deps, "/cli/vault/read", { refs: read, purpose: "run", ...(conversation ? { conversation } : {}) }, { exitOnError: false });
  // Ask first held the whole read: no value for any var, and the decision to wait on.
  if (isNeedsApproval(res)) throw new Error(approvalLines(res).join(" "));
  const m = materialize(res.secrets as ReadSecret[], { map: envToSecret(map), writeFiles: false });
  return { env: m.env, gaps };
}
