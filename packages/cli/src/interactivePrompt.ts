// Reading an agent's TUI menu off a captured pane: numbered AskUserQuestion
// menus, confirmation interstitials, Claude Code's unnumbered select dialogs,
// the two limit dialogs that are parks rather than questions, and the prose the
// assistant wrote above a pending question. Pure functions over pane text; the
// daemon captures the pane and acts on what these return.
import { isUsageLimitDialog } from "@codecast/shared/contracts";

// `unnumbered`: the menu's rows carry no digits, so an answer must move the
// highlight (selectHighlightedOption) rather than press a digit. `detail`: the
// dialog's own explanatory text between its title and its options.
export type InteractivePrompt = { question: string; options: Array<{ label: string; description?: string }>; isConfirmation?: boolean; header?: string; firstOptionIdx?: number; multiSelect?: boolean; unnumbered?: boolean; detail?: string };

// Unicode "Box Drawing" block (┌┐└┘─│ …). An AskUserQuestion option's `preview`
// renders as a box to the RIGHT of the options; tmux capture-pane flattens those
// columns onto the option rows, so naive parsing captures "│ … │" as a description.
// Such content is never an option's own description — we drop it so a scraped card
// never carries box-drawing glyphs (the full-fidelity card comes from the JSONL).
const BOX_DRAWING_CHARS = /[─-╿]/;

// Newer AskUserQuestion menus print a short label "chip" on its own line above the
// question — e.g. "□ Stale pending policy". The glyph is a box/ballot character
// (NOT in the Box Drawing block, so BOX_DRAWING_CHARS won't catch it). The web card
// renders this as `header`; the scrape used to drop it so scraped cards had no chip.
const HEADER_CHIP = /^[□☐☑☒▢▣◻◼◽◾■]\s*(.+)$/;
// ▔/▁ are the top/bottom edges of newer dialog frames (Block Elements, outside the
// Box Drawing range). capture-pane -J can also glue a full-width rule onto the text
// row that follows it, so RULE_RUN strips leading/trailing runs off heading lines.
const SEPARATOR_LINE = /^[─━═▔▁\-_]{5,}$/;
const RULE_RUN_EDGE = /^[─━═▔▁\-_]{3,}\s*|\s*[─━═▔▁\-_]{3,}$/g;

// A multiSelect AskUserQuestion renders a checkbox between the number and the
// label — "1. [ ] Restart" / "2. [x] Redeploy" (or a unicode ballot box). It's a
// selection-state glyph, not part of the label, so strip it off the front. Only a
// 0-or-1-char bracket pair counts, so real bracketed labels like "[Recommended]"
// survive.
const CHECKBOX_PREFIX = /^\s*(?:\[[ xX*✓✔·]?\]|[□☐☑☒▢▣◻◼◽◾])\s*/;
// Claude Code appends two synthetic affordance rows to every AskUserQuestion menu:
// a free-text "Type something" row and a "Chat about this" escape hatch. They carry
// no real description — and the free-text row renders a "Submit" button beneath it
// that must not be scraped as its description.
const SYNTHETIC_OPTION = /^(?:type something\.?|chat about this)$/i;

