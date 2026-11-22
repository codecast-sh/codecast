"use client";
// Fills the changes context for a conversation (hooks/useMentionedChange.ts): the
// repository's changes are read once some code span asks, then handed to every
// span through a store each subscribes to by its own reference.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRepoChanges, type RepoChange } from "../../hooks/useRepoChanges";
import { useRepoBranchDetails } from "../../hooks/useRepoBrowse";
import { ChangesContext, type ChangesStore } from "../../hooks/useMentionedChange";
import { findChange } from "../../lib/changes/assemble";

/** What a reader sees of a change: re-render a span only when this moves. */
const sigOf = (c: RepoChange | null) =>
  c ? `${c.key}|${c.lifecycle.now.stage}|${c.lifecycle.now.state}|${c.lifecycle.now.word}|${c.lifecycle.now.detail}|${c.lifecycle.now.since}|${c.lifecycle.stages.map((s) => s.state + s.short).join(",")}|${c.writers.length}` : "";

function makeStore(repository: string, onWant: () => void): ChangesStore & { set: (changes: RepoChange[], read: boolean) => void } {
  let changes: RepoChange[] = [];
  let loaded = false;
  const listeners = new Set<() => void>();
  const cache = new Map<string, { sig: string; change: RepoChange | null }>();
  return {
    repository,
    want: onWant,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    find: (ref) => {
      const change = (findChange(changes, ref) as RepoChange | null) ?? null;
      const sig = sigOf(change);
      const held = cache.get(ref);
      if (held && held.sig === sig) return held.change;
      cache.set(ref, { sig, change });
      return change;
    },
    loaded: () => loaded,
    set: (next, read) => {
      changes = next;
      loaded = read;
      for (const fn of listeners) fn();
    },
  };
}

/** Reads the changes once wanted and hands them to the store. */
function ChangesFeed({ repository, onChanges }: { repository: string; onChanges: (c: RepoChange[], read: boolean) => void }) {
  // GitHub's branch list too: a pushed branch with no pull request and no checkout here is still a change a message names.
  const branchRead = useRepoBranchDetails(repository);
  const { ready, changes } = useRepoChanges(repository, undefined, { branches: branchRead.data ?? null });
  const read = ready && (branchRead.ready || !!branchRead.error);
  useEffect(() => onChanges(changes, read), [changes, read, onChanges]);
  return null;
}

export function ChangesProvider({ repository, children }: { repository?: string | null; children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const wantRef = useRef(false);
  const store = useMemo(() => (repository ? makeStore(repository, () => {
    if (wantRef.current) return;
    wantRef.current = true;
    setWanted(true);
  }) : null), [repository]);
  return (
    <ChangesContext.Provider value={store}>
      {store && wanted ? <ChangesFeed repository={store.repository} onChanges={store.set} /> : null}
      {children}
    </ChangesContext.Provider>
  );
}
