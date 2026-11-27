// Types shared by the vimrc parser, the translator and the engine glue.

export type VimDirectiveStatus = "applied" | "translated" | "skipped";

/** One directive of a vimrc as the Settings report shows it. */
export interface VimDirectiveReport {
  /** 1-based line where the directive starts (continuations fold into it). */
  line: number;
  text: string;
  status: VimDirectiveStatus;
  /** applied: what took effect; translated: to what; skipped: why. A few words. */
  detail: string;
}

export interface VimReportCounts {
  applied: number;
  translated: number;
  skipped: number;
  total: number;
}

export interface VimSourceReport {
  path: string;
  sourcedFrom?: string;
  overlay?: boolean;
  truncated?: boolean;
  directives: VimDirectiveReport[];
  counts: VimReportCounts;
}

/** Options the editor (not the vim engine) honors, as the vimrc set them.
 *  Absent means the config never set it, so the editor keeps its own default. */
export interface VimOptionValues {
  tabstop?: number;
  shiftwidth?: number;
  softtabstop?: number;
  expandtab?: boolean;
  number?: boolean;
  relativenumber?: boolean;
  wrap?: boolean;
  linebreak?: boolean;
  scrolloff?: number;
  sidescrolloff?: number;
  colorcolumn?: string;
  cursorline?: boolean;
  list?: boolean;
  listchars?: string;
  iskeyword?: string;
  textwidth?: number;
}

export interface VimResolvedOptions {
  global: VimOptionValues;
  /** Keyed by vim filetype (`python`, `typescriptreact`), from `autocmd FileType`. */
  byFiletype: Record<string, VimOptionValues>;
}

export interface VimConfigReport {
  sources: VimSourceReport[];
  counts: VimReportCounts;
  options: VimResolvedOptions;
  /** The leaders in effect at the end of the config, in key notation. */
  leader: string;
  localLeader: string;
  /** True when no source had any directive: the person has no vimrc. */
  empty: boolean;
}

/** codemirror-vim's map contexts. `undefined` is normal + visual + op-pending. */
export type VimMapContext = "normal" | "visual" | "operatorPending" | "insert" | undefined;

/** What a directive does once applied. Effects are plain data so a parsed
 *  config can be applied, removed and applied again. */
export type VimEffect =
  | { kind: "map"; context: VimMapContext; lhs: string; rhs: string; noremap: boolean; nowait: boolean }
  | { kind: "unmap"; context: VimMapContext; lhs: string }
  | { kind: "engineOption"; name: "textwidth" | "langmap"; value: string | number }
  | { kind: "timeout"; ms: number | null }
  | { kind: "clipboard"; on: boolean }
  | { kind: "exAlias"; name: string; body: string };

export interface ParsedDirective extends VimDirectiveReport {
  effects: VimEffect[];
}

export interface ParsedSource {
  path: string;
  sourcedFrom?: string;
  overlay?: boolean;
  truncated?: boolean;
  directives: ParsedDirective[];
}

export interface ParsedVimrc {
  sources: ParsedSource[];
  options: VimResolvedOptions;
  leader: string;
  localLeader: string;
}

/** What `has()` answers. A browser editor is a GUI and is not nvim; the
 *  platform is the reader's own machine. */
export interface VimEnvironment {
  platform: "mac" | "linux" | "windows";
}

/** Mode names for the status bar. */
export type VimMode = "normal" | "insert" | "visual" | "visual line" | "visual block" | "replace" | "op-pending";