// Key-hint rows of a real interactive dialog footer ("Enter to select · ↑/↓ to
// navigate · Esc to cancel"). A row qualifies only on a STRONG hint or two weaker
// ones together: these sessions talk ABOUT terminal UIs, so prose like "←/→ to
// move between chips" or a lone "Esc to cancel" spec line is routine conversation
// content, and a loose any-hint scan is how numbered prose answers became poll
// cards (conv jx795ez, then again conv jx730d3).
const FOOTER_HINT_STRONG = /enter to (confirm|select)|(?:press\s+)?n\s+to\s+add\s+notes|[↑↓]\s*\/\s*[↑↓]\s*to\s+(navigate|select|choose)|arrow keys to (navigate|select|choose)/i;
const FOOTER_HINT_WEAK = [/↑\s*\/?\s*↓/, /←\s*\/?\s*→/, /esc(ape)?\s+to\s+(exit|cancel)/i, /tab to switch/i, /arrow keys/i];
export function isMenuFooterRow(line: string): boolean {
  if (FOOTER_HINT_STRONG.test(line)) return true;
  let weak = 0;
  for (const atom of FOOTER_HINT_WEAK) if (atom.test(line)) weak++;
  return weak >= 2;
}
// Markers of the composer's hint bar — by the time one of these is on screen
// below the "options", we're looking at the prompt area, not a blocking dialog.
const COMPOSER_BAR = /\?\s+for shortcuts|shift\+tab to cycle|bypass permissions|accept edits on|plan mode on|esc to interrupt/i;
// Rows that exist only while the agent UI is LIVE and unblocked: the working
// spinner ("✢ Actualizing… (3m 6s · …)" — flush-left glyph) and the composer
// caret ("❯" bare or with a typed draft). A blocking dialog REPLACES the composer
// and spinner, so any of these BELOW a candidate menu is structural proof the
// "menu" is scrolled conversation content, not a live dialog. The caret regex
// exempts "❯ 1." cursor-on-option rows and the cursor parked on a synthetic row.
// "✻ Waiting for API response · will retry in 2m 40s" carries the same glyph
// but is painted UNDER a blocking dialog (the safeguards "Session paused"
// menu, 2026-09-15), so it proves nothing about the composer.
const SPINNER_ROW = /^[✻✶✢✳✽·]\s+(?!Waiting for API response)\S/;
export const COMPOSER_CARET_ROW = /^\s?❯(?!\s*\d+[.)]\s)(?!\s*(?:Chat about this|Type something))/;

function structuralComposerBelow(lines: string[], fromIdx: number): boolean {
  const caret = /^\s?[❯›](?!\s*\d+[.)]\s)(?!\s*(?:Chat about this|Type something))/;
  const footerAfter = (idx: number) => lines.slice(idx + 1).some(line =>
    isMenuFooterRow(line) || /(?:press\s+)?enter\s+to\s+(continue|confirm|proceed|accept)/i.test(line));
  for (let top = 0; top < lines.length; top++) {
    if (!SEPARATOR_LINE.test(lines[top].trim())) continue;
    let prompt = top + 1;
    while (prompt < lines.length && !lines[prompt].trim()) prompt++;
    if (!caret.test(lines[prompt] ?? "")) continue;
    for (let bottom = lines.length - 1; bottom > Math.max(prompt, fromIdx); bottom--) {
      if (SEPARATOR_LINE.test(lines[bottom].trim()) && !footerAfter(bottom)) return true;
    }
  }
  return lines.slice(fromIdx + 1).some((line, offset) =>
    (caret.test(line) || SPINNER_ROW.test(line)) && !footerAfter(fromIdx + 1 + offset));
}

// True when any live-composer row sits below `fromIdx` — the pane is not blocked
// on a dialog there. Box-art rows are skipped (a dialog's right-hand preview box
// can contain arbitrary text, including hint-like glyphs).
function liveComposerBelow(lines: string[], fromIdx: number, structural = false): boolean {
  if (structural) return structuralComposerBelow(lines, fromIdx);
  for (let i = fromIdx + 1; i < lines.length; i++) {
    if (BOX_DRAWING_CHARS.test(lines[i])) continue;
    if (COMPOSER_BAR.test(lines[i]) || SPINNER_ROW.test(lines[i]) || COMPOSER_CARET_ROW.test(lines[i])) return true;
  }
  return false;
}

