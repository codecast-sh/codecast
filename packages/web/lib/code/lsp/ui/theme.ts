// Every surface the language features draw (quick pick, peek list, rename
// input, hover, signature help, squiggles, gutter marks, the server chip), in
// the app's sol tokens and editor font, dense and quiet. Scoped to the editor:
// every overlay is mounted inside the view's own DOM.

import { EditorView } from "@codemirror/view";
import { EDITOR_FONT } from "../../theme";
import { LINT_GUTTER_COLUMN } from "../../gutterSlots";

const mix = (color: string, pct: number) => `color-mix(in srgb, var(${color}) ${pct}%, transparent)`;
const border = `1px solid ${mix("--sol-border", 45)}`;

export const lspTheme = EditorView.theme({
  // ── squiggles and gutter ────────────────────────────────────────────────
  ".cm-lintRange": { backgroundImage: "none", textDecorationLine: "underline", textDecorationStyle: "wavy", textDecorationSkipInk: "none", textUnderlineOffset: "3px", textDecorationThickness: "1px" },
  ".cm-lintRange-error": { textDecorationColor: "var(--sol-red)" },
  ".cm-lintRange-warning": { textDecorationColor: "var(--sol-yellow)" },
  ".cm-lintRange-info": { textDecorationColor: "var(--sol-blue)" },
  ".cm-lintRange-hint": { textDecorationStyle: "dotted", textDecorationColor: "var(--sol-text-dim)" },
  ".cm-lsp-unnecessary": { opacity: "0.55", textDecorationLine: "none" },
  ".cm-gutter-lint": LINT_GUTTER_COLUMN,
  ".cm-gutter-lint .cm-gutterElement": { padding: "0", display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-lint-marker": { width: "6px", height: "6px", borderRadius: "50%", content: "none" },
  ".cm-lint-marker-error": { background: "var(--sol-red)" },
  ".cm-lint-marker-warning": { background: "var(--sol-yellow)" },
  ".cm-lint-marker-info": { background: "var(--sol-blue)" },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": { padding: "4px 8px", borderLeft: "2px solid transparent", fontSize: "12px", whiteSpace: "pre-wrap", maxWidth: "640px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--sol-red)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--sol-yellow)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": { borderLeftColor: "var(--sol-blue)" },
  ".cm-diagnosticSource": { color: "var(--sol-text-dim)", fontSize: "11px", opacity: "1" },

  // ── hover, completion docs, signature help ──────────────────────────────
  ".cm-lsp-documentation": { padding: "6px 10px", fontSize: "12px", lineHeight: "1.5", maxWidth: "560px", maxHeight: "320px", overflow: "auto" },
  ".cm-lsp-documentation p, .cm-lsp-documentation pre": { margin: "4px 0" },
  ".cm-lsp-documentation pre": { whiteSpace: "pre-wrap", fontFamily: EDITOR_FONT },
  ".cm-lsp-documentation code": { fontFamily: EDITOR_FONT, fontSize: "12px" },
  ".cm-lsp-documentation a": { color: "var(--sol-blue)" },
  ".cm-lsp-documentation hr": { border: "none", borderTop: border, margin: "6px -10px" },
  ".cm-lsp-documentation > pre:first-child": { paddingBottom: "6px", borderBottom: border, margin: "0 -10px 6px", padding: "0 10px 6px" },
  ".cm-lsp-documentation > pre:only-child": { border: "none", margin: "0 -10px", paddingBottom: "0" },
  ".cm-lsp-signature-tooltip": { padding: "4px 8px", maxWidth: "560px", fontSize: "12px" },
  ".cm-lsp-signature-tooltip .cm-lsp-signature": { fontFamily: EDITOR_FONT },
  ".cm-lsp-signature-tooltip .cm-lsp-active-parameter": { color: "var(--sol-cyan)", fontWeight: "600" },
  ".cm-lsp-signature-tooltip .cm-lsp-signature-num": { color: "var(--sol-text-dim)" },
  ".cm-lsp-message": { fontFamily: EDITOR_FONT, fontSize: "11px" },
  ".cm-lsp-message-error": { color: "var(--sol-red)" },

  // ── overlays mounted in the editor ──────────────────────────────────────
  ".cm-lsp-overlay": {
    position: "absolute",
    zIndex: "300",
    background: "var(--sol-bg)",
    color: "var(--sol-text)",
    border,
    borderRadius: "6px",
    boxShadow: `0 8px 24px ${mix("--sol-text", 14)}`,
    fontFamily: EDITOR_FONT,
    fontSize: "12px",
    overflow: "hidden",
  },
  ".cm-lsp-pick": { top: "8px", left: "50%", transform: "translateX(-50%)", width: "min(560px, calc(100% - 24px))" },
  ".cm-lsp-pick input": {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    border: "none",
    borderBottom: border,
    background: "transparent",
    color: "inherit",
    font: "inherit",
    padding: "7px 10px",
    outline: "none",
  },
  ".cm-lsp-list": { position: "relative", overflowY: "auto", overscrollBehavior: "contain" },
  ".cm-lsp-row": {
    position: "absolute",
    left: "0",
    right: "0",
    height: "24px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 10px",
    whiteSpace: "nowrap",
    cursor: "pointer",
    boxSizing: "border-box",
  },
  ".cm-lsp-row[aria-selected=true]": { background: mix("--sol-cyan", 16) },
  ".cm-lsp-row:hover:not([aria-selected=true])": { background: mix("--sol-bg-alt", 70) },
  ".cm-lsp-row-group": { color: "var(--sol-text-muted)", cursor: "default", fontWeight: "600", background: "transparent !important" },
  ".cm-lsp-kind": { width: "14px", flexShrink: "0", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: "11px" },
  ".cm-lsp-kind svg, .cm-lsp-counts svg": { display: "block", flexShrink: "0" },
  ".cm-lsp-label": { overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" },
  ".cm-lsp-label mark": { background: "none", color: "var(--sol-cyan)", fontWeight: "700" },
  ".cm-lsp-detail": { color: "var(--sol-text-dim)", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0", flexShrink: "1" },
  ".cm-lsp-hint": { marginLeft: "auto", paddingLeft: "12px", color: "var(--sol-text-dim)", flexShrink: "0", fontVariantNumeric: "tabular-nums" },
  ".cm-lsp-lineno": { minWidth: "3.5em", textAlign: "right", color: "var(--sol-text-dim)", flexShrink: "0", fontVariantNumeric: "tabular-nums" },
  ".cm-lsp-empty": { padding: "8px 10px", color: "var(--sol-text-dim)" },
  ".cm-lsp-sev-error": { color: "var(--sol-red)" },
  ".cm-lsp-sev-warning": { color: "var(--sol-yellow)" },
  ".cm-lsp-sev-info, .cm-lsp-sev-hint": { color: "var(--sol-blue)" },

  // ── peek panel (references, problems) ───────────────────────────────────
  ".cm-panel.cm-lsp-peek": { fontFamily: EDITOR_FONT, fontSize: "12px", borderTop: border, outline: "none" },
  ".cm-lsp-peek-head": { display: "flex", alignItems: "center", gap: "10px", height: "26px", padding: "0 10px", color: "var(--sol-text-muted)", borderBottom: border },
  ".cm-lsp-peek-title": { color: "var(--sol-text)", fontWeight: "600" },
  ".cm-lsp-peek-count": { fontVariantNumeric: "tabular-nums" },
  ".cm-lsp-peek-close": { marginLeft: "auto", background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: "0 4px" },
  ".cm-lsp-peek-close:hover": { color: "var(--sol-text)" },
  ".cm-lsp-code": { color: "var(--sol-text-muted)", overflow: "hidden", textOverflow: "ellipsis", minWidth: "0" },
  ".cm-lsp-code strong": { color: "var(--sol-text)", fontWeight: "600", background: mix("--sol-yellow", 22), borderRadius: "2px" },

  // ── rename ──────────────────────────────────────────────────────────────
  ".cm-tooltip.cm-lsp-rename": { padding: "3px", border: `1px solid var(--sol-cyan)`, borderRadius: "4px" },
  ".cm-lsp-rename input": { font: "inherit", fontFamily: EDITOR_FONT, fontSize: "12px", border: "none", outline: "none", background: "transparent", color: "var(--sol-text)", padding: "1px 4px", width: "220px" },

  // ── notices ─────────────────────────────────────────────────────────────
  ".cm-lsp-notice": { top: "8px", right: "12px", maxWidth: "min(420px, calc(100% - 24px))", padding: "6px 0" },
  ".cm-lsp-notice-head": { display: "flex", alignItems: "center", gap: "8px", padding: "0 10px" },
  ".cm-lsp-notice-dot": { width: "6px", height: "6px", borderRadius: "50%", background: "var(--sol-green)", flexShrink: "0" },
  ".cm-lsp-notice[data-tone=warn] .cm-lsp-notice-dot": { background: "var(--sol-yellow)" },
  ".cm-lsp-notice[data-tone=error] .cm-lsp-notice-dot": { background: "var(--sol-red)" },
  ".cm-lsp-notice .cm-lsp-row": { position: "static" },
  ".cm-lsp-notice button": { font: "inherit", background: "none", border: "none", color: "var(--sol-text-dim)", cursor: "pointer", padding: "0 2px" },

  // ── server chip and its card ────────────────────────────────────────────
  ".cm-lsp-chip": { display: "inline-flex", alignItems: "center", gap: "5px" },
  ".cm-lsp-chip-dot": { width: "6px", height: "6px", borderRadius: "50%", background: "var(--sol-text-dim)", flexShrink: "0" },
  ".cm-lsp-chip[data-status=ready] .cm-lsp-chip-dot": { background: "var(--sol-green)" },
  ".cm-lsp-chip[data-status=indexing] .cm-lsp-chip-dot, .cm-lsp-chip[data-status=starting] .cm-lsp-chip-dot, .cm-lsp-chip[data-status=restarting] .cm-lsp-chip-dot": { background: "var(--sol-yellow)" },
  ".cm-lsp-chip[data-status=crashed] .cm-lsp-chip-dot, .cm-lsp-chip[data-status=unresponsive] .cm-lsp-chip-dot": { background: "var(--sol-red)" },
  ".cm-lsp-chip[data-status=unavailable] .cm-lsp-chip-dot, .cm-lsp-chip[data-status=off] .cm-lsp-chip-dot, .cm-lsp-chip[data-status=offline] .cm-lsp-chip-dot": { background: "transparent", boxShadow: "inset 0 0 0 1px var(--sol-text-dim)" },
  ".cm-lsp-chip-detail": { color: "var(--sol-text-dim)", fontVariantNumeric: "tabular-nums" },
  ".cm-lsp-chip[data-status=crashed] .cm-lsp-chip-detail, .cm-lsp-chip[data-status=unresponsive] .cm-lsp-chip-detail": { color: "var(--sol-red)" },
  ".cm-lsp-counts": { display: "inline-flex", alignItems: "center", gap: "8px", fontVariantNumeric: "tabular-nums" },
  ".cm-lsp-counts > span": { display: "inline-flex", alignItems: "center", gap: "3px" },
  ".cm-lsp-counts [data-zero]": { opacity: "0.55" },
  ".cm-lsp-card": { bottom: "28px", width: "300px", padding: "8px 0 6px" },
  ".cm-lsp-card-grid": { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "12px", rowGap: "3px", padding: "0 10px 8px" },
  ".cm-lsp-card-grid dt": { color: "var(--sol-text-dim)" },
  ".cm-lsp-card-grid dd": { margin: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" },
  ".cm-lsp-card-hint": { margin: "0 10px 8px", padding: "4px 6px", background: mix("--sol-bg-alt", 80), borderRadius: "3px", whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "text" },
  ".cm-lsp-card-actions": { display: "flex", gap: "6px", padding: "6px 10px 0", borderTop: border },
  ".cm-lsp-card-actions button": {
    font: "inherit",
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "4px",
    border,
    background: "transparent",
    color: "var(--sol-text)",
    cursor: "pointer",
  },
  ".cm-lsp-card-actions button:hover": { borderColor: "var(--sol-cyan)" },
});
