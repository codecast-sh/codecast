/**
 * Close a jsdom window and take its corpse off `globalThis`.
 *
 * A mount test installs jsdom's `window`/`document` as the globals, then closes
 * the window when it is done. `close()` tears out the window's internals but
 * leaves the object installed, so the next file that reads `window.location` or
 * `window.history` dies inside jsdom rather than in its own code:
 * "null is not an object (evaluating 'idlUtils.implForWrapper(window._document)._location')".
 * The file that closed the window passes; unrelated suites after it fail, which
 * is why this is only ever seen in a full run.
 *
 * Dropping the two globals restores the "no DOM here" state a plain store or
 * library suite expects, and the next mount test installs its own anyway.
 */
export function closeDomWindow(dom: { window: { close(): void } }): void {
  try {
    dom.window.close();
  } finally {
    for (const key of ["window", "document"]) {
      try {
        delete (globalThis as Record<string, unknown>)[key];
      } catch {
        // Installed non-configurable by an older helper: leave it rather than throw.
      }
    }
  }
}
