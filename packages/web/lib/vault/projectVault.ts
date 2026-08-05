// Project vaults, seen from the browser: how the picker groups what the daemon
// offers, where a project opens, and how a root path is written for a human.
//
// Pure — no React, no store, no fetch — so the rules are unit-testable and so
// the picker, the landing-note effect and the header strip share ONE definition
// of each instead of three that drift apart.

import type { VaultInfo } from "@codecast/shared/contracts";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";

/** A project the user works in, offered as a vault without ever being
 *  registered — as opposed to a folder someone ran `cast vault add` on. */
export function isProjectVault(vault: VaultInfo | null | undefined): boolean {
  return vault?.kind === "project";
}

/**
 * A root path as a person would write it: the home directory collapsed to `~`.
 * The browser has no $HOME, so this reads the shape rather than the value —
 * every root in the list starts with the same eight wasted characters, and the
 * picker is narrow.
 */
export function shortenVaultRoot(root: string): string {
  return root.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * Markdown directly inside `dir`, then anywhere beneath it, in path order.
 * `dir` is "" for the vault root.
 */
function markdownUnder(paths: string[], dir: string): { direct: string[]; nested: string[] } {
  const prefix = dir ? `${dir}/` : "";
  const direct: string[] = [];
  const nested: string[] = [];
  for (const p of paths) {
    if (!isVaultMarkdownPath(p) || !p.startsWith(prefix)) continue;
    (p.slice(prefix.length).includes("/") ? nested : direct).push(p);
  }
  direct.sort();
  nested.sort();
  return { direct, nested };
}

function pickLanding(paths: string[], dir: string): string | null {
  const { direct, nested } = markdownUnder(paths, dir);
  const prefix = dir ? `${dir}/` : "";
  const named = (name: string) =>
    direct.find((p) => p.slice(prefix.length).toLowerCase() === name) ?? null;
  return named("index.md") ?? named("readme.md") ?? direct[0] ?? nested[0] ?? null;
}

/**
 * The note a vault opens on when the user picked the vault but not a file.
 *
 * ONLY project vaults get one. A notes vault opening straight into a note would
 * change what `cast vault add` has always done; a repo dropping you on an empty
 * reading pane beside a tree of source directories is the poor first impression
 * this exists to fix.
 *
 * Inside the vault's home directory (`docs/` and friends — the daemon decides
 * which, in vaultScope.probeProjectVault, so the rule lives in exactly one
 * place), the order is index, then README, then the first note in the directory
 * itself, then the first note anywhere below it. A home directory that turns out
 * to hold nothing falls back to the same search at the root, which is where a
 * repo's README lives.
 */
export function vaultLandingPath(vault: VaultInfo, paths: string[]): string | null {
  if (!isProjectVault(vault)) return null;
  const home = vault.home ?? "";
  return pickLanding(paths, home) ?? (home ? pickLanding(paths, "") : null);
}

export type VaultSourceKind = "vault" | "project" | "remote";

export interface VaultChoice {
  id: string;
  name: string;
  kind: VaultSourceKind;
  /** Absolute root on the daemon's machine. Absent for a remote mirror, which
   *  is a projection rather than a directory this machine can name. */
  root?: string;
  /** Known only after a real scan — see the note on discovery in
   *  vaultRegistry.projectVaults about why a discovered project has none. */
  noteCount?: number;
  /** Opt-in one-way mirror to codecast. Carried through grouping because it is
   *  half of what a row's provenance badge says: a mirrored local vault is on
   *  this machine AND in codecast, which reads differently from either alone. */
  mirror?: boolean;
}

export interface VaultChoiceGroup {
  kind: VaultSourceKind;
  label: string;
  items: VaultChoice[];
}

const GROUP_LABELS: Record<VaultSourceKind, string> = {
  vault: "Vaults",
  project: "Projects",
  remote: "Mirrored from another machine",
};

/**
 * The picker's contents: vaults the user registered, then the projects codecast
 * already knew about, then anything mirrored from another machine. Empty groups
 * are dropped, so someone with no registered vaults sees a plain list of their
 * projects rather than an empty heading above it.
 *
 * A remote mirror of a vault that also exists locally is dropped: the local one
 * is the same files, writable.
 */
export function groupVaultChoices(
  local: VaultInfo[],
  remote: { id: string; name: string; note_count?: number }[],
): VaultChoiceGroup[] {
  const localIds = new Set(local.map((v) => v.id));
  const buckets: Record<VaultSourceKind, VaultChoice[]> = { vault: [], project: [], remote: [] };

  for (const v of local) {
    const kind: VaultSourceKind = isProjectVault(v) ? "project" : "vault";
    buckets[kind].push({
      id: v.id,
      name: v.name,
      kind,
      root: v.root,
      noteCount: v.note_count,
      mirror: v.mirror,
    });
  }
  for (const v of remote) {
    if (localIds.has(v.id)) continue;
    buckets.remote.push({ id: v.id, name: v.name, kind: "remote", noteCount: v.note_count });
  }

  const order: VaultSourceKind[] = ["vault", "project", "remote"];
  return order
    .filter((kind) => buckets[kind].length > 0)
    .map((kind) => ({ kind, label: GROUP_LABELS[kind], items: buckets[kind] }));
}
