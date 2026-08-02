// Vault editor: CodeMirror 6 over the note's exact bytes, in either of the two
// editing modes.
//
// LIVE PREVIEW renders the markdown in place and shows raw syntax only where
// the cursor is; SOURCE shows the file as it is, frontmatter included. They are
// the same editor — one document, one undo history, one save timer, with the
// live-preview decorations swapped in and out of a compartment — because
// switching modes mid-sentence must not lose an undo step or strand an edit in
// an unmounted buffer.
//
// The contract of both is byte fidelity: opening a note and saving it without
// typing writes nothing at all, and a note that is edited comes back with only
// the edited span changed. That rules out any round trip through a rich-text
// document model (see .claude/vault-drive/library-decisions.md #3) — and it is
// why live preview is decorations rather than rendering — and it's why the line
// separator is detected up front and carried back out at save time: CodeMirror
// splits on \n, \r\n and \r but always joins with "\n", so a CRLF note would
// otherwise be silently rewritten end to end.
//
// This module is behind a dynamic import (see VaultNoteView) — CodeMirror and
// the markdown parser are ~100kB that nobody who only reads notes should pay.
//
// Saving goes through vaultStore.writeFile like every other vault write, so an
// If-Match etag rides along and a 409 lands in the same conflicts map a rename
// rewrite would. Autosave is debounced; Cmd+S forces it now.

import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { cssVar, isDarkTheme, observeTheme, withAlpha } from "../../lib/solTheme";
import { detectLineSeparator, docChange } from "../../lib/vault/editorDoc";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import { parseNote } from "../../lib/vault/parseNote";
import { noteDisplayName } from "../../lib/vault/explorerModel";
import { livePreview, refreshLivePreview, type LivePreviewContext } from "../../lib/vault/livePreview";
import type { VaultEditMode } from "../../lib/vault/viewMode";
import { useVaultLinkCtx } from "./useVaultLinkCtx";
import type { VaultLinkContextValue } from "./VaultMarkdown";
import { useVaultStore, resolveRecentMove } from "../../store/vaultStore";

const AUTOSAVE_MS = 800;
// The word count re-parses the note to match the reading view's number exactly
// (markdown syntax excluded); at ~0.2ms a parse that's free, but not on every
// keystroke of a fast typist.
const WORD_COUNT_MS = 400;

type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "stale" | "error";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** A concrete color set read off the app's --sol-* tokens. CodeMirror styles
 *  are injected as real CSS rules, so they can't reference the variables the
 *  way a Tailwind class would — they need literal values, re-read whenever the
 *  theme flips. */