// A real menu's footer renders inside the dialog, below the options, separated only
// by dialog chrome: blank rows, rules, the right-hand preview's box art, indented
// continuation/description rows, or the synthetic free-text rows. Hunting for hints
// in the whole tail below the options is how a prose answer with numbered section
// headings became a poll: its "options" sat mid-pane and the scan picked up
// hint-like text from the composer/status region dozens of rows further down. Walk
// down only while rows stay dialog-shaped; anything else (an assistant ⏺ bullet,
// the ❯ composer, a shell prompt) means we left the dialog without meeting a footer.
export function menuFooterBelowOptions(lines: string[], lastOptionIdx: number, structural = false): boolean {
  for (let i = lastOptionIdx + 1, cap = Math.min(lines.length, lastOptionIdx + 41); i < cap; i++) {
    if (!structural && COMPOSER_BAR.test(lines[i])) return false;
    if (isMenuFooterRow(lines[i])) return true;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const dialogish = SEPARATOR_LINE.test(trimmed) || BOX_DRAWING_CHARS.test(lines[i])
      || /^\s{2,}/.test(lines[i]) || SYNTHETIC_OPTION.test(trimmed);
    if (!dialogish) return false;
  }
  return false;
}

// Pull the header chip and the (possibly multi-line) question out of the lines above
// the first option. The question can wrap across several rows; the menu renderer
// breaks it mid-sentence, so taking only the last line truncated it. Walk upward from
// the first option, stitching contiguous text until a blank line, separator, cursor
// row, or the chip bounds it — anything past those belongs to a prior turn. The chip
// itself can sit a blank line above the question, so scan for it independently.
function extractPromptHeading(lines: string[], firstOptionIdx: number): { header?: string; question: string } {
  const start = Math.max(0, firstOptionIdx - 8);
  let header: string | undefined;
  for (let i = firstOptionIdx - 1; i >= start; i--) {
    const chip = lines[i].trim().match(HEADER_CHIP);
    if (chip) { header = chip[1].trim(); break; }
  }
  const qLines: string[] = [];
  for (let i = firstOptionIdx - 1; i >= start; i--) {
    const trimmed = lines[i].trim();
    if (HEADER_CHIP.test(trimmed)) break;
    if (!trimmed) { if (qLines.length) break; else continue; }
    if (/^[❯>]/.test(trimmed) || SEPARATOR_LINE.test(trimmed)) break;
    // -J join can fuse a full-width dialog rule onto the question's own row
    // ("▔▔▔… What do you want to do?") — strip edge runs; a row that was ONLY
    // a short rule is chrome and bounds the question like a separator.
    const deRuled = trimmed.replace(RULE_RUN_EDGE, "").trim();
    if (!deRuled) { if (qLines.length) break; else continue; }
    qLines.unshift(deRuled);
  }
  const question = qLines.join(" ") || header || "Select an option";
  return { header, question };
}

