// The seam between the shared Evals views and the app they render in. A view
// reads the app through `useEvalsHost()` and nothing else: where a link goes,
// how a key is bound and drawn, what a tooltip or a sheet is, how a time
// reads, and what the area shows while its data is out of reach. Every slot
// has a plain default (defaults.tsx), so a host fills only what it has.

import type { ComponentType, ReactNode, RefObject } from 'react';
import type { CadenceFilter, EvalsView } from '../client';
import type { BisectPlan, BisectPlanRequest, BisectStartRequest, BisectStartResponse, EvalFlip, MovedEvent, OverviewResponse, RunResponse, RunRowCore } from '../contract';

/** One key a page answers: the key it asks for, what it does, and the handler (false declines, so the key falls through). */
export interface EvalsShortcut {
  keys: string;
  label: string;
  run(): boolean | void;
}

/** The before and after of one flip, as the views hand it to the ExamplePair slot. */
export type ExamplePairExample = Pick<EvalFlip, 'input' | 'before' | 'after' | 'note'>;

/** One file of a parsed unified diff. Its hunks come from the host's parser and go back to the host's DiffView, so the views never read them. */
export interface DiffSection {
  filePath: string;
  hunks: any[];
  oldContent: string;
  newContent: string;
}

/** A kept tree patch, as the usePatch slot hands it over. */
export interface PatchView {
  sha: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** The patch text, cut where the host cuts it. */
  diff: string;
  truncated: boolean;
}

/** The bisect writes a host offers: price a plan, start it, stop it between reps. */
export interface BisectActions {
  plan(req: BisectPlanRequest): Promise<BisectPlan>;
  start(req: BisectStartRequest): Promise<BisectStartResponse>;
  stop(id: string): Promise<unknown>;
}

/** The primitives a view draws through. Each is typed by the props the views pass, so a host's own wider component fits. */
export interface EvalsUi {
  KeyCap: ComponentType<{ children: ReactNode; size?: 'sm' | 'xs' }>;
  /** A small label at a viewport point, portaled out of the area. */
  HoverTip: ComponentType<{ x: number; y: number; children: ReactNode }>;
  Sheet: {
    Root: ComponentType<{ open: boolean; onOpenChange(open: boolean): void; children?: ReactNode }>;
    Content: ComponentType<{ side?: 'top' | 'right' | 'bottom' | 'left'; hideClose?: boolean; className?: string; children?: ReactNode }>;
    Title: ComponentType<{ className?: string; children?: ReactNode }>;
    Description: ComponentType<{ className?: string; children?: ReactNode }>;
    Close: ComponentType<{ className?: string; 'aria-label'?: string; children?: ReactNode }>;
  };
  SegmentedToggle: ComponentType<{ value: string; onChange(key: string): void; items: Array<{ key: string; label?: string; title?: string; count?: number }> }>;
  /**
   * A before and after pair. By default it stacks when its own width is
   * narrow (a comparison list); `stack={false}` keeps the two side by side
   * at any width (a bisect's evidence card).
   */
  ExamplePair: ComponentType<{ ex: ExamplePairExample; stack?: boolean }>;
  EmptyState: ComponentType<{ title: string; description: string; action?: { label: string; href: string } }>;
  DiffView: ComponentType<{ oldStr?: string; newStr?: string; hunks?: any[]; showLineNumbers?: boolean; contextLines?: number }>;
  /** The session that wrote a commit, as the host names a session. */
  SessionPill: ComponentType<{ id: string }>;
}

/** One section of the area's local nav that a host adds after the shared ones (codecast: the Multiplayer sim). `key` is what evalsSection names its views. */
export interface EvalsNavSection {
  key: string;
  label: string;
  href: string;
}

