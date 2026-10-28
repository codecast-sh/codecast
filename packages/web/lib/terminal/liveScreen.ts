// The live screen of an attached terminal pane, readable without loading
// xterm. termSessions registers its reader when it loads; until then no pane
// is attached, so there is nothing to read. The transcript's compaction card
// reads through here, which keeps xterm off the transcript renderer's import
// graph (and out of the SSR chunks the marketing prerender loads).
let reader: ((target: string) => string | null) | null = null;

export function setLiveScreenReader(fn: (target: string) => string | null): void {
  reader = fn;
}

/** The bottom of the buffer of the pane attached for `target` (tmux session name), or null. */
export function readLiveScreenText(target: string): string | null {
  return target && reader ? reader(target) : null;
}