export function parseInteractivePrompt(text: string, structural = false): InteractivePrompt | null {
  const lines = text.split("\n");
  // '›' (U+203A) belongs here alongside '❯': codex draws its menu cursor with it.
  // Without it the cursor ROW of a codex menu fails to parse, so a three-option
  // menu reads as two options with no cursor — enough to miss the menu entirely
  // and let the readiness poll declare the pane idle while a modal is up.
  const optionPattern = /^\s*[❯›>)]*\s*(\d+)[.)]\s+(.+?)(?:\s{2,}(.+?))?$/;
  const options: Array<{ label: string; description?: string }> = [];
  let firstOptionIdx = -1;
  let lastOptionIdx = -1;
  let gapCount = 0;
  let hasCursorIndicator = false;
  // Any option row carrying a checkbox glyph marks the menu as multiSelect. This
  // matters because a pending AskUserQuestion never reaches the session JSONL on
  // Claude Code ≥2.1.201 (the tool_use is only written once answered), so the live
  // card is always scrape/sidecar-sourced — and the hook sidecar goes stale after
  // 5 minutes, leaving this glyph as the only multiSelect signal.
  let hasCheckbox = false;
  // The AskUserQuestion menu renders each option's description on indented
  // continuation lines BELOW the numbered label. We scan bottom-up, so those
  // lines arrive before their option; buffer them and attach on the next match.
  let pendingDesc: string[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(optionPattern);
    if (m) {
      if (lastOptionIdx < 0) lastOptionIdx = i;
      firstOptionIdx = i;
      if (/^\s*[❯›>]\s*\d/.test(lines[i])) hasCursorIndicator = true;
      if (CHECKBOX_PREFIX.test(m[2])) hasCheckbox = true;
      const label = m[2]
        .replace(CHECKBOX_PREFIX, "")        // multiSelect checkbox: "[ ]" / "[x]" / "☐"
        .replace(/\s*[✓✗✔☑]\s*/g, "")        // stray selection glyphs anywhere
        .trim();
      if (label.length > 200) { pendingDesc = []; continue; }
      // A same-line trailing segment is a real description only if it isn't the
      // right-hand preview box flattened onto this row (see BOX_DRAWING_CHARS).
      const inlineDesc = m[3]?.trim();
      const descParts = [
        inlineDesc && !BOX_DRAWING_CHARS.test(inlineDesc) ? inlineDesc : undefined,
        ...pendingDesc,
      ].filter((s): s is string => !!s);
      // The synthetic "Type something" / "Chat about this" rows never have a real
      // description; the "Submit" button under the free-text row would otherwise be
      // mis-scraped as one.
      const description = SYNTHETIC_OPTION.test(label)
        ? undefined
        : descParts.length ? descParts.join(" ") : undefined;
      if (label) options.unshift({ label, description });
      pendingDesc = [];
      gapCount = 0;
    } else if (options.length > 0) {
      const trimmed = lines[i].trim();
      // A continuation/description line is indented past the flush-left question.
      // multiSelect menus indent descriptions only 2 spaces — the same column as
      // non-cursor option rows ("  2.") — so the old 4-space floor treated every
      // such description as prose and broke the bottom-up scan, dropping options.
      const isIndented = /^\s{2,}/.test(lines[i]);
      const isSeparator = /^[─━═\-_]{3,}$/.test(trimmed);
      // A row carrying any box-drawing glyph is the side-panel preview, not a
      // continuation of the option's description — treat it as a gap, not text.
      const isBoxArt = BOX_DRAWING_CHARS.test(trimmed);
      if (trimmed && isIndented && !isSeparator && !isBoxArt && trimmed.length <= 300) {
        // Indented continuation line = description for the option just above it.
        pendingDesc.unshift(trimmed);
      } else if (!trimmed || isIndented || isSeparator || isBoxArt) {
        gapCount++;
        if (gapCount > 8) break;
      } else {
        break;
      }
    }
  }

  // Structural gate for both paths: a live composer/spinner below the candidate
  // proves the pane is NOT blocked on a dialog — the "menu"/"hint" is scrolled
  // conversation content. Content checks alone can't make this call (prose here
  // routinely contains literal key-hint text).
  if (options.length >= 2 && firstOptionIdx >= 0 && !liveComposerBelow(lines, lastOptionIdx, structural)) {
    const hasFooter = menuFooterBelowOptions(lines, lastOptionIdx, structural);
    if (hasCursorIndicator || hasFooter) {
      const { header, question } = extractPromptHeading(lines, firstOptionIdx);
      return { question, options, firstOptionIdx, ...(header ? { header } : {}), ...(hasCheckbox ? { multiSelect: true } : {}) };
    }
  }

  // Detect confirmation prompts: "Press Enter to continue..." / "Esc to cancel"
  const tailLines = lines.slice(-15);
  const joined = tailLines.join("\n");
  const enterMatch = joined.match(/(?:press\s+)?enter\s+to\s+(continue|confirm|proceed|accept)[\s.…]*/i);
  const escMatch = joined.match(/esc(?:ape)?\s+to\s+(cancel|exit|quit|go back)[\s.…]*/i);
  if (enterMatch && !(structural ? structuralComposerBelow(lines, -1) : tailLines.some(l => COMPOSER_BAR.test(l) || SPINNER_ROW.test(l) || COMPOSER_CARET_ROW.test(l)))) {
    // Question extraction: real interstitials (the usage-limit dialog, trust
    // prompts) draw a rule as their top edge with the question right below it.
    // Search only BELOW the last rule in the tail — the old "topmost non-hint
    // line of the tail" reached above the dialog and shipped unrelated prose
    // fragments ("singleton merge implementation:") as the card's question.
    // Two-column dialog rows are flattened by capture-pane, so keep only the
    // left column (3+ spaces = column gap), and strip bullet/box glyphs.
    const ruleIdx = tailLines.reduce((acc, l, i) => (/[─━═▔▁]{5,}/.test(l) ? i : acc), -1);
    let question = "Continue?";
    for (const raw of tailLines.slice(ruleIdx + 1)) {
      if (/press|enter|esc/i.test(raw)) continue;     // key-hint rows
      if (/^\s*[❯>]\s/.test(raw)) continue;           // selection-cursor option rows
      const cleaned = raw.replace(/[─-╿▔▁]/g, " ").replace(/^\s*[⏺●]\s*/, "")
        .trim().split(/\s{3,}/)[0]?.trim() ?? "";
      if (cleaned.length > 5) { question = cleaned; break; }
    }
    const confirmOptions: Array<{ label: string; description?: string }> = [
      { label: `Continue (${enterMatch[1]})` },
    ];
    if (escMatch) {
      confirmOptions.push({ label: `Cancel (${escMatch[1]})` });
    }
    return { question, options: confirmOptions, isConfirmation: true };
  }

  return parseSelectDialog(lines);
}

