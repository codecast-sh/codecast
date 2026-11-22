"use client";
// Fills the changes context for a conversation (hooks/useMentionedChange.ts): the
// repository's changes are read once some code span asks, then handed to every
// span through a store each subscribes to by its own reference.
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useRepoChanges, type RepoChange } from "../../hooks/useRepoChanges";
import { ChangesContext, UNLISTED_MAX, type ChangesStore } from "../../hooks/useMentionedChange";
import { findChange, type RepoChangeRows } from "../../lib/changes/assemble";

/** What a reader sees of a change: re-render a span only when this moves. */
const sigOf = (c: RepoChange | null) =>
  c ? `${c.key}|${c.lifecycle.now.stage}|${c.lifecycle.now.state}|${c.lifecycle.now.word}|${c.lifecycle.now.detail}|${c.lifecycle.now.since}|${c.lifecycle.stages.map((s) => s.state + s.short).join(",")}|${c.writers.length}` : "";

function makeStore(repository: string, onWant: () => void): ChangesStore & { set: (changes: RepoChange[], read: boolean, listCut: boolean) => void } {
  let changes: RepoChange[] = [];
  let loaded = false;
  let listCut = false;
  const lookups = new Set<string>();
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
    mayLookUp: (name) => {
      if (!listCut || name.toLowerCase() === repository.toLowerCase()) return false;
      if (lookups.has(name)) return true;
      if (lookups.size >= UNLISTED_MAX) return false;
      lookups.add(name);
      return true;
    },
    set: (next, read, cut) => {
      changes = next;
      loaded = read;
      listCut = cut;
      for (const fn of listeners) fn();
    },
  };
}

/** GitHub's branch list as a provider is handed it: the rows, and whether the read has answered. */
type BranchRead = { data: RepoChangeRows["branches"]; read: boolean };

/**
 * Reads GitHub's branch list for a provider, once a message wants the repository's changes. The web passes one
 * (WebBranchFeed); the phone passes none, because the branch-list read is web-only, and finds branches by the
 * checkouts, pull requests and deploy queues alone.
 */
export type BranchFeed = ComponentType<{ repository: string; onRead: (r: BranchRead) => void }>;

/** Reads the changes once wanted and hands them to the store. */
function ChangesFeed({ repository, branches, onChanges }: { repository: string; branches: BranchRead; onChanges: (c: RepoChange[], read: boolean, listCut: boolean) => void }) {
  const { ready, changes } = useRepoChanges(repository, undefined, { branches: branches.data });
  const read = ready && branches.read;
  const listCut = !!branches.data?.truncated;
  useEffect(() => onChanges(changes, read, listCut), [changes, read, listCut, onChanges]);
  return null;
}

const NO_LIST: BranchRead = { data: null, read: true };

export function ChangesProvider({ repository, BranchFeed, children }: { repository?: string | null; BranchFeed?: BranchFeed; children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const [branches, setBranches] = useState<BranchRead>({ data: null, read: false });
  const wantRef = useRef(false);
  const store = useMemo(() => (repository ? makeStore(repository, () => {
    if (wantRef.current) return;
    wantRef.current = true;
    setWanted(true);
  }) : null), [repository]);
  return (
    <ChangesContext.Provider value={store}>
      {store && wanted && BranchFeed ? <BranchFeed repository={store.repository} onRead={setBranches} /> : null}
      {store && wanted ? <ChangesFeed repository={store.repository} branches={BranchFeed ? branches : NO_LIST} onChanges={store.set} /> : null}
      {children}
    </ChangesContext.Provider>
  );
}
