// The builtin driver: bindings on builtin/<slug> become CLAUDE.md sections.
//
// This is the first kind the reconciler materializes, and it does it with the
// writers that already exist — installSectionToTargets and cutOwnedSections in
// snippets.ts, the same code `cast install` and `cast uninstall` run. No new
// writer, no new ownership model: a binding is a wish, and this turns the wish
// into the exact bytes the CLI would have written by hand.
//
// It converges by RESOLVED STATE, not by binding rows: the resolver has
// already folded scope precedence, so an entry here is enabled or disabled
// after every narrower/broader rule has spoken. Off means cut; on means
// install-or-refresh; a slug with no entry is left exactly as it is (the user
// may have installed it by hand and never bound it — not ours to touch).

import { SNIPPET_CATALOG, snippetBySlug } from "@codecast/shared/contracts";
import { cutOwnedSections, getSnippetTargets, installSectionToTargets } from "../snippets.js";
import * as fs from "fs";
import type { DesiredState } from "@codecast/shared/contracts";

export interface BuiltinApplyOutcome {
  installed: string[];
  refreshed: string[];
  removed: string[];
  /** Slugs the resolver named that no builtin section exists for. Not an
   *  error — the catalog and the resolver can disagree for one release — but
   *  worth a log line so the drift is visible. */
  unknown: string[];
}

/** Which resolved entries this driver owns: builtin/<slug> with a section. */
export function builtinEntries(state: DesiredState): Array<{ slug: string; enabled: boolean }> {
  return state.entries
    .filter((e) => e.slug.startsWith("builtin/"))
    .map((e) => ({ slug: e.slug.slice("builtin/".length), enabled: e.enabled && !e.withheld }));
}

export function applyBuiltins(state: DesiredState, dryRun = false): BuiltinApplyOutcome {
  const out: BuiltinApplyOutcome = { installed: [], refreshed: [], removed: [], unknown: [] };
  for (const { slug, enabled } of builtinEntries(state)) {
    const desc = snippetBySlug(slug);
    const spec = desc?.section?.spec;
    const body = desc?.section?.body;
    if (!desc || !spec || !body) {
      out.unknown.push(slug);
      continue;
    }
    if (enabled) {
      if (dryRun) {
        out.installed.push(slug);
        continue;
      }
      // update=true so a body edit lands; the writer's own byte-compare keeps
      // an unchanged section at zero writes.
      const r = installSectionToTargets(spec, body, true);
      // `updated` means "the section already existed" — the writer sets it
      // even when the bytes were identical. `unchanged` is the write truth.
      if (r.unchanged) continue;
      if (r.updated) out.refreshed.push(slug);
      else if (r.installed) out.installed.push(slug);
    } else {
      let removedAnywhere = false;
      for (const target of getSnippetTargets()) {
        let existing: string;
        try {
          existing = fs.readFileSync(target.filePath, "utf-8");
        } catch {
          continue;
        }
        const next = cutOwnedSections(existing, spec);
        if (next === existing) continue;
        if (!dryRun) fs.writeFileSync(target.filePath, next.trimEnd() + "\n", { mode: 0o600 });
        removedAnywhere = true;
      }
      if (removedAnywhere) out.removed.push(slug);
    }
  }
  return out;
}

/** Every builtin slug the catalog knows — for callers that want to sanity
 *  check a resolved set before applying. */
export function knownBuiltinSlugs(): string[] {
  return SNIPPET_CATALOG.filter((s) => s.section).map((s) => s.slug);
}
