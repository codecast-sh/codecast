// The seam between the Evals views and the app they render in. A view reads
// the app through `useEvalsHost()` and nothing else: where a link goes, how a
// key is bound and drawn, what a tooltip or a sheet is, how a time reads, and
// what the area shows while it cannot reach its data. The views then carry no
// import of the app's own, which is what lets them move to @platform/evals
// (docs/architecture/evals-converge.md) and render in another product.
//
// The first half is the contract (it moves with the views); the second is
// codecast's host. The slots that hold a component are typed by codecast's
// own components for now, so a view switches to a slot without changing a prop.

import { createContext, useCallback, useContext, useState, type ComponentType, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { landOn } from "../../hooks/useDiffAddress";
import { useTabActive, useTabVisible } from "../../hooks/usePagePresence";
import { formatDuration, formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { useEvalsConnection } from "../../lib/evals/hooks";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { parseUnifiedDiffSections } from "../../lib/unifiedDiffParser";
import { copyToClipboard } from "../../lib/utils";
import { formatShortcutParts, getShortcutsForAction, hasOpenModal, isEditableTarget, useShortcutAction, useShortcutContext, type ShortcutAction } from "../../shortcuts";
import { useEvalsStore } from "../../store/evalsStore";
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

// ── The contract ────────────────────────────────────────────────────────────

/** One key a page answers: the key it asks for, what it does, and the handler (false declines, so the key falls through). */
export interface EvalsShortcut {
  keys: string;
  label: string;
  run(): boolean | void;
}

export interface EvalsHost {
  /** Where the area is mounted: "/evals". */
  basePath: string;
  /** Moves the pane the page sits in. A hook, because both routers are (a split sibling stays put). */
  useNavigate(): (href: string, opts?: { replace?: boolean }) => void;
  useSearchParams(): URLSearchParams;
  /** The address's fragment, "#guard" or "". */
  useHash(): string;
  /** Scrolls a root until an element sits a margin below its top, and holds it there while the page settles. Returns the cancel. */
  landOn(getRoot: () => HTMLElement | null | undefined, find: (root: HTMLElement) => HTMLElement | null | undefined, margin: (el: HTMLElement, root: HTMLElement) => number): () => void;
  /** Binds a page's keys by action id while `enabled`. A host with a key registry binds the id; a plain one binds `keys`. The set of ids must not change between renders. */
  useShortcuts(map: Record<string, EvalsShortcut>, enabled?: boolean): void;
  /** The caps to draw for an action: the host's binding of the id, else `keys`. */
  keyParts(action: string, keys: string): string[];
  /** True while a key press belongs to a field or an open dialog, so a page's own key listener stands down. */
  keysBusy(target: EventTarget | null): boolean;
  ui: {
    KeyCap: typeof KeyCap;
    HoverTip: typeof HoverTip;
    Sheet: { Root: typeof Sheet; Content: typeof SheetContent; Title: typeof SheetTitle; Description: typeof SheetDescription; Close: typeof SheetClose };
    SegmentedToggle: typeof SegmentedToggle;
    ExamplePair: typeof ExamplePair;
    EmptyState: ComponentType<{ title: string; description: string; action?: { label: string; href: string } }>;
    DiffView: typeof DiffView;
    /** The session that wrote a commit, as the host names a session. */
    SessionPill: ComponentType<{ id: string }>;
  };
  format: {
    /** A span between two times: "4m", "1h 12m". */
    duration(startMs: number, endMs?: number): string;
    /** How long ago, bare: "3m", "2d" (the caller adds "ago"). */
    timeAgo(at: number, now?: number): string;
    /** How long ago, in words: "3 minutes ago". */
    relativeTime(at: number, now?: number): string;
    fullTimestamp(at: number): string;
  };
  /** A clock that ticks every `granularityMs`, shared by everything on that tick. */
  useNow(granularityMs: number): number;
  /** Whether this pane is on screen: live polling pauses when it is not. */
  useVisible(): boolean;
  /** Whether this pane is the one the keys belong to. */
  useActive(): boolean;
  useContainerWidth: typeof useContainerWidth;
  /** Puts text on the clipboard and says so. */
  copy(text: string, label?: string): Promise<void>;
  /**
   * Whether the area can reach its data. `state` is what the shell stamps on
   * itself; `screen` replaces the view while the data is out of reach (null
   * once connected).
   */
  useConnection(): { state: string; screen: ReactNode | null };
  parseUnifiedDiff?: typeof parseUnifiedDiffSections;
  /** A host's own panels under a run: codecast's run anatomy, another product's own. */
  runPanels?(run: unknown): ReactNode;
}

const EvalsHostContext = createContext<EvalsHost | null>(null);

export function EvalsHostProvider({ host, children }: { host: EvalsHost; children: ReactNode }) {
  return <EvalsHostContext.Provider value={host}>{children}</EvalsHostContext.Provider>;
}

/** The app the view renders in. Outside a provider (a view mounted alone in a test) it is codecast's. */
export function useEvalsHost(): EvalsHost {
  return useContext(EvalsHostContext) ?? codecastEvalsHost;
}

/** The one copy behaviour every Evals copy control shares: the host's clipboard and notice, and a check mark for a moment. */
export function useCopy(text: string): [copied: boolean, copy: () => Promise<void>] {
  const host = useEvalsHost();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await host.copy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return [copied, copy];
}

// ── Codecast's host ─────────────────────────────────────────────────────────

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

/** The registry's first binding of an action id (shortcuts/registry.ts), which names the context it fires in. */
const bindingOf = (action: string) => getShortcutsForAction(action as ShortcutAction)[0];

export const codecastEvalsHost: EvalsHost = {
  basePath: "/evals",
  useNavigate() {
    const router = useRouter();
    return useCallback((href: string, opts?: { replace?: boolean }) => (opts?.replace ? router.replace(href, { scroll: false }) : router.push(href)), [router]);
  },
  useSearchParams,
  useHash: () => useRepoLocation().hash,
  landOn,
  useShortcuts(map, enabled = true) {
    // The ids are a literal on each page, so the hook order holds across renders.
    const actions = Object.keys(map);
    for (const context of new Set(actions.map((a) => bindingOf(a)?.when).filter((c): c is NonNullable<typeof c> => !!c))) useShortcutContext(context, enabled);
    for (const action of actions) useShortcutAction(action as ShortcutAction, () => (enabled ? map[action].run() : false));
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
    ExamplePair,
    EmptyState,
    DiffView,
    SessionPill: ({ id }) => <EntityIdPill type="session" id={id} compact />,
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
  parseUnifiedDiff: parseUnifiedDiffSections,
};
