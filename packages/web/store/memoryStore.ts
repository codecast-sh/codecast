// The Memory page's state: Claude Code memory folders on this machine, read
// through the daemon's loopback bridge. Not Convex data, so it lives beside
// vaultStore rather than in inboxStore; like the vault, the disk is the source
// of truth and every edit lands in this store first, so the page never waits
// on the daemon to show what you just did.

import { create } from "zustand";
import type { ConvexReactClient } from "convex/react";
import type { MemoryProject, MemoryProjectSummary } from "@codecast/shared/memory";
import {
  MEMORY_INDEX_FILE,
  appendIndexLine,
  memoryIndexBudget,
  memoryIndexLine,
  readMemoryFields,
  removeIndexLinesFor,
} from "@codecast/shared/memory";
import { lastDiscoveryFailure, loopbackFailureReason, type LoopbackUnreachableReason } from "../lib/terminal/endpoint";
import { getVaultEndpoint, type VaultEndpoint } from "../lib/vault/client";
import {
  MemoryRequestError,
  listMemoryProjects,
  readMemoryProject,
  trashMemoryFile,
  writeMemoryFile,
} from "../lib/memory/client";

export type MemoryConnection = "idle" | "discovering" | "connected" | "no-daemon";

/** A save that lost to a newer version on disk. */
export class MemoryConflict extends Error {
  constructor(
    readonly file: string,
    readonly current: string | null,
    readonly mtime: number | null,
  ) {
    super(current === null ? `${file} was deleted on disk` : `${file} changed on disk`);
  }
}

interface MemoryState {
  connection: MemoryConnection;
  endpoint: VaultEndpoint | null;
  unreachableReason: LoopbackUnreachableReason;
  unreachableDetail: string | null;
  projects: MemoryProjectSummary[];
  activeId: string | null;
  project: MemoryProject | null;
  loadingProject: boolean;

  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  /** Re-read the open project and the project list; quiet when nothing changed. */
  refresh: () => Promise<void>;
  /** Write a memory or MEMORY.md. `baseMtime` null creates. Throws MemoryConflict. */
  save: (file: string, raw: string, baseMtime: number | null) => Promise<number>;
  /** Create a memory, and point MEMORY.md at it when asked. */
  create: (file: string, raw: string, opts: { index: boolean }) => Promise<void>;
  /** Add the index line for an existing memory. */
  addToIndex: (file: string) => Promise<void>;
  remove: (file: string, opts: { unindex: boolean }) => Promise<string>;
}

const LAST_PROJECT_KEY = "codecast:memory:lastProject";

function failure(e: unknown): Pick<MemoryState, "unreachableReason" | "unreachableDetail"> {
  const status = e instanceof MemoryRequestError ? e.status : 0;
  return { unreachableReason: loopbackFailureReason(status), unreachableDetail: e instanceof Error ? e.message : String(e) };
}

/** What the project list should say about a project after a local edit. */
function summarize(summary: MemoryProjectSummary, project: MemoryProject): MemoryProjectSummary {
  return {
    ...summary,
    count: project.files.length,
    index: memoryIndexBudget(project.index.raw),
    updated: Math.max(summary.updated, ...project.files.map((f) => f.mtime), project.index.mtime ?? 0),
  };
}

const signature = (p: MemoryProject) => JSON.stringify([p.index.mtime, p.files.map((f) => [f.file, f.mtime])]);