function solEditorTheme(): Extension {
  const s = getComputedStyle(document.documentElement);
  const bg = cssVar(s, "--sol-bg", "#fbf5e2");
  const bgAlt = cssVar(s, "--sol-bg-alt", "#eee8d5");
  const text = cssVar(s, "--sol-text", "#002b36");
  const muted = cssVar(s, "--sol-text-muted", "#586e75");
  const dim = cssVar(s, "--sol-text-dim", "#657b83");
  const border = cssVar(s, "--sol-border", "#93a1a1");
  const cyan = cssVar(s, "--sol-cyan", "#2aa198");
  const blue = cssVar(s, "--sol-blue", "#268bd2");
  const yellow = cssVar(s, "--sol-yellow", "#b58900");
  const green = cssVar(s, "--sol-green", "#859900");
  const violet = cssVar(s, "--sol-violet", "#6c71c4");
  const magenta = cssVar(s, "--sol-magenta", "#d33682");
  const selection = withAlpha(cyan, 0.22);

  return [
    EditorView.theme(
      {
        "&": {
          color: text,
          backgroundColor: "transparent",
          fontSize: "13px",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          padding: "0",
          lineHeight: "1.7",
          caretColor: cyan,
        },
        ".cm-line": { padding: "0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: cyan, borderLeftWidth: "2px" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
          backgroundColor: selection,
        },
        ".cm-activeLine": { backgroundColor: withAlpha(bgAlt, 0.45) },
        ".cm-selectionMatch": { backgroundColor: withAlpha(yellow, 0.2) },
        ".cm-searchMatch": {
          backgroundColor: withAlpha(yellow, 0.25),
          outline: `1px solid ${withAlpha(yellow, 0.5)}`,
        },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: withAlpha(cyan, 0.35) },
        ".cm-matchingBracket, .cm-nonmatchingBracket": {
          backgroundColor: withAlpha(cyan, 0.18),
          outline: "none",
        },
        // Search panel: the app's own chrome, not CodeMirror's default grey box.
        ".cm-panels": {
          backgroundColor: bgAlt,
          color: text,
          border: "none",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        },
        ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${withAlpha(border, 0.4)}` },
        ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "11px" },
        ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
          fontFamily: "inherit",
          fontSize: "11px",
        },
        ".cm-panel.cm-search input[type=text]": {
          backgroundColor: bg,
          color: text,
          border: `1px solid ${withAlpha(border, 0.4)}`,
          borderRadius: "3px",
          padding: "2px 6px",
          outline: "none",
        },
        ".cm-panel.cm-search input[type=text]:focus": { borderColor: cyan },
        ".cm-panel.cm-search button:not([name=close])": {
          backgroundColor: "transparent",
          backgroundImage: "none",
          color: muted,
          border: `1px solid ${withAlpha(border, 0.4)}`,
          borderRadius: "3px",
          padding: "2px 6px",
          cursor: "pointer",
        },
        ".cm-panel.cm-search button:not([name=close]):hover": { color: text, borderColor: cyan },
        ".cm-panel.cm-search [name=close]": { color: dim, fontSize: "14px", padding: "0 4px" },
        // Wiki-link completions.
        ".cm-tooltip.cm-tooltip-autocomplete": {
          backgroundColor: bg,
          border: `1px solid ${withAlpha(border, 0.5)}`,
          borderRadius: "4px",
          boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul": {
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "12px",
          maxHeight: "16em",
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", color: text },
        ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
          backgroundColor: withAlpha(cyan, 0.18),
          color: text,
        },
        ".cm-completionDetail": { color: dim, fontStyle: "normal", marginLeft: "8px" },
        ".cm-completionIcon": { display: "none" },
      },
      { dark: isDarkTheme() },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        // Markdown's own punctuation (#, **, backticks, list bullets) fades back
        // so the prose reads first — the one thing that makes a plain source
        // editor feel like a note editor.
        { tag: t.processingInstruction, color: dim },
        { tag: t.contentSeparator, color: dim },
        { tag: t.heading, color: text, fontWeight: "600" },
        { tag: t.heading1, color: text, fontWeight: "700", fontSize: "1.15em" },
        { tag: t.heading2, color: text, fontWeight: "700", fontSize: "1.07em" },
        { tag: t.strong, color: text, fontWeight: "700" },
        { tag: t.emphasis, color: text, fontStyle: "italic" },
        { tag: t.strikethrough, color: muted, textDecoration: "line-through" },
        { tag: [t.link, t.url], color: cyan },
        { tag: t.monospace, color: green },
        { tag: t.quote, color: muted, fontStyle: "italic" },
        { tag: t.list, color: blue },
        { tag: t.comment, color: dim, fontStyle: "italic" },
        { tag: [t.keyword, t.moduleKeyword], color: green },
        { tag: [t.string, t.special(t.string)], color: cyan },
        { tag: [t.number, t.bool, t.null], color: magenta },
        { tag: [t.typeName, t.className], color: yellow },
        { tag: [t.function(t.variableName), t.labelName], color: blue },
        { tag: [t.propertyName, t.attributeName], color: violet },
        { tag: t.invalid, color: cssVar(s, "--sol-red", "#dc322f") },
      ]),
    ),
  ];
}

// ---------------------------------------------------------------------------
// [[wiki link]] completion
// ---------------------------------------------------------------------------

/** Every note the vault knows, as completion options: basename first (the name
 *  a link uses), each frontmatter alias beside it. The label is what gets
 *  inserted, so an ambiguous basename inserts its path instead — exactly the
 *  disambiguation the link resolver would otherwise have to guess at. */
function noteCompletions(): Completion[] {
  const paths = vaultIndex.paths().filter(isVaultMarkdownPath);
  const byBasename = new Map<string, number>();
  for (const p of paths) {
    const base = noteDisplayName(p.split("/").pop()!).toLowerCase();
    byBasename.set(base, (byBasename.get(base) ?? 0) + 1);
  }
  const options: Completion[] = [];
  for (const path of paths) {
    const base = noteDisplayName(path.split("/").pop()!);
    const unique = (byBasename.get(base.toLowerCase()) ?? 0) === 1;
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    options.push({
      label: unique ? base : path.replace(/\.(md|markdown)$/i, ""),
      detail: dir || undefined,
      apply: applyLinkTarget,
      boost: unique ? 1 : 0,
    });
    for (const alias of vaultIndex.note(path)?.parsed?.aliases ?? []) {
      options.push({ label: alias, detail: `alias · ${base}`, apply: applyLinkTarget });
    }
  }
  return options;
}

/** Insert the target and close the brackets — unless closeBrackets already put
 *  a `]]` there when the user typed the second `[`, in which case step over it
 *  rather than leaving `[[Note]]]]`. */
function applyLinkTarget(view: EditorView, completion: Completion, from: number, to: number) {
  const closed = view.state.sliceDoc(to, to + 2) === "]]";
  const insert = closed ? completion.label : `${completion.label}]]`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length + (closed ? 2 : 0) },
    userEvent: "input.complete",
  });
}

function headingOptions(target: string, fromPath: string): Completion[] {
  const resolved = vaultIndex.resolveLink(target, fromPath);
  const headings = resolved ? (vaultIndex.note(resolved)?.parsed?.headings ?? []) : [];
  return headings.map((h) => ({
    label: h.text,
    detail: "#".repeat(h.level),
    apply: applyLinkTarget,
  }));
}

/** Completion inside `[[ … ]]`: note names before a `#`, that note's headings
 *  after one. A `|` means the user is writing display text — their words, not
 *  ours, so completion stops there. */
