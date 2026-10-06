// Codecast's host for the shared Evals views (@platform/evals/react): how a
// link moves the pane, how a key is bound and drawn, what a tooltip, a sheet
// or a before and after pair is, how a time reads, what the area shows while
// the daemon is out of reach, and codecast's own parts of a page (the run
// anatomy, the analyzer grade, the Multiplayer sim, the routes only codecast
// serves). The contract these slots fill is platform's (react/host.ts).
//
// `CodecastEvalsProvider` is the area's mount: platform's provider over the
// evals store, so the answers live in the store's memory-only cache and a
// failure that means the area cannot answer moves the store's connection.

import { useCallback, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderOpen, RotateCcw } from "lucide-react";
import type { RunResponse } from "@codecast/shared/contracts/evalsApi";
import { runCommands } from "@platform/evals/client";
import { EvalsProvider, TextPane, VerdictGlyph, type EvalsHost, type EvalsHostInput, type ExamplePairExample } from "@platform/evals/react";
import { toast } from "sonner";
import { SESSION_TRAILER_KEY, splitSessionTrailer } from "@codecast/shared/blame";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { landOn } from "../../hooks/useDiffAddress";
import { useTabActive, useTabVisible } from "../../hooks/usePagePresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatDuration, formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { useEvalsClient, useEvalsConnection, useEvalsResource } from "../../lib/evals/hooks";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { parseUnifiedDiffSections } from "../../lib/unifiedDiffParser";
import { copyToClipboard } from "../../lib/utils";
import { formatShortcutParts, getShortcutsForAction, hasOpenModal, isEditableTarget, useShortcuts, type ShortcutAction } from "../../shortcuts";
import { evalsResourceCache, onEvalsFailure, useEvalsStore } from "../../store/evalsStore";
import { codecastEvalsPaths, evalsHref } from "./evalsPaths";
import { HoverTip, useContainerWidth } from "../ActivityHeatmap";
import { ExamplePair } from "../decisions/ChangeCardView";
import { DiffView } from "../DiffView";
import { EmptyState } from "../EmptyState";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { LocalDaemonUnreachable } from "../LocalDaemonUnreachable";
import { useRepoLocation } from "../repo/useRepoFamily";
import { SegmentedToggle } from "../SegmentedToggle";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
import { useCodecastRunPanels } from "./runPanels";
import { SimFoot, simMoved } from "./wallSim";

/** The live line under a slow daemon's card: when the shell tries again on its own. */
function RetryCountdown({ at }: { at: number }) {
  const now = useCoarseNow(1_000);
  const secs = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <span className="text-[11.5px] ev-quiet ev-tabular" role="status" data-evals-retry-in={secs}>
      {secs > 0 ? `Trying again on its own in ${secs}s` : "Trying again..."}
    </span>
  );
}

/** The honest screen for each way the evals can be out of reach: no daemon, no checkout, a crashed child. */
function useCodecastConnection(): { state: string; screen: ReactNode | null } {
  const { connection, retry, retryAt } = useEvalsConnection();
  const reason = useEvalsStore((s) => s.unreachableReason);
  const detail = useEvalsStore((s) => s.unreachableDetail);
  const stderr = useEvalsStore((s) => s.stderr);
  let screen: ReactNode | null;
  if (connection === "connected") screen = null;
  else if (connection === "no-daemon")
    screen = (
      <LocalDaemonUnreachable what="Evals" reason={reason} detail={detail} onRetry={retry}>
        {retryAt !== null && <RetryCountdown at={retryAt} />}
      </LocalDaemonUnreachable>
    );
  else if (connection === "no-checkout") screen = <LocalDaemonUnreachable what="Evals" reason="no-checkout" detail={detail} onRetry={retry} />;
  else if (connection === "child-crashed") screen = <LocalDaemonUnreachable what="Evals" reason="child-crashed" detail={detail} stderr={stderr} onRetry={retry} />;
  else
    screen = (
      <div className="ev-note ev-note--center" data-evals-connecting>
        Finding the daemon on this machine...
      </div>
    );
  return { state: connection, screen };
}

