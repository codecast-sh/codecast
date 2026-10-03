// The Memory page: Claude Code's memory folders on this machine, as a map of
// links, the MEMORY.md index against its load budget, a table, a health check,
// and an editor. Read and written through the local daemon (memoryStore).

import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brain, Plus, Search } from "lucide-react";
import { buildMemoryAtlas, MEMORY_INDEX_FILE, type MemoryProjectSummary } from "@codecast/shared/memory";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useTabActive } from "../../hooks/usePagePresence";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { useMemoryStore } from "../../store/memoryStore";
import { LocalDaemonUnreachable } from "../LocalDaemonUnreachable";
import { MemoryIndexView } from "./MemoryIndexView";
import { MemoryListView } from "./MemoryListView";
import { MemoryHealthView } from "./MemoryHealthView";
import { MemoryEditor, NEW_MEMORY } from "./MemoryEditor";
import { BudgetMeter } from "./parts";
import { MEMORY_VIEWS, TYPE_TONE, healthAlarm, memoryHealth, memoryHref, noteMatches, toneCss, typeKey, type MemoryView } from "./memoryView";

const MemoryMap = lazy(() => import("./MemoryMap"));

/** How often an open page re-reads the folder, for memories other sessions write. */
const REFRESH_MS = 6_000;

/** Narrow: one column, project picker in the header, editor over the page.
 *  Medium: project rail, editor over the main view. Wide: all side by side. */
type Fit = "narrow" | "medium" | "wide";
const fitFor = (width: number): Fit => (width < 760 ? "narrow" : width < 1180 ? "medium" : "wide");

const projectName = (p: { path: string }) => p.path.split("/").filter(Boolean).slice(-2).join("/") || "~";

function ProjectRail({ projects, activeId, onSelect }: { projects: MemoryProjectSummary[]; activeId: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className="w-56 shrink-0 border-r border-sol-border/40 bg-sol-bg-alt/40 overflow-y-auto py-2">
      <div className="px-3 pb-2 text-[11px] text-sol-text-dim">Projects</div>
      {projects.map((p) => {
        const over = p.index.cutAt !== null;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            title={p.path}
            className={`block w-full text-left px-3 py-2 transition-colors ${p.id === activeId ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`}
          >
            <div className="flex items-baseline gap-2">
              <span className={`flex-1 truncate text-[13px] ${p.id === activeId ? "text-sol-text font-medium" : "text-sol-text-muted"}`}>{projectName(p)}</span>
              <span className="font-mono text-[10.5px] text-sol-text-dim tabular-nums">{p.count}</span>
            </div>
            <div className="mt-1.5 h-0.5 rounded-full bg-sol-border/30 overflow-hidden">
              <div className={`h-full ${over ? "bg-sol-red" : "bg-sol-text-dim/60"}`} style={{ width: `${Math.min(100, (p.index.bytes / p.index.maxBytes) * 100)}%` }} />
            </div>
            {over && <div className="mt-1 text-[10.5px] text-sol-red">index cut at line {p.index.cutAt}</div>}
          </button>
        );
      })}
    </nav>
  );
}

export function MemoryContent() {
  // The page lives in a pane that can be any width, so it fits its own box,
  // not the window. The ref sits on a wrapper every state renders.
  const rootRef = useRef<HTMLDivElement>(null);
  const fit = useDerivedSize(rootRef, (w) => fitFor(w), () => fitFor(typeof window === "undefined" ? 1400 : window.innerWidth));
  return (
    <div ref={rootRef} className="h-full min-h-0">
      <MemoryBody fit={fit} />
    </div>
  );
}