export const useMemoryStore = create<MemoryState>()((set, get) => {
  const ep = () => {
    const endpoint = get().endpoint;
    if (!endpoint) throw new Error("not connected to the local daemon");
    return endpoint;
  };

  /** Patch the open project in place and keep its row in the list in step. */
  const patchProject = (fn: (p: MemoryProject) => MemoryProject) =>
    set((s) => {
      if (!s.project) return {};
      const project = fn(s.project);
      return { project, projects: s.projects.map((row) => (row.id === project.id ? summarize(row, project) : row)) };
    });

  const putFile = (file: string, raw: string, mtime: number, bytes: number) =>
    patchProject((p) =>
      file === MEMORY_INDEX_FILE
        ? { ...p, index: { raw, mtime } }
        : {
            ...p,
            files: p.files.some((f) => f.file === file)
              ? p.files.map((f) => (f.file === file ? { ...f, raw, mtime, bytes } : f))
              : [...p.files, { file, raw, mtime, bytes }].sort((a, b) => a.file.localeCompare(b.file)),
          },
    );

  const currentOf = (file: string) => {
    const p = get().project;
    if (!p) return null;
    if (file === MEMORY_INDEX_FILE) return p.index.mtime === null ? null : { raw: p.index.raw, mtime: p.index.mtime };
    const f = p.files.find((x) => x.file === file);
    return f ? { raw: f.raw, mtime: f.mtime } : null;
  };

  return {
    connection: "idle",
    endpoint: null,
    unreachableReason: "none",
    unreachableDetail: null,
    projects: [],
    activeId: null,
    project: null,
    loadingProject: false,

    connect: async (convex, opts) => {
      set({ connection: "discovering" });
      const endpoint = await getVaultEndpoint(convex, opts);
      if (!endpoint) {
        set({ connection: "no-daemon", endpoint: null, unreachableReason: lastDiscoveryFailure(), unreachableDetail: null });
        return;
      }
      let projects: MemoryProjectSummary[];
      try {
        projects = await listMemoryProjects(endpoint);
      } catch (e) {
        set({ connection: "no-daemon", endpoint, ...failure(e) });
        return;
      }
      set({ connection: "connected", endpoint, projects, unreachableReason: "none", unreachableDetail: null });
      const remembered = get().activeId ?? localStorage.getItem(LAST_PROJECT_KEY);
      const start = projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id;
      if (start) await get().selectProject(start);
    },

    selectProject: async (id) => {
      localStorage.setItem(LAST_PROJECT_KEY, id);
      set((s) => ({ activeId: id, loadingProject: s.project?.id !== id }));
      try {
        const project = await readMemoryProject(ep(), id);
        if (get().activeId === id) set({ project, loadingProject: false });
      } catch (e) {
        if (get().activeId === id) set({ loadingProject: false, ...failure(e) });
      }
    },

    refresh: async () => {
      const { endpoint, activeId, project } = get();
      if (!endpoint) return;
      const [projects, fresh] = await Promise.all([
        listMemoryProjects(endpoint).catch(() => null),
        activeId ? readMemoryProject(endpoint, activeId).catch(() => null) : null,
      ]);
      if (projects) set({ projects });
      if (fresh && get().activeId === fresh.id && (!project || signature(project) !== signature(fresh))) set({ project: fresh });
    },

    save: async (file, raw, baseMtime) => {
      const project = get().project;
      if (!project) throw new Error("no project open");
      const before = currentOf(file);
      // Shown at once; the daemon's answer only settles the mtime.
      putFile(file, raw, baseMtime ?? Date.now(), raw.length);
      try {
        const { mtime } = await writeMemoryFile(ep(), project.id, file, raw, baseMtime);
        putFile(file, raw, mtime, new TextEncoder().encode(raw).length);
        return mtime;
      } catch (e) {
        if (before) putFile(file, before.raw, before.mtime, before.raw.length);
        else patchProject((p) => ({ ...p, files: p.files.filter((f) => f.file !== file) }));
        if (e instanceof MemoryRequestError && e.status === 409 && e.body.mtime !== undefined) {
          throw new MemoryConflict(file, e.body.current ?? null, e.body.mtime ?? null);
        }
        throw e;
      }
    },

    create: async (file, raw, opts) => {
      await get().save(file, raw, null);
      if (opts.index) await get().addToIndex(file);
    },

    addToIndex: async (file) => {
      const project = get().project;
      const f = project?.files.find((x) => x.file === file);
      if (!project || !f) return;
      const line = memoryIndexLine(file, readMemoryFields(f.raw));
      // The index may have moved under us (another session adding its own line);
      // retry once against what is on disk rather than failing the add.
      try {
        await get().save(MEMORY_INDEX_FILE, appendIndexLine(project.index.raw, line), project.index.mtime);
      } catch (e) {
        if (!(e instanceof MemoryConflict) || e.current === null) throw e;
        await get().save(MEMORY_INDEX_FILE, appendIndexLine(e.current, line), e.mtime);
      }
    },

    remove: async (file, opts) => {
      const project = get().project;
      if (!project) throw new Error("no project open");
      const before = project;
      patchProject((p) => ({
        ...p,
        files: p.files.filter((f) => f.file !== file),
        index: opts.unindex ? { ...p.index, raw: removeIndexLinesFor(p.index.raw, file).raw } : p.index,
      }));
      try {
        const { trashed } = await trashMemoryFile(ep(), project.id, file, opts.unindex);
        void get().refresh();
        return trashed;
      } catch (e) {
        patchProject(() => before);
        throw e;
      }
    },
  };
});