/**
 * A change card's before and after pair. It sizes its columns by the nearest
 * `cc` container (changeCard.css: the two stack below 640px), which the change
 * card it was made for draws around it; here the host draws that container,
 * unless the view keeps the pair side by side.
 */
function ContainedExamplePair({ ex, stack = true }: { ex: ExamplePairExample; stack?: boolean }) {
  if (!stack) return <ExamplePair ex={ex} />;
  return (
    <div style={{ containerType: "inline-size", containerName: "cc" }}>
      <ExamplePair ex={ex} />
    </div>
  );
}

/** The analyzer's own grade of an org-review rep, at the foot of its Verdict tab. */
function AnalyzerGrade({ run }: { run: RunResponse }) {
  if (!run.extra) return null;
  return (
    <section className="ev-section" data-ev-extra>
      <h2 className="ev-title">
        <VerdictGlyph state="unscored" /> Analyzer grade
      </h2>
      {run.extra.gradeAuto !== undefined && <TextPane name="grade-auto.json" text={JSON.stringify(run.extra.gradeAuto, null, 2)} open />}
      {run.extra.hashes !== undefined && <TextPane name="hashes.json" text={JSON.stringify(run.extra.hashes, null, 2)} />}
    </section>
  );
}

/**
 * A codecast component as the slot types it. The shared views hand a slot the
 * neutral answer type; what reaches it is codecast's handler's answer, which
 * carries codecast's own fields (a run's `extra`, the overview's `sim`).
 */
type Slot<C> = C extends ComponentType<infer P> ? ComponentType<{ [K in keyof P]: any }> : never;

/** The registry's first binding of an action id (shortcuts/registry.ts), which names the context it fires in. */
const bindingOf = (action: string) => getShortcutsForAction(action as ShortcutAction)[0];