function MemoryBody({ fit }: { fit: Fit }) {
  const convex = useConvex();
  const router = useRouter();
  const searchParams = useSearchParams();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const isTabActive = useTabActive();

  const connection = useMemoryStore((s) => s.connection);
  const unreachableReason = useMemoryStore((s) => s.unreachableReason);
  const unreachableDetail = useMemoryStore((s) => s.unreachableDetail);
  const projects = useMemoryStore((s) => s.projects);
  const activeId = useMemoryStore((s) => s.activeId);
  const project = useMemoryStore((s) => s.project);
  const loadingProject = useMemoryStore((s) => s.loadingProject);
  const connect = useMemoryStore((s) => s.connect);
  const selectProject = useMemoryStore((s) => s.selectProject);
  const refresh = useMemoryStore((s) => s.refresh);

  const urlProject = searchParams.get("p");
  const view = (MEMORY_VIEWS.find((v) => v.id === searchParams.get("view"))?.id ?? "map") as MemoryView;
  const openFile = searchParams.get("m");
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const go = useCallback(
    (next: { project?: string | null; view?: MemoryView; file?: string | null }) =>
      router.replace(
        memoryHref({
          project: next.project === undefined ? activeId : next.project,
          view: next.view ?? view,
          file: next.file === undefined ? openFile : next.file,
        }),
      ),
    [router, activeId, view, openFile],
  );

  useMountEffect(() => {
    if (useMemoryStore.getState().connection === "idle") void connect(convex);
  });
  // The URL names the project; the store follows it.
  useWatchEffect(() => {
    if (connection === "connected" && urlProject && urlProject !== activeId) void selectProject(urlProject);
  }, [connection, urlProject]);

  // Other sessions write memories while this is open: re-read while visible.
  useWatchEffect(() => {
    if (connection !== "connected" || !isTabActive) return;
    const tick = () => document.visibilityState === "visible" && void refresh();
    const id = setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [connection, isTabActive]);

  const atlas = useMemo(() => (project ? buildMemoryAtlas(project.files, project.index.raw) : null), [project]);
  const health = useMemo(() => (atlas ? memoryHealth(atlas) : null), [atlas]);
  const visible = useMemo(() => {
    if (!atlas || (!query.trim() && hiddenTypes.size === 0)) return null;
    return new Set(atlas.notes.filter((n) => noteMatches(n, query, hiddenTypes)).map((n) => n.file));
  }, [atlas, query, hiddenTypes]);
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of atlas?.notes ?? []) counts.set(typeKey(n.type), (counts.get(typeKey(n.type)) ?? 0) + 1);
    return counts;
  }, [atlas]);

  const open = useCallback((file: string) => go({ file }), [go]);
  const close = useCallback(() => go({ file: null }), [go]);
  const jumpToLine = useCallback(
    (line: number) => {
      setFocusLine(line);
      go({ view: "index" });
    },
    [go],
  );

  // Esc closes the editor, unless focus is in a field where Esc means "stop typing".
  // The tab shell keeps inactive tabs mounted, so a bare window listener would
  // fire from whatever tab the person is actually looking at.
  useEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isTabActive || !openFile) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    event.preventDefault();
    close();
  });

  if (connection === "no-daemon") {
    return <LocalDaemonUnreachable what="Memories" reason={unreachableReason} detail={unreachableDetail} onRetry={() => void connect(convex, { force: true })} />;
  }
  if (connection !== "connected") {
    return <div className="h-full flex items-center justify-center text-sm text-sol-text-dim">Connecting to this machine&apos;s memories…</div>;
  }
  if (projects.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
        <Brain className="w-10 h-10 text-sol-text-dim opacity-40" />
        <div className="text-sol-text font-medium">No memories on this machine yet</div>
        <div className="text-sm text-sol-text-muted max-w-md">
          Claude Code saves memories under <code className="text-sol-text">~/.claude/projects/&lt;project&gt;/memory</code> as it learns about your work. They show up here as soon as one exists.
        </div>
      </div>
    );
  }

  const summary = projects.find((p) => p.id === activeId);
  const shown = atlas ? (visible ? atlas.notes.filter((n) => visible.has(n.file)) : atlas.notes) : [];
  const unreached = health?.unreached.length ?? 0;

  return (
    <div className="relative h-full min-h-0 flex">
      {fit !== "narrow" && <ProjectRail projects={projects} activeId={activeId} onSelect={(id) => go({ project: id, file: null })} />}

      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={titlebarRef} className="flex items-end gap-6 px-5 pt-4 pb-3">
          <div className="flex-1 min-w-0">
            {fit === "narrow" ? (
              <select
                value={activeId ?? ""}
                onChange={(e) => go({ project: e.target.value, file: null })}
                className="max-w-full bg-transparent text-lg font-semibold text-sol-text outline-none cursor-pointer"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {projectName(p)} ({p.count})
                  </option>
                ))}
              </select>
            ) : (
              <h1 className="text-xl font-semibold text-sol-text truncate">{summary ? projectName(summary) : "Memory"}</h1>
            )}
            <div className="font-mono text-[11px] text-sol-text-dim truncate">{project?.dir.replace(/^\/Users\/[^/]+/, "~")}</div>
          </div>
          {atlas && (
            <>
              {fit === "wide" && <Stat value={atlas.notes.length} label="memories" />}
              {fit === "wide" && <Stat value={atlas.edges.length} label="links" />}
              <Stat value={unreached} label="never reached" alarm={unreached > 0} onClick={() => go({ view: "health" })} />
              <BudgetMeter budget={atlas.index.budget} className={`${fit === "narrow" ? "w-44" : "w-52"} shrink-0`} />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-2.5 border-b border-sol-border/40">
          <div className="flex rounded-md border border-sol-border/60 overflow-hidden text-xs">
            {MEMORY_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => go({ view: v.id })}
                className={`px-3 py-1 inline-flex items-center gap-1.5 transition-colors ${view === v.id ? "bg-sol-cyan text-sol-bg" : "text-sol-text-muted hover:text-sol-text"}`}
              >
                {v.label}
                {v.id === "health" && health && healthAlarm(health) > 0 && (
                  <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${view === "health" ? "bg-sol-bg/25" : "bg-sol-red/15 text-sol-red"}`}>{healthAlarm(health)}</span>
                )}
              </button>
            ))}
          </div>
          <div className={`flex flex-wrap gap-1.5 ${fit === "narrow" ? "order-last basis-full" : ""}`}>
            {[...typeCounts.entries()].map(([t, count]) => {
              const off = hiddenTypes.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setHiddenTypes((s) => {
                      const next = new Set(s);
                      if (off) next.delete(t);
                      else next.add(t);
                      return next;
                    })
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border border-sol-border/50 px-2 py-0.5 text-[11px] transition-opacity ${off ? "opacity-40" : "text-sol-text-muted hover:text-sol-text"}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: toneCss(TYPE_TONE[t]) }} />
                  {t}
                  <span className="text-sol-text-dim tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
          <label className={`ml-auto relative ${fit === "narrow" ? "flex-1 min-w-[8rem]" : "w-64"}`}>
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-sol-text-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search memories"
              spellCheck={false}
              className="w-full bg-sol-bg border border-sol-border/60 rounded-md pl-8 pr-2 py-1 text-[13px] text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan transition-colors"
            />
          </label>
          <button type="button" onClick={() => open(NEW_MEMORY)} className="sol-btn sol-btn-primary text-xs px-3 py-1 inline-flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" />
            {fit === "narrow" ? "New" : "New memory"}
          </button>
        </div>

        <div className="flex-1 min-h-0 relative">
          {!atlas || loadingProject ? (
            <div className="h-full flex items-center justify-center text-sm text-sol-text-dim">Reading memories…</div>
          ) : view === "map" ? (
            <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-sol-text-dim">Drawing the map…</div>}>
              <MemoryMap atlas={atlas} visible={visible} active={openFile} onOpen={open} />
            </Suspense>
          ) : view === "index" ? (
            <MemoryIndexView atlas={atlas} onOpen={open} onEditIndex={() => open(MEMORY_INDEX_FILE)} focusLine={focusLine} />
          ) : view === "list" ? (
            <MemoryListView notes={shown} active={openFile} onOpen={open} />
          ) : (
            <MemoryHealthView atlas={atlas} onOpen={open} onJumpToLine={jumpToLine} />
          )}
        </div>
      </div>

      {atlas && openFile && (openFile === NEW_MEMORY || openFile === MEMORY_INDEX_FILE || atlas.byFile.has(openFile)) && (
        <EditorSlot fit={fit}>
          <MemoryEditor key={`${activeId}/${openFile}`} atlas={atlas} file={openFile} onOpen={open} onClose={close} onJumpToLine={jumpToLine} />
        </EditorSlot>
      )}
    </div>
  );
}

function Stat({ value, label, alarm, onClick }: { value: number; label: string; alarm?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <div className={`text-lg font-semibold tabular-nums leading-tight ${alarm ? "text-sol-red" : "text-sol-text"}`}>{value}</div>
      <div className="text-[11px] text-sol-text-dim">{label}</div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="text-right hover:opacity-80 transition-opacity">
      {body}
    </button>
  ) : (
    <div className="text-right">{body}</div>
  );
}

/** Beside the views when there is room for both; over them when there isn't. */
function EditorSlot({ fit, children }: { fit: Fit; children: ReactNode }) {
  if (fit === "wide") return <div className="w-[min(480px,38%)] shrink-0 min-h-0">{children}</div>;
  return (
    <div className={`absolute inset-y-0 right-0 z-20 min-h-0 bg-sol-bg shadow-2xl ${fit === "narrow" ? "left-0" : "w-[min(480px,70%)]"}`}>
      {children}
    </div>
  );
}
