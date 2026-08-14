// Scope strings and the project scope key.
//
// The kinds and their precedence live in capabilities.ts (SCOPE_KINDS,
// SCOPE_PRECEDENCE) — this module adds the WIRE forms: how a scope is written
// into a binding row, and how a project is named so the same repo is the same
// scope on every machine.
//
// The rule that shapes everything here: a scope key is NEVER a raw filesystem
// path. An absolute path is a property of one machine and one checkout; a team
// binding carrying /Users/x/src/api would write into whatever happens to sit at
// that path on someone else's disk. So a project is keyed by its git origin
// when it has one, and by a user-qualified local key when it does not — and the
// local form is invalid for a team binding by construction, enforced where
// bindings are written, not in a UI that can be bypassed.

import { SCOPE_KINDS, type ScopeKind } from "./capabilities.js";

export interface ParsedScope {
  kind: ScopeKind;
  /** The scope's qualifier: a device id, a project key, a session id. Absent
   *  for `user` and `team`, whose identity comes from the row's own columns. */
  key?: string;
}

/** `<kind>` or `<kind>:<key>`. The kind never contains `:`, so the first colon
 *  splits unambiguously even though project keys themselves contain colons. */
export function formatScopeString(scope: ParsedScope): string {
  return scope.key === undefined ? scope.kind : `${scope.kind}:${scope.key}`;
}

export function parseScopeString(value: unknown): ParsedScope | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const colon = value.indexOf(":");
  const kind = colon === -1 ? value : value.slice(0, colon);
  if (!(SCOPE_KINDS as readonly string[]).includes(kind)) return null;
  const key = colon === -1 ? undefined : value.slice(colon + 1);
  if (key !== undefined && key.length === 0) return null;
  // device/project/session scopes are meaningless without their qualifier;
  // user/team carry identity in the row and take none.
  const needsKey = kind === "device" || kind === "project" || kind === "session";
  if (needsKey && key === undefined) return null;
  if (!needsKey && key !== undefined) return null;
  return { kind: kind as ScopeKind, ...(key !== undefined ? { key } : {}) };
}

/**
 * One name for one repo, whatever machine or protocol cloned it.
 *
 * `git@github.com:o/r.git`, `ssh://git@github.com/o/r`, and
 * `https://github.com/o/r.git` are the same repository and must produce the
 * same key, or a team binding lands on some clones and not others — drift
 * manufactured by our own bookkeeping, the exact failure the fleet page exists
 * to catch elsewhere.
 */
export function normalizeGitOrigin(originUrl: string): string | null {
  let rest = originUrl.trim();
  if (rest.length === 0) return null;
  // scp-like ssh: git@host:owner/repo(.git)
  const scp = rest.match(/^[A-Za-z0-9._-]+@([^:/]+):(.+)$/);
  if (scp) {
    rest = `${scp[1]}/${scp[2]}`;
  } else {
    // URL forms: strip scheme, then credentials.
    rest = rest.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
    const at = rest.indexOf("@");
    if (at !== -1) rest = rest.slice(at + 1);
  }
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  if (!rest.includes("/")) return null;
  return rest;
}

export interface ProjectScopeInput {
  /** The repo's origin remote URL, when the project is a git checkout. */
  originUrl?: string;
  /** Path inside the repo, for a project rooted below the repo root. */
  subpath?: string;
  /** Required for the local fallback: a path means nothing without whose. */
  userId?: string;
  /** Absolute path, used ONLY when there is no origin. */
  path?: string;
}

/** `git:<normalized origin>[#subpath]`, or `local:<user_id>:<path>` when the
 *  project has no origin. Null when neither can be built honestly. */
export function buildProjectScopeKey(input: ProjectScopeInput): string | null {
  if (input.originUrl) {
    const origin = normalizeGitOrigin(input.originUrl);
    if (!origin) return null;
    const sub = input.subpath?.replace(/^\/+|\/+$/g, "");
    return sub ? `git:${origin}#${sub}` : `git:${origin}`;
  }
  if (input.path && input.userId) {
    return `local:${input.userId}:${input.path}`;
  }
  return null;
}

/** The rule the mutation enforces: a `local:` key names one user's disk and can
 *  never back a team binding. Exported so the mutation and its test share one
 *  definition instead of two string checks that drift. */
export function scopeKeyValidForTeam(scopeKey: string): boolean {
  return !scopeKey.startsWith("local:");
}