export const codecastEvalsHost = {
  basePath: codecastEvalsPaths.basePath,
  useNavigate() {
    const router = useRouter();
    return useCallback((href: string, opts?: { replace?: boolean }) => (opts?.replace ? router.replace(href, { scroll: false }) : router.push(href)), [router]);
  },
  useSearchParams,
  useHash: () => useRepoLocation().hash,
  useLandOn(target, getRoot, find, margin) {
    const args = useRef({ getRoot, find });
    args.current = { getRoot, find };
    useWatchEffect(() => {
      if (target === null) return;
      return landOn(() => args.current.getRoot(), (root) => args.current.find(root, target), () => margin);
    }, [target, margin]);
  },
  useShortcuts(map, enabled = true) {
    // The page's handlers change every render; the bindings change only with the set of ids.
    const { registerAction, setContext } = useShortcuts();
    const handlers = useRef(map);
    handlers.current = map;
    const ids = Object.keys(map).join(" ");
    useWatchEffect(() => {
      const actions = ids.split(" ") as ShortcutAction[];
      const contexts = [...new Set(actions.flatMap((a) => bindingOf(a)?.when ?? []))];
      if (enabled) for (const c of contexts) setContext(c, true);
      const off = actions.map((a) => registerAction(a, () => (enabled ? handlers.current[a]?.run() : false)));
      return () => {
        for (const o of off) o();
        if (enabled) for (const c of contexts) setContext(c, false);
      };
    }, [ids, enabled, registerAction, setContext]);
  },
  keyParts(action, keys) {
    const def = bindingOf(action);
    return def ? formatShortcutParts(def) : [keys];
  },
  keysBusy: (target) => hasOpenModal() || isEditableTarget(target),
  ui: {
    KeyCap,
    HoverTip,
    Sheet: { Root: Sheet, Content: SheetContent, Title: SheetTitle, Description: SheetDescription, Close: SheetClose },
    SegmentedToggle,
    ExamplePair: ContainedExamplePair,
    EmptyState,
    DiffView,
    SessionPill: ({ id }) => <EntityIdPill type="session" id={id} compact />,
  },
  // Codecast's runs live in run folders under EVALS_HOME, its public freezes under packages/evals.
  words: {
    wallLinks: "links to every surface, bisect and Multiplayer sim run",
    emptyWall: "Run ./evals check from the checkout and the wall fills in as the index reads the run folders.",
    unknownSurface: "The wall lists every surface this checkout's registry knows.",
    publicFreezes: "Freezes committed under packages/evals",
    privateFreezes: "Freezes kept only in EVALS_HOME",
    publicFreeze: "Public: committed under packages/evals",
    privateFreeze: "Private: kept in EVALS_HOME, never in git or a published page",
    missingRun: "names no run folder",
    fixtureSource: "Answered by the dev fixture world (localStorage EVALS_FIXTURE), not this machine's evals",
  },
  format: { duration: formatDuration, timeAgo: formatTimeAgo, relativeTime: formatRelativeTime, fullTimestamp: formatFullTimestamp },
  useNow: useCoarseNow,
  useVisible: useTabVisible,
  useActive: useTabActive,
  useContainerWidth,
  async copy(text) {
    await copyToClipboard(text);
    toast.success("Copied");
  },
  useConnection: useCodecastConnection,
  navSections: [{ key: "sim", label: "Multiplayer sim", href: evalsHref.sim() }],
  useSearchIndex: (q) => useEvalsResource("GET /search", q ? { query: { q } } : null).data,
  useRunFile(runId, path) {
    const file = useEvalsResource("GET /run/:id/file", runId ? { params: { id: runId }, query: { path } } : null);
    return { text: file.data?.text ?? null, loading: !!runId && file.loading };
  },
  usePatch(sha) {
    const res = useEvalsResource("GET /patch/:sha", { params: { sha } });
    return { data: res.data, loading: res.loading, error: res.error };
  },
  useBisectActions() {
    const { call } = useEvalsClient();
    return useMemo(
      () => ({
        plan: (body) => call("POST /bisect/plan", { body }),
        start: (body) => call("POST /bisect", { body }),
        stop: (id) => call("POST /bisect/:id/stop", { params: { id } }),
      }),
      [call],
    );
  },
  parseUnifiedDiff: parseUnifiedDiffSections,
  // Read the way blame reads it: the value is the session link as written, and anything but a full conversation id names nothing.
  commitSession: {
    id: (trailer) => splitSessionTrailer(`${SESSION_TRAILER_KEY}: ${trailer}`).session,
    strip: (message) => splitSessionTrailer(message).message,
  },
  useRunPanels: useCodecastRunPanels,
  run: {
    commands(row, evalsHome) {
      const c = runCommands(row, evalsHome);
      return [
        { text: c.path, what: "the run folder path", label: "path", icon: <FolderOpen /> },
        { text: c.replay, what: "the replay command", label: "replay", icon: <RotateCcw /> },
        { text: c.rescore, what: "the rescore command", label: "rescore" },
      ];
    },
    VerdictFoot: AnalyzerGrade as Slot<typeof AnalyzerGrade>,
  },
  wall: { moved: simMoved, movedKinds: ["Multiplayer sim failure"], Foot: SimFoot as Slot<typeof SimFoot> },
} satisfies EvalsHost;

/**
 * The shared views' provider over the evals store: answers are kept in the
 * store's cache, requests go out only while the store is connected (a crash
 * stops the loads), and a failed call moves the store's connection.
 */
export function CodecastEvalsProvider({ host = codecastEvalsHost, children }: { host?: EvalsHostInput; children: ReactNode }) {
  const transport = useEvalsStore((s) => (s.connection === "connected" ? s.transport : null));
  return (
    <EvalsProvider transport={transport} cache={evalsResourceCache} host={host} onFailure={onEvalsFailure}>
      {children}
    </EvalsProvider>
  );
}