// Claude Code raises some dialogs of its own as a plain select list: no digits
// on the rows and no key hint footer. The effort recommendation shown after a
// session moves to Opus 5 (verified on 2.1.270) is one:
//
//   ────────────────────────────────────────
//    We recommend Opus 5 at medium effort
//
//      Opus 5 at medium effort is faster and uses fewer tokens …
//
//      ❯ Keep high
//        Switch Opus 5 to medium effort
//
// Neither path above matches it, and its ❯ read as a live composer, so every
// delivery pasted into the dialog, never saw the paste land, and wrote it again
// (four sessions stuck this way on 2026-09-14). Recognized by structure, not by
// wording: an indented cursor row and its sibling rows at the label column are
// the LAST text in the capture (a live composer and its footer always render
// below scrolled content, so conversation text can never sit there), and a rule
// caps the dialog above its title. The widget ignores digits (verified on the
// trust dialog, the same widget), so answers move the highlight instead.
const SELECT_CURSOR_ROW = /^( {2,})❯ (\S.*)$/;
const DIALOG_TOP_RULE = /[─━═▔▁]{5,}/;

export function parseSelectDialog(lines: string[]): InteractivePrompt | null {
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  if (end - start < 1 || end - start > 8) return null;

  const cursorRows = lines.slice(start, end + 1).filter((l) => SELECT_CURSOR_ROW.test(l));
  if (cursorRows.length !== 1) return null;
  const labelCol = SELECT_CURSOR_ROW.exec(cursorRows[0])![1].length + 2;
  const options: Array<{ label: string; description?: string }> = [];
  for (const raw of lines.slice(start, end + 1)) {
    const row = raw.replace(/\s+$/, "");
    const sibling = !row.slice(0, labelCol).trim() && /\S/.test(row[labelCol] ?? "");
    if (!SELECT_CURSOR_ROW.test(row) && !sibling) return null;
    const text = row.slice(labelCol);
    if (/^\d+[.)]\s/.test(text)) return null;
    // Two column rows ("Wait for limit to reset      Resets 2:50pm") keep the
    // right column as the option's description.
    const [label, ...rest] = text.split(/\s{3,}/);
    options.push({ label: label.trim(), ...(rest.length ? { description: rest.join(" ").trim() } : {}) });
  }

  // Title and body: the rows between the dialog's top rule and its options.
  // A capture that starts right below the rule (extractTmuxLiveRegion's live
  // region) has no rule left in it, so the top of the text bounds it too.
  const rows: string[] = [];
  let capped = false;
  for (let i = start - 1; i >= Math.max(0, start - 16); i--) {
    const trimmed = lines[i].trim();
    if (DIALOG_TOP_RULE.test(trimmed)) {
      const fused = trimmed.replace(RULE_RUN_EDGE, "").trim();
      if (fused) rows.unshift(fused);
      capped = true;
      break;
    }
    if (/^[❯›⏺●⎿]/.test(trimmed) || BOX_DRAWING_CHARS.test(trimmed)) return null;
    rows.unshift(trimmed);
  }
  if (!capped && start - rows.length > 0) return null;
  const paragraphs = rows.join("\n").split(/\n\s*\n/).map((p) => p.split("\n").join(" ").trim()).filter(Boolean);
  if (paragraphs.length === 0) return null;
  const [question, ...body] = paragraphs;
  return { question, options, firstOptionIdx: start, unnumbered: true, ...(body.length ? { detail: body.join("\n\n") } : {}) };
}