export interface EvalsHost {
  /** Where the area is mounted: "/evals", "/admin/evals/v2". */
  basePath: string;
  /** Moves the pane the page sits in. A hook, because a host's router may be bound to a pane (a split sibling stays put). */
  useNavigate(): (href: string, opts?: { replace?: boolean }) => void;
  useSearchParams(): URLSearchParams;
  /** The address's fragment, "#guard" or "". */
  useHash(): string;
  /**
   * Each time `target` changes to a value: scrolls a root until `find`'s
   * element sits `margin` below its top, and holds it there while the page
   * settles. A null target lands nowhere.
   */
  useLandOn(target: string | null, getRoot: () => HTMLElement | null | undefined, find: (root: HTMLElement, target: string) => HTMLElement | null | undefined, margin: number): void;
  /** Binds a page's keys by action id while `enabled`. A host with a key registry binds the id; a plain one binds `keys`. */
  useShortcuts(map: Record<string, EvalsShortcut>, enabled?: boolean): void;
  /** The caps to draw for an action: the host's binding of the id, else `keys`. */
  keyParts(action: string, keys: string): string[];
  /** True while a key press belongs to a field or an open dialog, so a page's own key listener stands down. */
  keysBusy(target: EventTarget | null): boolean;
  ui: EvalsUi;
  format: {
    /** A span between two times: "4m", "1h 12m". */
    duration(startMs: number, endMs?: number): string;
    /** How long ago, bare: "3m", "2d" (the caller adds "ago"). */
    timeAgo(at: number, now?: number): string;
    /** How long ago, in words: "3m ago". */
    relativeTime(at: number, now?: number): string;
    fullTimestamp(at: number): string;
  };
  /** A clock that ticks every `granularityMs`. */
  useNow(granularityMs: number): number;
  /** Whether this pane is on screen: live polling pauses when it is not (the document's own visibility is read as well). */
  useVisible(): boolean;
  /** Whether this pane is the one the keys belong to. */
  useActive(): boolean;
  useContainerWidth(initial?: number): { ref: RefObject<HTMLDivElement | null>; width: number };
  /** Puts text on the clipboard and says so. */
  copy(text: string, label?: string): Promise<void>;
  /**
   * Whether the area can reach its data. `state` is stamped on the shell as
   * data-evals-connection; `screen` replaces the view while the data is out
   * of reach (null once connected). The default reads the provider's GET /health.
   */
  useConnection(): { state: string; screen: ReactNode | null };
  /**
   * The cadence filters the wall and a surface offer beside "all": one of the
   * product's cadences by name, or `named` for batches outside any cadence.
   * Without it: codecast's, nightly and by hand. Empty draws no filter.
   */
  cadences?: readonly CadenceFilter[];
  /** The host's own sections in the local nav, after Surfaces and Bisects. */
  navSections?: EvalsNavSection[];
  /**
   * What the search box finds that no page has loaded, for the text typed
   * (empty while shorter than three characters): freezes and runs by id
   * prefix (codecast: GET /search). Without it the box resolves what the
   * pages loaded.
   */
  useSearchIndex?(query: string): { freezes: Array<{ id: string; name: string }>; runs?: Array<{ id: string; surface: string; freezeName: string | null }> } | null;
  /**
   * One file a rep rendered, read by run id (codecast: GET /run/:id/file).
   * A null id reads nothing. Without it a prompt diff that has only run ids
   * says the files are not kept.
   */
  useRunFile?(runId: string | null, path: string): { text: string | null; loading: boolean };
  /**
   * A kept tree patch by its sha (codecast: GET /patch/:sha): the uncommitted
   * edits a dirty rep ran. Without it a patch says this product keeps none.
   */
  usePatch?(sha: string): { data: PatchView | null; loading: boolean; error: string | null };
  /**
   * What starts and stops a bisect (codecast: POST /bisect/plan, POST /bisect
   * and POST /bisect/:id/stop). A hook, so a host reaches its own client.
   * Without it the bisect pages only read: the free answer shows, with no
   * plan, no Start and no Stop.
   */
  useBisectActions?(): BisectActions;
  /** Splits a unified diff into its files (codecast: lib/unifiedDiffParser). Without it a commit shows its file list alone. */
  parseUnifiedDiff?(patch: string, files: string[]): DiffSection[];
  /**
   * How the host reads the session that wrote a commit, from the session
   * trailer git hands over (`CommitRef.session`, the raw value). Without it a
   * commit names no session and its message shows whole.
   */
  commitSession?: {
    /** The session id a trailer value names, or null for anything the host does not take as one. */
    id(trailer: string): string | null;
    /** A commit message with the host's session trailer lines taken out, since the pill already shows them. */
    strip(message: string): string;
  };
  /**
   * A host's own tabs under a run, after Verdict and Moment. A hook, so a
   * panel keeps its state (an open file) while the reader moves between tabs.
   */
  useRunPanels?(run: RunResponse<any>, ctx: RunPanelContext): RunPanel[];
  /** A host's own parts of the run page, beside the tabs `useRunPanels` adds. */
  run?: {
    /**
     * What the page offers to copy. Without it: the run's folder and the
     * replay of its freeze, platform's own fs layout and CLI. A host adds its
     * own (codecast: rescore), and a product whose runs have neither returns [].
     */
    commands?(row: RunRowCore, evalsHome: string | null): RunCommand[];
    /** Drawn at the foot of the Verdict tab, from the host's own fields of the run (codecast: the analyzer grade from `extra`). */
    VerdictFoot?: ComponentType<{ run: RunResponse<any> }>;
  };
  /**
   * A host's own parts of the surface wall. Without it the wall draws only the
   * surfaces, spend, bisects and moves every product shares.
   */
  wall?: {
    /** The line and mark of a What moved event of the host's own kind (OverviewResponse's M). */
    moved(e: MovedEvent | any): { href: string; text: string; mark: ReactNode };
    /** What the host's own kinds are called, for the line that says nothing moved. */
    movedKinds: string[];
    /** The host's blocks in the wall's foot, after Open bisects, drawn from its own overview fields. */
    Foot?: ComponentType<{ overview: OverviewResponse<any>; now: number }>;
  };
}

/** One tab a host adds under a run. */
export interface RunPanel {
  /** The tab's id, which is also its address (`#guard`). */
  id: string;
  label: string;
  /** A number beside the label. */
  count?: number;
  /** A dot on the tab, and the words that say why it is there. Null or absent draws none. */
  flag?: string | null;
  /** The tab's content, drawn while it is open. */
  body: ReactNode;
}

/** One thing the run page offers to copy, as a button. */
export interface RunCommand {
  text: string;
  /** What the toast says was copied: "the replay command". */
  what: string;
  /** The button's word: "replay". */
  label: string;
  icon?: ReactNode;
}

/** What the run page knows that a host's panels read. */
export interface RunPanelContext {
  /** The run the prompt files diff against: the same freeze in the previous prompt epoch, or why there is none. */
  previousEpoch: { id: string | null; why: string };
}

/** What a host hands the provider: any slot, and any part of `ui` and `format`; the rest are the defaults. */
export type EvalsHostInput = Partial<Omit<EvalsHost, 'ui' | 'format'>> & { ui?: Partial<EvalsUi>; format?: Partial<EvalsHost['format']> };

/** A page of the area: the view it draws, already parsed from the address. */
export type EvalsPage<V extends EvalsView['view'] = EvalsView['view']> = ComponentType<{ view: Extract<EvalsView, { view: V }> }>;

/** The pages for each view a group (or a host) draws. A view no page claims shows the "no page here" state. */
export type EvalsPages = { [V in Exclude<EvalsView['view'], 'not-found'>]?: EvalsPage<V> };