function wikiCompletionSource(fromPath: string) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const open = before.lastIndexOf("[[");
    if (open === -1) return null;
    const inner = before.slice(open + 2);
    if (inner.includes("]]") || inner.includes("|")) return null;
    const hash = inner.indexOf("#");
    if (hash !== -1) {
      const options = headingOptions(inner.slice(0, hash), fromPath);
      if (!options.length) return null;
      return {
        from: line.from + open + 2 + hash + 1,
        options,
        validFor: /^[^[\]|\n]*$/,
      };
    }
    return {
      from: line.from + open + 2,
      options: noteCompletions(),
      validFor: /^[^[\]#|\n]*$/,
    };
  };
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Live preview asks the same questions the reading view asks — where does this
 *  link point, where does this image live, what happens when it's clicked — so
 *  it gets its answers from the SAME builder (useVaultLinkCtx). A rendered wiki
 *  link that resolved differently in the two modes would be a bug nobody could
 *  explain.
 *
 *  Read through a ref rather than captured: the link context is rebuilt every
 *  time the vault index changes, and rebuilding this object would mean
 *  reconfiguring the editor on every index bump. The extension holds one stable
 *  object; freshness comes from a `refreshLivePreview` effect instead. */
function makeLiveContext(
  ref: MutableRefObject<VaultLinkContextValue>,
  openInNewTab: (path: string) => void,
): LivePreviewContext {
  return {
    resolveWiki: (parts) => {
      const res = ref.current.resolve(parts.target, parts);
      return { path: res.path, ambiguous: res.ambiguous };
    },
    assetUrl: (raw) =>
      ABSOLUTE_URL.test(raw) ? raw : ref.current.assetUrl(decodeURIComponent(raw)),
    openWikiLink: (parts, newTab) => {
      const res = ref.current.resolve(parts.target, parts);
      // A dangling link is an offer to write the note, the same offer the
      // reading view's faded link makes.
      if (!res.path) return ref.current.createNote?.(parts.target);
      if (newTab) return openInNewTab(res.path);
      ref.current.navigate(res.path, parts.subpath, parts.subpathType);
    },
    openTag: (tag) => ref.current.openTag?.(tag),
    openHref: (href, newTab) => {
      // A relative link to another note stays inside the app; anything with a
      // scheme is the web, and the web opens in its own tab.
      if (!ABSOLUTE_URL.test(href) && /\.(md|markdown)(#.*)?$/i.test(href)) {
        const clean = decodeURIComponent(href.split("#")[0]);
        if (newTab) openInNewTab(clean);
        else ref.current.navigate(clean);
        return;
      }
      window.open(href, "_blank", "noopener,noreferrer");
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Source mode's half of the compartment. A shared constant, not a fresh `[]`
 *  each render, for the same identity reason as `liveExt`. */
const NO_LIVE_PREVIEW: Extension = [];

const MODE_LABEL: Record<VaultEditMode, string> = {
  live: "live preview",
  source: "source",
};

const STATUS_SUFFIX: Record<SaveStatus, string> = {
  clean: "",
  dirty: " · unsaved",
  saving: " · saving…",
  saved: " · saved",
  stale: " · changed on disk",
  error: " · couldn't save",
};

export function VaultEditor({
  path,
  mode,
  onExit,
  onNavigate,
}: {
  path: string;
  mode: VaultEditMode;
  onExit: () => void;
  /** Following a rendered wiki link in live preview. */
  onNavigate: (path: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeRef = useRef(new Compartment());
  // Live preview lives in its own compartment so switching modes reconfigures
  // ONE extension instead of rebuilding the editor — undo history, the save
  // timer and the etag this buffer is editing on top of all survive the switch.
  const liveRef = useRef(new Compartment());
  // The document as CodeMirror holds it (line breaks normalized to "\n") that
  // corresponds to what's on disk. Everything dirty/clean is decided against
  // this; file bytes are only reconstituted at write time.
  const savedRef = useRef("");
  // The etag of the version this editor is EDITING ON TOP OF — its half of a
  // compare-and-swap. bodies[path].etag is NOT usable at save time: an external
  // clean write (link rewrite, WS echo) refreshes it, and saving with the
  // fresh etag would silently clobber that write (review finding, R8). This
  // ref only advances when the editor itself saves or adopts.
  const baseEtagRef = useRef("");
  const sepRef = useRef<"\n" | "\r\n">("\n");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wordCountAt = useRef(0);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [words, setWords] = useState(0);

  const conflict = useVaultStore((s) => s.conflicts[path]);
  const body = useVaultStore((s) => s.bodies[path]);

  const linkCtx = useVaultLinkCtx(path, onNavigate);
  const linkCtxRef = useRef(linkCtx);
  linkCtxRef.current = linkCtx;
  // Built once and kept: CodeMirror resolves a reconfiguration by extension
  // IDENTITY, so a stable value makes "reconfigure to the mode you are already
  // in" free, and switching back to live preview reuses the same plugin rather
  // than tearing one down and building another.
  const [liveExt] = useState<Extension>(() =>
    livePreview(
      makeLiveContext(linkCtxRef, (p) =>
        window.open(`/vault?f=${encodeURIComponent(p)}`, "_blank", "noopener,noreferrer"),
      ),
    ),
  );
  const modeExt = mode === "live" ? liveExt : NO_LIVE_PREVIEW;

  // The path this editor should write to RIGHT NOW: itself, unless the file
  // was renamed under us (autosave firing mid-rename would otherwise write to
  // a path that no longer exists — a guarded PUT there 409s and the text is
  // stranded). Returns null when the file is simply gone (deleted).
  const writeTarget = useCallback((): string | null => {
    const st = useVaultStore.getState();
    if (st.bodies[path] !== undefined) return path;
    return resolveRecentMove(path);
  }, [path]);

  const saveNow = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const view = viewRef.current;
    if (!view) return;
    // An unedited note writes NOTHING — the byte-fidelity promise in its
    // cheapest form.
    const docText = view.state.doc.toString();
    if (docText === savedRef.current) return;
    const target = writeTarget();
    if (!target) return; // the file is gone; nothing to write to
    // A conflict is an open question about which version wins; retrying the
    // same stale etag every 800ms just answers it wrong, repeatedly.
    if (useVaultStore.getState().conflicts[target]) {
      setStatus("stale");
      return;
    }
    const previous = savedRef.current;
    savedRef.current = docText;
    setStatus("saving");
    try {
      await useVaultStore
        .getState()
        .writeFile(
          target,
          view.state.doc.sliceString(0, view.state.doc.length, sepRef.current),
          baseEtagRef.current || undefined,
        );
      const after = useVaultStore.getState();
      if (after.conflicts[target]) {
        // writeFile RESOLVES on a 409 (it files the conflict instead of
        // throwing). Leaving savedRef advanced would mark the buffer clean and
        // the unsaved text would vanish at unmount — roll back so it stays
        // dirty and recoverable from the conflict strip (review finding, R8).
        savedRef.current = previous;
        if (viewRef.current === view) setStatus("stale");
        return;
      }
      baseEtagRef.current = after.bodies[target]?.etag ?? baseEtagRef.current;
      if (viewRef.current !== view) return; // the editor moved on to another note
      setStatus("saved");
    } catch {
      savedRef.current = previous;
      if (viewRef.current === view) setStatus("error");
    }
  }, [path, writeTarget]);

  // Adopt an incoming version wholesale, keeping the cursor where the text
  // around it didn't move.
  const adopt = useCallback((content: string) => {
    const view = viewRef.current;
    if (!view) return;
    baseEtagRef.current = useVaultStore.getState().bodies[path]?.etag ?? baseEtagRef.current;
    sepRef.current = detectLineSeparator(content);
    const incoming = sepRef.current === "\r\n" ? content.split("\r\n").join("\n") : content;
    const change = docChange(view.state.doc.toString(), incoming);
    if (change) view.dispatch({ changes: change });
    // Read back rather than trusting `incoming`: CodeMirror is the authority on
    // what the document now holds, and clean/dirty is decided against it.
    savedRef.current = view.state.doc.toString();
  }, []);

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = useVaultStore.getState().bodies[path]?.content ?? "";
    sepRef.current = detectLineSeparator(initial);
    const doc = sepRef.current === "\r\n" ? initial.split("\r\n").join("\n") : initial;
    setWords(parseNote(initial).wordCount);

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(),
          highlightSpecialChars(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          rectangularSelection(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          search({ top: true }),
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(true),
          // Fenced code blocks aren't highlighted per language: that needs
          // @codemirror/language-data, which drags in a language package per
          // supported syntax. Markdown structure highlights either way.
          markdown({ base: markdownLanguage }),
          autocompletion({ override: [wikiCompletionSource(path)], icons: false }),
          themeRef.current.of(solEditorTheme()),
          liveRef.current.of(modeExt),
          // Order matters: closing a completion or a search panel with Escape
          // has to win over leaving the editor, and each of those returns false
          // when there's nothing of its own to close.
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void saveNow();
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                onExit();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setStatus(update.state.doc.toString() === savedRef.current ? "clean" : "dirty");
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              // The count the typist ends on is the one they look at, so it's
              // recomputed once more when the typing stops.
              const current = viewRef.current;
              if (current) setWords(parseNote(current.state.doc.toString()).wordCount);
              void saveNow();
            }, AUTOSAVE_MS);
            const now = Date.now();
            if (now - wordCountAt.current > WORD_COUNT_MS) {
              wordCountAt.current = now;
              setWords(parseNote(update.state.doc.toString()).wordCount);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    // What CodeMirror ACTUALLY parsed the file into is the baseline, not what
    // we handed it. Any normalization it applied (a stray lone \r) is then part
    // of the clean state instead of registering as an unsaved edit.
    savedRef.current = view.state.doc.toString();
    baseEtagRef.current = useVaultStore.getState().bodies[path]?.etag ?? "";
    view.focus();

    const stopTheme = observeTheme(() =>
      view.dispatch({ effects: themeRef.current.reconfigure(solEditorTheme()) }),
    );

    return () => {
      stopTheme();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      // Leaving the editor inside the autosave window must not drop the edit —
      // but the file may have MOVED (rename remounts the editor via key). The
      // flush follows the move; a write to the old path would resurrect a
      // ghost file there with the freshest keystrokes (review finding, R8).
      // Etag = content hash, so the base survives the rename unchanged. A path
      // that's simply gone (deleted) gets no write at all.
      const docText = view.state.doc.toString();
      const st = useVaultStore.getState();
      const target = st.bodies[path] !== undefined ? path : resolveRecentMove(path);
      // (same resolution as writeTarget(); inlined so teardown captures no hook)
      if (target && docText !== savedRef.current && !st.conflicts[target]) {
        void st
          .writeFile(
            target,
            view.state.doc.sliceString(0, view.state.doc.length, sepRef.current),
            baseEtagRef.current || undefined,
          )
          .catch(() => {});
      }
      viewRef.current = null;
      view.destroy();
    };
  });

  // Switching between live preview and source: one compartment, no remount.
  // The initial configuration already matches, so this only ever does work on a
  // real change of mode.
  useWatchEffect(() => {
    viewRef.current?.dispatch({ effects: liveRef.current.reconfigure(modeExt) });
  }, [modeExt]);

  // A note appearing or being renamed elsewhere in the vault turns a dangling
  // wiki link live (or the reverse) without a character of THIS note changing —
  // so the decorations have to be asked again, since nothing else would.
  const indexVersion = useVaultIndexVersion();
  useWatchEffect(() => {
    if (mode === "live") viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [indexVersion, mode]);

  // The note changed underneath us — a WS echo of another writer, a link
  // rewrite from a rename, our own save coming back. Clean: adopt it in place.
  // Dirty: leave every character alone and say so; the next save carries the
  // etag we opened with, so disk answers 409 and the conflict strip below
  // becomes the place where the two versions get reconciled.
  useWatchEffect(() => {
    const view = viewRef.current;
    if (!view || body === undefined) return;
    const sep = detectLineSeparator(body.content);
    const incoming = sep === "\r\n" ? body.content.split("\r\n").join("\n") : body.content;
    const docText = view.state.doc.toString();
    if (incoming === docText) {
      savedRef.current = incoming;
      baseEtagRef.current = body.etag || baseEtagRef.current;
      return;
    }
    if (docText !== savedRef.current) {
      setStatus("stale");
      return;
    }
    adopt(body.content);
    setWords(parseNote(body.content).wordCount);
    setStatus("clean");
  }, [body, adopt]);

  const takeDisk = useCallback(() => {
    const disk = useVaultStore.getState().conflicts[path];
    if (!disk) return;
    adopt(disk.content);
    setWords(parseNote(disk.content).wordCount);
    useVaultStore.getState().resolveConflictWithDisk(path);
    setStatus("clean");
  }, [path, adopt]);

  const keepMine = useCallback(() => {
    setStatus("saving");
    useVaultStore
      .getState()
      .resolveConflictKeepMine(path)
      .then(() => setStatus("saved"))
      .catch(() => setStatus("error"));
  }, [path]);

  return (
    <div data-vault-editor>
      {conflict && (
        <div className="mb-3 rounded border border-sol-yellow/40 bg-sol-yellow/10 px-3 py-2 text-[11px] text-sol-text-muted">
          <div className="text-sol-text mb-1.5">
            This note changed on disk while you were editing it.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={keepMine}
              className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text hover:border-sol-cyan transition-colors"
            >
              Keep my version
            </button>
            <button
              type="button"
              onClick={takeDisk}
              className="px-2 py-0.5 rounded border border-sol-border/40 hover:border-sol-cyan hover:text-sol-text transition-colors"
            >
              Use the version on disk
            </button>
            <span className="text-sol-text-dim">Keeping yours overwrites the file.</span>
          </div>
        </div>
      )}
      <div ref={hostRef} />
      <div className="mt-6 pt-2 border-t border-sol-border/20 flex items-center gap-3 text-[10px] text-sol-text-dim">
        <span className={status === "error" || status === "stale" ? "text-sol-yellow" : undefined}>
          {MODE_LABEL[mode]}
          {STATUS_SUFFIX[status]}
        </span>
        <span className="tabular-nums">{words} words</span>
      </div>
    </div>
  );
}

export default VaultEditor;
