// Sizes the Files surface decides on before the editor chunk loads, so this
// module imports nothing.

/** The largest file the code editor opens. CodeMirror renders only the
 *  viewport, so the bound is memory and the parse, not drawing. */
export const CODE_EDITOR_MAX_BYTES = 16 * 1024 * 1024;
