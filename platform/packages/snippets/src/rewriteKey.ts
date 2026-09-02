// The rewrite key: is the section on this machine the one THIS binary ships?
//
// Keyed on a content hash of the body, not on hand-bumped version constants.
// The constants were wrong in both directions: a body edit with no bump never
// reinstalled, and a bump with identical bytes rewrote every instruction file
// on every upgrade. The version still rides along as a display value and as a
// shadow for older binaries that compare their own constant against it.

import { snippetContentHash } from "./hash";
import type { SnippetDefinition } from "./types";

/** The config key holding the content hash last installed for `def`. Derived
 *  from `versionKey` unless the definition names one. A derivation that
 *  yields the version key itself would collide the two, so that throws. */
export function snippetHashKey(def: SnippetDefinition): string {
  if (def.hashKey) return def.hashKey;
  const key = def.versionKey.replace(/_version$/, "_hash");
  if (key === def.versionKey) {
    throw new Error(
      `snippet "${def.slug}": versionKey "${def.versionKey}" does not end in _version, ` +
        `so no hash key can be derived. Set hashKey on the definition.`,
    );
  }
  return key;
}

/**
 * Does this machine's config say the installed section differs from the body
 * `def` ships? A missing hash (any config written before hashes existed) reads
 * as stale, which costs one reinstall pass that the byte compare in the file
 * writer turns into zero writes when the text already matches. A definition
 * with no markdown section is never stale.
 */
export function snippetStale(config: object | null | undefined, def: SnippetDefinition): boolean {
  const body = def.section?.body;
  if (!body) return false;
  // `object` rather than an indexed type so a consumer's Config interface
  // (no index signature) passes without casts at every call site.
  const bag = (config ?? {}) as Record<string, unknown>;
  return bag[snippetHashKey(def)] !== snippetContentHash(body);
}

/**
 * Record what was just installed: the content hash (the actual rewrite key)
 * AND the version constant. Returns whether the config changed, so callers can
 * skip a pointless write.
 */
export function stampSnippet(config: object, def: SnippetDefinition, version: string): boolean {
  const bag = config as Record<string, unknown>;
  let changed = false;
  if (bag[def.versionKey] !== version) {
    bag[def.versionKey] = version;
    changed = true;
  }
  const body = def.section?.body;
  if (body) {
    const key = snippetHashKey(def);
    const hash = snippetContentHash(body);
    if (bag[key] !== hash) {
      bag[key] = hash;
      changed = true;
    }
  }
  return changed;
}
