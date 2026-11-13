// The docs images, one entry each, in one file per batch (./batches/*.ts).
// `bun packages/web/scripts/docs-shots.ts` renders every entry from the docs
// shots server (lib/docsShots: the real app over the Acme fixture world),
// frames it through ./frame.html and writes the .webp. Adding an image is
// adding an entry to its batch. ./shots-desktop.json says what each docs
// image must show.
//
// Ids in routes come from the world (lib/acmeWorld), never from a real account.

import { MAIN_PAGE } from "./batches/main-page";
import { RECALL_SHOWING } from "./batches/recall-showing";
import { MACHINES_SHOTS } from "./batches/machines";
import { WORKING_TOGETHER_B } from "./batches/working-together-b";
import { TRACKING } from "./batches/tracking";
import { WORKING_TOGETHER_A } from "./batches/working-together-a";

export type Step =
  /** An expression run in the page; may return a promise. */
  | { js: string }
  /** A real click at the first element matching a CSS selector (and containing `text`). */
  | { click: string; text?: string }
  /** A right click there: context menus. */
  | { rightClick: string; text?: string }
  /** The pointer over it: hover cards and tooltips. */
  | { hover: string; text?: string }
  /** Text typed into whatever has focus. */
  | { type: string }
  /** A key press, with modifiers: "Meta+k", "Escape". */
  | { key: string }
  /** Wait until a CSS selector matches (and contains `text`). */
  | { wait: string; text?: string }
  /** Wait this many milliseconds (an opening animation). */
  | { sleep: number };

export type Shot = {
  /** Unique; picks the shot on the command line. */
  name: string;
  /** The batch file it lives in (set from the file); `--batch` picks one. */
  batch?: string;
  /** An app path on the docs shots server. Absent when `raw` supplies the capture. */
  route?: string;
  /** A capture made elsewhere (the phone's store shots), relative to the repo root; framed, never rendered here. */
  raw?: string;
  /** Default light (Verdigris); dark is Fjord. */
  theme?: "light" | "dark";
  /** CSS px. Default 1440x900. */
  viewport?: { width: number; height: number };
  /** Run after the route paints, before the capture. */
  steps?: Step[];
  /** Waited for before the steps; default the crop selector, else the app shell. */
  ready?: string;
  /** The whole viewport, or one element with padding in CSS px (`include` widens it to the last match of another selector). Default window. */
  crop?: "window" | { selector: string; pad?: number; include?: string };
  /** Show the session rail on the right. Default off. */
  rail?: boolean;
  /** frame.html's kind; "none" writes the raw capture (never under public/docs, where pages show images bare). */
  frame: "window" | "element" | "phone" | "none";
  /** The window frame's title bar. */
  title?: string;
  /** Output, relative to packages/web. */
  out: string;
  /** cwebp quality. Default 88. */
  quality?: number;
};

const batch = (name: string, shots: Shot[]) => shots.map((s) => ({ ...s, batch: name }));

export const SHOTS: Shot[] = [
  ...batch("main-page", MAIN_PAGE),
  ...batch("machines", MACHINES_SHOTS),
  ...batch("working-together-b", WORKING_TOGETHER_B),
  ...batch("tracking", TRACKING),
  ...batch("working-together-a", WORKING_TOGETHER_A),
  ...batch("recall-showing", RECALL_SHOWING),
];
