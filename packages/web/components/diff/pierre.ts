// How DiffView reaches @pierre/diffs without putting it in the app's first
// load, and how a page finds a line inside a drawn diff.
import { useSyncExternalStore } from "react";
import type { DiffLineAnchor } from "../../lib/patchParser";
import type { PierreDiff as PierreDiffComponent } from "./PierreDiff";

type PierreModule = typeof import("./PierreDiff");

// The renderer for a file, once Pierre and the file's language are loaded.
//
// A diff mounts Pierre only after both. Mounted earlier, Pierre's first render
// comes back empty and waits on the highlighter; if React detaches and
// reattaches the element meanwhile (a Suspense boundary above it hiding and
// showing again), the next instance finds that empty <pre>, takes it for
// server-rendered content and never draws. Mounted after, the first render is
// complete, synchronous and already highlighted. Until then DiffView shows its
// rows as plain text. A language Shiki cannot load counts once the attempt
// settles: Pierre draws it plain.
let pierre: PierreModule | null = null;
const settled = new Set<string>();
const started = new Set<string>();
const listeners = new Set<() => void>();
const keyFor = (name: string, language?: string) => language ?? name;

function load(name: string, language?: string) {
  const key = keyFor(name, language);
  if (started.has(key)) return;
  started.add(key);
  import("./PierreDiff")
    .then((m) => {
      pierre = m;
      return m.preloadDiffLanguage(m.diffLanguage(name, language)).catch(() => {});
    })
    .catch(() => {})
    .then(() => {
      settled.add(key);
      for (const listener of listeners) listener();
    });
}

export type DiffRenderer = { PierreDiff: typeof PierreDiffComponent; lang: string };

export function useDiffRenderer(name: string, language?: string): DiffRenderer | null {
  const ready = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      load(name, language);
      return () => listeners.delete(onChange);
    },
    () => settled.has(keyFor(name, language)),
    () => false,
  );
  return ready && pierre ? { PierreDiff: pierre.PierreDiff, lang: pierre.diffLanguage(name, language) } : null;
}

// Pierre draws each diff inside a shadow root of a `diffs-container`, which a
// document query cannot see into. These walk the diffs under `scope` so a page
// can still find a line to scroll to, or read which line sits at the top of a
// pane.

/** Every rendered line under `scope`, in document order, with its side and number. */
export function diffLineElements(scope: ParentNode): Array<{ el: HTMLElement; anchor: DiffLineAnchor }> {
  const out: Array<{ el: HTMLElement; anchor: DiffLineAnchor }> = [];
  for (const host of scope.querySelectorAll<HTMLElement>("diffs-container")) {
    for (const el of host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code] [data-line]") ?? []) {
      const lineNumber = Number(el.dataset.line);
      if (!Number.isFinite(lineNumber)) continue;
      const side = el.dataset.lineType === "change-deletion" ? "LEFT" : "RIGHT";
      out.push({ el, anchor: { side, lineNumber } });
    }
  }
  return out;
}

/** The rendered line an anchor names, if the diff under `scope` shows it. */
export function findDiffLine(scope: ParentNode, anchor: DiffLineAnchor): HTMLElement | null {
  return diffLineElements(scope).find(({ anchor: a }) => a.side === anchor.side && a.lineNumber === anchor.lineNumber)?.el ?? null;
}
