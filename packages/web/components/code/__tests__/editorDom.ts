// A jsdom page CodeMirror can mount in. Install it before importing anything
// React or CodeMirror (dynamic imports after the call).
import { installModernDom } from "../../../test-helpers/modernDom";

/** Call at the top of each test file: the page is torn down after the file. */
export function installEditorDom(): void {
  const dom = installModernDom("https://app.test/files");
  // CodeMirror measures: `instanceof Window`, and range rects jsdom does not draw.
  (globalThis as any).Window = dom.window.Window;
  const noRects = { getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) };
  Object.assign(dom.window.Range.prototype, noRects);
}

/** Let async editor features (a language parser) land. */
export const settle = () => new Promise((r) => setTimeout(r, 20));
