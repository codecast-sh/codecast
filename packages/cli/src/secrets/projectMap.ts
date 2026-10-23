// A project's [vault] (.codecast/workspace.toml, checked in workspace/manifest.ts):
// which env vars come from which Vault secrets, so the repo keeps no .env on
// disk. `cast vault run` and `env` with no names read its ready part, `cast vault ls` marks
// what it uses, and `cast dev` starts servers with it (docs/architecture/vault.md).
import * as fs from "node:fs";
import * as path from "node:path";
import { ambiguousSecretName, pickSecretByName, type SecretMeta, type SecretNeedsApproval } from "@codecast/shared/contracts/secrets";
import { apiPost, type PublishDeps } from "../castApi.js";
import { lineDefaults } from "../lineScope.js";
import { loadWorkspaceRoster, resolveWorkspaceForRead } from "../resolveWorkspace.js";
import { MANIFEST_REL_PATH, parseManifest } from "../workspace/manifest.js";
import type { VaultBinding } from "../workspace/types.js";
import { isNeedsApproval } from "./approval.js";
import { materialize, type Materialized, type ReadSecret } from "./inject.js";
import { refreshDaemonRedaction } from "./redactionSource.js";

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

/**
 * The workspace key (`team:<id>`, `user:<id>`) whose secret a name held in
 * several workspaces means in this checkout: the repo profile's team. Sent
 * as `prefer` with every read, and given to the planners below, so the CLI
 * and the backend pick the same row (pickSecretByName). Undefined without a
 * profile team, or when the roster cannot be fetched.
 */
export async function preferredWorkspace(deps: PublishDeps): Promise<string | undefined> {
  const team = lineDefaults().team;
  if (!team) return undefined;
  try {
    const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true, exitOnError: false }));
    const ws = resolveWorkspaceForRead(roster, team);
    return ws.kind === "team" ? `team:${ws.teamId}` : roster.userId ? `user:${roster.userId}` : undefined;
  } catch {
    return undefined;
  }
}

type PlanMeta = Pick<SecretMeta, "name" | "short_id" | "status" | "kind" | "workspace">;

/** The row a mapped or referenced name means (pickSecretByName), or the gap line when it is in several workspaces. */
export function metaFor(metas: readonly PlanMeta[], secret: string, prefer?: string): PlanMeta | null | { line: string } {
  const picked = pickSecretByName(metas, secret, { prefer });
  return picked && "ambiguous" in picked ? { line: ambiguousSecretName(secret, picked.ambiguous, { byNameOnly: true }) } : picked;
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
 * gap too unless `files` (cast vault run, which cleans up its temp file): a
 * server or an eval'd env outlives any temp file cast could clean up.
 */
export function planProjectRead(map: VaultMap, metas: readonly PlanMeta[], prefer?: string, opts: { files?: boolean } = {}): { read: string[]; gaps: VaultGap[] } {
  const read = new Set<string>();
  const gaps: VaultGap[] = [];
  for (const [envVar, { secret, required }] of Object.entries(map)) {
    const meta = metaFor(metas, secret, prefer);
    // Ambiguous stops the command like a required miss: going on without it would hide a choice only a rename settles.
    if (meta && "line" in meta) gaps.push({ envVar, secret, required: true, line: `${envVar}: ${meta.line}` });
    else if (meta?.status === "ready" && meta.kind === "file" && !opts.files) {
      gaps.push({ envVar, secret, required, line: `${envVar}: ${secret} is a file secret; only cast vault run puts it in a temp file` });
    } else if (meta?.status === "ready" && meta.kind !== "signin") read.add(secret);
    else gaps.push({ envVar, secret, required, line: gapLine(envVar, secret, meta) });
  }
  return { read: [...read], gaps };
}

/** The mapped vars a read secret could not fill (materialize's `unfilled`), as gaps that keep their [vault] line's required. */
export function unfilledGaps(map: VaultMap, unfilled: Materialized["unfilled"]): VaultGap[] {
  return unfilled.map((u) => ({ envVar: u.envVar, secret: u.secret, required: !!map[u.envVar]?.required, line: `${u.envVar}: ${u.error}` }));
}

/**
 * The env a project's servers start with: one metadata list, then one read
 * of the ready secrets (recorded against this session, purpose run). Values
 * stay in the returned object; gaps carry only names. A read Ask first holds
 * comes back as the decision to wait on, for the caller to stop on: a server
 * started without its secrets would keep running without them after the
 * approval.
 */
export async function loadProjectEnv(deps: PublishDeps, map: VaultMap, conversation?: string): Promise<{ env: Record<string, string>; gaps: VaultGap[] } | SecretNeedsApproval> {
  const metas: SecretMeta[] = await apiPost(deps, "/cli/vault/list", {}, { read: true, exitOnError: false });
  const prefer = await preferredWorkspace(deps);
  const { read, gaps } = planProjectRead(map, metas, prefer);
  if (!read.length) return { env: {}, gaps };
  const res = await apiPost(deps, "/cli/vault/read", { refs: read, purpose: "run", ...(prefer ? { prefer } : {}), ...(conversation ? { conversation } : {}) }, { exitOnError: false });
  if (isNeedsApproval(res)) return res;
  await refreshDaemonRedaction();
  const m = materialize(res.secrets as ReadSecret[], { map: envToSecret(map), writeFiles: false });
  return { env: m.env, gaps: [...gaps, ...unfilledGaps(map, m.unfilled)] };
}
