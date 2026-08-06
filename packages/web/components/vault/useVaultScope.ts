"use client";
// The Files surface's team question, answered from cache.
//
// Everything here reads state the store already holds — sessions, the team
// roster, docs — so the picker and the scope line paint before the daemon or
// the network has said anything. No query is issued and none is needed.
//
// PERFORMANCE. Sessions heartbeat about once a second, so subscribing to the
// collection would re-render the whole Files page on every tick (see
// store/wakeSig.ts). This subscribes to a signature of only the three fields
// the scope depends on, which a heartbeat never changes.

import { useMemo } from "react";
import { makeCollectionSig } from "../../store/wakeSig";
import { useTrackedStore, type InboxSession } from "../../store/inboxStore";
import {
  PERSONAL_SCOPE,
  deriveTeamForRoot,
  findDocForFile,
  type ScopeEvidence,
  type VaultTeamScope,
} from "../../lib/vault/scopeModel";
import type { DocItem } from "../../store/inboxStore";

const sessionScopeSig = makeCollectionSig<InboxSession>(
  (s) => `${s.git_root || s.project_path || ""}|${s.team_id ?? ""}|${s.is_private ? 1 : 0}`,
);

// Docs churn far less than sessions, but a doc EDIT rewrites the row on every
// keystroke in the editor — and the only fields this join needs are the id, the
// path it mirrors, and the title on the button.
const docSourceSig = makeCollectionSig<DocItem>(
  (d) => `${d._id}|${d.source_file ?? ""}|${d.title ?? ""}`,
);

/**
 * The codecast doc mirroring the open file, if there is one.
 *
 * This is the cross-link between the two surfaces that confused people: a file
 * on disk and a doc in codecast can be the same writing, and until now nothing
 * on screen said so.
 */
export function useDocForFile(
  root: string | undefined,
  relPath: string | null | undefined,
): DocItem | null {
  const state = useTrackedStore([(s) => docSourceSig(s.docs)]);
  const sig = docSourceSig(state.docs);
  return useMemo(
    () => findDocForFile(root, relPath, state.docs),
    // Same reasoning as the resolver below: sig covers every field read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, relPath, sig],
  );
}

/**
 * A resolver rather than a single answer: the picker asks the same question of
 * every row it lists, and one shared pass over the sessions cache beats one per
 * row. Identical verdicts collapse into weighted rows, so the per-row cost is
 * the number of DIRECTORIES the user works in, not the number of sessions.
 */
export function useVaultTeamResolver(): (root: string | undefined) => VaultTeamScope {
  const state = useTrackedStore([(s) => sessionScopeSig(s.sessions), (s) => s.teams]);
  const sig = sessionScopeSig(state.sessions);
  const teams = state.teams;

  return useMemo(() => {
    const byVerdict = new Map<string, ScopeEvidence>();
    for (const id in state.sessions) {
      const s = state.sessions[id];
      const path = s?.git_root || s?.project_path;
      if (!path) continue;
      const teamId = s.team_id ?? null;
      const isPrivate = !!s.is_private;
      const key = `${path}|${teamId ?? ""}|${isPrivate ? 1 : 0}`;
      const seen = byVerdict.get(key);
      if (seen) seen.weight = (seen.weight ?? 1) + 1;
      else byVerdict.set(key, { path, teamId, isPrivate, weight: 1 });
    }
    const evidence = [...byVerdict.values()];

    const teamNameById: Record<string, string> = {};
    for (const team of teams ?? []) {
      if (team?._id) teamNameById[String(team._id)] = String(team.name ?? "");
    }

    const cache = new Map<string, VaultTeamScope>();
    return (root: string | undefined): VaultTeamScope => {
      if (!root) return PERSONAL_SCOPE;
      let scope = cache.get(root);
      if (!scope) {
        scope = deriveTeamForRoot(root, evidence, teamNameById);
        cache.set(root, scope);
      }
      return scope;
    };
    // `state.sessions` is read through the signature: sig is a superset of the
    // fields used above, so a stale closure cannot produce a stale answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, teams]);
}
