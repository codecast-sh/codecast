// A project's flow says how it differs from the flow it extends, one line per
// edit (docs/architecture/pipeline.md PL3): a station added after or before
// another, guidance added to an inherited prompt, a prompt or script replaced,
// a station that runs only when the change touches some paths, a station
// skipped. The parser records each edit a variant makes (parser.ts inherit);
// `cast flow edit` prints the ones it made as a ```flow {"edit": FlowEdit}
// fence the transcript draws (PL5).

export type FlowEditOp = "add" | "guide" | "prompt" | "run" | "skip" | "when" | "undo";

export type FlowEditChange = {
  op: FlowEditOp;
  /** The station's id as the variant writes it (`lint`, `review`, `review__review`). */
  station: string;
  /** The station's name, when the edit knows it. */
  label?: string;
  /** add: the station it follows on the passing path. */
  after?: string;
  /** add: the station it comes before. */
  before?: string;
  /** add: where a failure goes, when not the anchor's own way back. */
  fix?: string;
  /** when: the paths the change must touch for the station to run. */
  paths?: string[];
  /** guide: the guidance text as the station reads it, appended after the inherited prompt (and the station it landed on). */
  text?: string;
  node?: string;
  /** Who made the edit: a `cast flow edit` command, the app, or a person writing the file. */
  by?: "command" | "app" | "hand";
};

/** What `cast flow edit` prints: the file it wrote, the graph it now builds, the edits it made. */
export type FlowEdit = {
  /** The flow's slug. */
  flow: string;
  /** The project's flow file, relative to the repository's root. */
  file: string;
  graph_hash: string;
  /** The slug (or file) the flow extends. */
  base: string;
  changes: FlowEditChange[];
};

/** The fence body a transcript draws an edit from: ```flow {"edit": {...}}. */
export type FlowEditFence = { edit: FlowEdit };

/** Splits `when=` paths: "landing/**, backend/src/routes/**". */
export const whenPaths = (spec: string): string[] => spec.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** One edit as words: "+ Lint after Check", "~ Review: guidance added", "Decide skipped", "Lint runs when landing/**". */
export function flowEditWords(c: FlowEditChange, labelOf: (id: string) => string = (id) => id): string {
  const name = c.label ?? labelOf(c.station);
  switch (c.op) {
    case "add": return `+ ${name} ${c.before ? `before ${labelOf(c.before)}` : `after ${labelOf(c.after ?? "")}`}${c.fix ? `, failing to ${labelOf(c.fix)}` : ""}`;
    case "guide": return `~ ${name}: guidance added`;
    case "prompt": return `~ ${name}: prompt replaced`;
    case "run": return `~ ${name}: runs a new command`;
    case "skip": return `${name} skipped`;
    case "when": return c.paths?.length ? `${name} runs when ${c.paths.join(", ")}` : `${name} always runs`;
    case "undo": return `${name}: back to the base`;
  }
}