// Claude Code's spend-limit interstitial — "What do you want to do?" over the
// unnumbered "Adjust monthly spend limit" / "Wait for limit to reset" rows — is
// TUI-only: unlike the one-line limit banners, it writes NO isApiErrorMessage
// entry to the JSONL (verified 2026-08-14: a 1:40pm park left the transcript
// untouched), so the pane scrape is the only place the park is visible. Shipping
// the generic Continue/Cancel confirmation card for it is worse than nothing:
// the card's "Continue" sends Enter, and Enter here CONFIRMS the highlighted
// billing option (the near-miss documented on the 2026-07-13 paywall incident).
// Instead the daemon emits the canonical limit banner text this function
// returns — classifyApiErrorBanner reads it as kind "limit", which is the same
// path a CLI-written banner takes: pending_api_error_kind="limit", the blocked
// badge, the auto-switch check, and continue-on-reset all follow from it.
export function spendLimitDialogBanner(paneContent: string): string | null {
  const tail = paneContent.split("\n").slice(-20).join("\n");
  if (!/Adjust monthly spend limit/i.test(tail) || !/Wait for limit to reset/i.test(tail)) return null;
  // A live dialog carries its key-hint footer in the same tail; a scrollback
  // echo of the dialog text (e.g. quoted in prose) doesn't.
  if (!/enter to confirm/i.test(tail)) return null;
  const resets = tail.match(/\b(Resets [^\n]+?)(?:\s{3,}|\s*$)/im)?.[1]?.trim();
  return `You've hit your monthly spend limit · ${resets ?? "parked at the spend limit dialog"}`;
}

// The same park, wearing the other costume. The spend dialog above has
// UNNUMBERED rows so parseInteractivePrompt reads it as a confirmation; the
// usage-limit variant — "What do you want to do?" over "Stop and wait for
// limit to reset" / "Switch to usage credits" / "Switch to Team plan" — is a
// NUMBERED menu, so it slipped past the confirmation-only check above and got
// minted as an ordinary poll card (uuid `interactive-prompt-…`). That card is
// the same hazard the spend dialog was fixed for: its options are billing
// actions, so "answering" it changes the plan.
//
// Recognized by the option rows via the shared isUsageLimitDialog, which the
// web's decision queue uses too, so the daemon and the queue can never
// disagree about what counts as a billing interstitial.
export function usageLimitMenuBanner(
  paneContent: string,
  optionLabels: readonly string[]
): string | null {
  if (!isUsageLimitDialog(optionLabels)) return null;
  const tail = paneContent.split("\n").slice(-20).join("\n");
  const resets = tail.match(/\b(Resets [^\n]+?)(?:\s{3,}|\s*$)/im)?.[1]?.trim();
  return `You've hit your usage limit · ${resets ?? "parked at the usage limit dialog"}`;
}

// Is the live pane one of the two limit dialogs above? Both are parks, not
// questions: a message for the session dismisses the dialog (Escape, its own
// "cancel") and is then typed at the composer. Answering it with an option
// instead is the hazard: since Claude Code 2.1.289 option 2 reads "Wait here,
// then continue automatically at <reset>", and a recovery "continue" read as
// that option armed a day-long wait on 24 sessions and never delivered the
// continue itself (2026-10-04).
export function limitDialogOnPane(pane: string): boolean {
  if (spendLimitDialogBanner(pane)) return true;
  const prompt = parseInteractivePrompt(pane, true);
  return !!prompt && usageLimitMenuBanner(pane, prompt.options.map((o) => o.label)) !== null;
}

