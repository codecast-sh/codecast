// Everything that touches @pierre/diffs, loaded only when a diff is first drawn
// (components/diff/pierre.ts loads it), so the library and the Shiki engine
// stay out of the app's first load.
//
// The theme is a Shiki CSS-variables theme whose token colors are the app's own
// highlight variables, so a diff follows the app's palette and its light/dark
// switch instead of the OS. The diff colors themselves (row backgrounds, word
// emphasis, selection) are set on `diffs-container` in globals.css.
import { useMemo } from "react";
import { getFiletypeFromFileName, preloadHighlighter, processFile, registerCustomCSSVariableTheme } from "@pierre/diffs";
import { FileDiff, useStableCallback, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { diffPatchText, type DiffModel } from "../../lib/diffModel";

const DIFF_THEME = "codecast";

// Once per page: a hot update re-runs this module, and Pierre's registry keeps
// the theme across it (and logs a second registration as an error).
if (!import.meta.hot?.data.themeRegistered) registerCustomCSSVariableTheme(DIFF_THEME, {
  foreground: "var(--sol-text)",
  background: "transparent",
  "token-constant": "var(--hljs-number)",
  "token-string": "var(--hljs-string)",
  "token-comment": "var(--hljs-comment)",
  "token-keyword": "var(--hljs-keyword)",
  "token-parameter": "var(--hljs-variable)",
  "token-function": "var(--hljs-function)",
  "token-string-expression": "var(--hljs-string)",
  "token-punctuation": "var(--sol-text-muted)",
  "token-link": "var(--hljs-type)",
});
if (import.meta.hot) import.meta.hot.data.themeRegistered = true;

// Fence labels and Prism grammar names that Shiki spells differently.
const SHIKI_LANGUAGE: Record<string, string> = { markup: "html" };

export function diffLanguage(name: string, language?: string): string {
  return language ? SHIKI_LANGUAGE[language] ?? language : getFiletypeFromFileName(name);
}

/** Load the theme and a language into the shared highlighter. A language
 *  Shiki cannot load rejects; the diff then draws plain. */
export function preloadDiffLanguage(lang: string): Promise<void> {
  return preloadHighlighter({ themes: [DIFF_THEME], langs: ["text", lang] });
}

export type PierreDiffProps<A> = {
  model: DiffModel;
  name: string;
  lang: string;
  theme: "light" | "dark";
  expandUnchanged: boolean;
  wrap: boolean;
  showLineNumbers: boolean;
  selectedLines?: SelectedLineRange | null;
  onLineSelected?: (range: SelectedLineRange | null) => void;
  onGutterUtilityClick?: (range: SelectedLineRange) => void;
  lineAnnotations: DiffLineAnnotation<A>[];
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => React.ReactNode;
};

export function PierreDiff<A>({
  model,
  name,
  lang,
  theme,
  expandUnchanged,
  wrap,
  showLineNumbers,
  selectedLines,
  onLineSelected,
  onGutterUtilityClick,
  lineAnnotations,
  renderAnnotation,
}: PierreDiffProps<A>) {
  const fileDiff = useMemo(() => {
    const files = model.whole && {
      oldFile: { name, contents: model.whole.oldStr },
      newFile: { name, contents: model.whole.newStr },
    };
    const meta = processFile(diffPatchText(model, name), files || undefined);
    if (!meta) throw new Error(`diff for ${name} did not parse`);
    meta.lang = lang;
    return meta;
  }, [model, name, lang]);

  // Pierre re-applies its options whenever their identity changes, so the
  // handlers it holds stay the same functions across renders.
  const selected = useStableCallback((range: SelectedLineRange | null) => onLineSelected?.(range));
  const gutterClick = useStableCallback((range: SelectedLineRange) => onGutterUtilityClick?.(range));
  const selectable = !!onLineSelected;
  const interactive = !!onGutterUtilityClick;

  const options = useMemo<FileDiffOptions<A, undefined>>(() => ({
    theme: DIFF_THEME,
    themeType: theme,
    diffStyle: "unified",
    diffIndicators: "classic",
    lineDiffType: "word-alt",
    // A whole file can open what it hides; a snippet or a patch has nothing
    // beyond its hunks, so its gaps are only marked.
    hunkSeparators: model.whole ? "line-info" : "simple",
    expandUnchanged,
    overflow: wrap ? "wrap" : "scroll",
    disableLineNumbers: !showLineNumbers,
    disableFileHeader: true,
    enableLineSelection: selectable,
    onLineSelected: selectable ? selected : undefined,
    enableGutterUtility: interactive,
    onGutterUtilityClick: interactive ? gutterClick : undefined,
  }), [theme, model.whole, expandUnchanged, wrap, showLineNumbers, selectable, interactive, selected, gutterClick]);

  return (
    <FileDiff<A, undefined>
      fileDiff={fileDiff}
      options={options}
      selectedLines={selectable ? selectedLines ?? null : undefined}
      lineAnnotations={lineAnnotations}
      renderAnnotation={renderAnnotation}
    />
  );
}