// Claude Code renders each assistant message with a leading bullet ("⏺" on current
// builds, "●" on older ones) and indents its continuation lines two spaces. A turn
// that ends in AskUserQuestion is buffered out of the JSONL until answered, so while
// the question is pending the reasoning that motivates it lives ONLY in the rendered
// pane. Pull that prose block back out so the web question card can show *why* it's
// being asked — best-effort while pending, replaced byte-exact when the turn flushes.
const ASSISTANT_BULLET = /^(?:⏺|●)\s+/;
// Markers that bound this turn from above: a user prompt ("❯ …" / "> …"), the working
// spinner ("✻ …" / "✶ …"), or a tool bullet ("⏺ Bash(…)") / its result gutter ("⎿ …")
// / a collapsed-output summary. Crossing one means we've walked into a prior turn or a
// tool call, not the prose that precedes the question.
const PROSE_STOP_ABOVE = /^\s*(?:❯|>|✻|✶|✳)\s/;
const TOOLISH_LINE = /^(?:⏺\s+\w+\(|⎿|\s*(?:Called|Running)\b.*\(ctrl\+o)/;

// Extract the assistant prose immediately above an interactive prompt's menu. Returns
// "" when there's no preceding prose (e.g. a bare slash menu or a tool call sits right
// above the dialog). Anchored on parseInteractivePrompt's option index so numbered
// lists *inside* the prose ("1. Task-tool subagents …") can't be mistaken for the menu.
export function extractAssistantProseAbovePrompt(paneText: string): string {
  const parsed = parseInteractivePrompt(paneText);
  if (!parsed || parsed.isConfirmation || parsed.firstOptionIdx == null) return "";
  const firstOptionIdx = parsed.firstOptionIdx;
  const lines = paneText.split("\n");

  // dialogTop: the topmost chrome row that caps the menu. Walk up from the options past
  // the question/tab/blank rows to the first full-width rule or header chip (bounded to a
  // short window so a far-away rule from a PRIOR turn — e.g. an "★ Insight ───" block —
  // can't be mistaken for it)...
  let chromeBottom = -1;
  for (let i = firstOptionIdx - 1, floor = Math.max(0, firstOptionIdx - 20); i >= floor; i--) {
    const t = lines[i].trim();
    if (SEPARATOR_LINE.test(t) || HEADER_CHIP.test(t)) { chromeBottom = i; break; }
  }
  if (chromeBottom < 0) return "";
  // ...then absorb any contiguous chrome/blank rows above it, so a separator sitting
  // over a header chip (older menu format) becomes the true top instead of dangling as
  // a stray "───" line at the end of the recovered prose.
  let dialogTop = chromeBottom;
  for (let i = chromeBottom - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!(SEPARATOR_LINE.test(t) || HEADER_CHIP.test(t))) break; // blank or prose ends the run
    dialogTop = i;
  }

  // proseStart: the nearest assistant bullet above dialogTop. Bail if we cross a turn
  // boundary or a tool bullet first — then no buffered prose precedes this question.
  let proseStart = -1;
  for (let i = dialogTop - 1, floor = Math.max(0, dialogTop - 100); i >= floor; i--) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (ASSISTANT_BULLET.test(raw)) { proseStart = TOOLISH_LINE.test(raw) ? -1 : i; break; }
    if (PROSE_STOP_ABOVE.test(raw) || TOOLISH_LINE.test(raw)) break;
  }
  if (proseStart < 0) return "";

  // Collect [proseStart, dialogTop): strip the bullet off the first line and the 2-space
  // gutter off the rest. Keep blank lines and inner "───"/list rows — they're part of the
  // reasoning, and markdown reflow on the client smooths the TUI's hard wraps.
  const out: string[] = [];
  for (let i = proseStart; i < dialogTop; i++) {
    const s = (i === proseStart ? lines[i].replace(ASSISTANT_BULLET, "") : lines[i].replace(/^ {1,2}/, ""));
    out.push(s.replace(/\s+$/, ""));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n").trim().slice(0, 6000);
}
