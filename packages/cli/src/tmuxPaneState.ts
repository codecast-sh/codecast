/**
 * What a tmux pane is showing: the agent's live state read from its text
 * (idle, busy, a dialog, a bare shell), and the detectors for the dialogs
 * agents raise on their own before or between turns.
 */

import { isClaudeAutoContinueLine, localAgentClient } from "@codecast/shared/contracts";
import type { AgentClientId, LivenessVerdict } from "@codecast/shared/contracts";
import { isComposerRow, limitDialogOnPane, parseSelectDialog } from "./interactivePrompt.js";

// Codex's working-directory picker, as the TUI renders it (0.153):
//
//   Choose working directory to resume this session
//     Session = latest cwd recorded in the resumed session
//     Current = your current working directory
//   › 1. Use session directory (/Users/ashot/src/codecast)
//     2. Use current directory (/)
//     3. Always use session directory
//     4. Always use current directory
//     Press enter to continue
//
// parseInteractivePrompt reads the two "=" lines as the question; the
// classifier's live region (a five-line tail when no separators are on screen)
// holds only the option rows. Both shapes are matched, so the same test serves
// the scraped card path and the live-region classifier.
const RESUME_CWD_PICKER_RE = /latest cwd recorded in the resumed session|Choose working directory to resume|Use session directory \(|Always use (?:session|current) directory/i;
export function isResumeCwdPicker(text: string): boolean {
  return RESUME_CWD_PICKER_RE.test(text);
}

// Codex's first-launch trust dialog, recognised from what it renders (verified
// against codex 0.153.4 in an untrusted directory):
//
//   > You are in /private/tmp/…/untrusted-project
//     Do you trust the contents of this directory? …
//   › 1. Yes, continue
//     2. No, quit
//     Press enter to continue
//
// Matched on the OPTION WORDING, not on the question: the injection path only
// ever sees the live region, the last few lines below the box separators, and
// codex renders the question five lines above the options. The
// "Yes, continue"/"No, quit" pair is codex's own trust wording — the update
// menu offers "Update now"/"Skip", and an AskUserQuestion menu the agent raised
// does not offer to quit — so the pair cannot claim another menu.
//
// Why one function and not a regex per caller: the two paths that meet this
// dialog (classifyTmuxLiveState mid-delivery, classifyStartedPane at launch)
// each carried their own trust patterns, and the launch one knew only claude's
// wording, so a cold codex pane in an untrusted directory classified "booting"
// for its whole 120s budget and never bound (ct-49609, ct-49749).
export function isCodexTrustDialog(text: string): boolean {
  return /^[^\S\n]*[›❯>]?[^\S\n]*\d+[.)][^\S\n]*Yes,\s*continue\b/im.test(text)
    && /^[^\S\n]*[›❯>]?[^\S\n]*\d+[.)][^\S\n]*No,\s*quit\b/im.test(text);
}

// Claude Code's one-time warning when it starts with
// --dangerously-skip-permissions on a machine that never accepted it:
//
//   WARNING: Claude Code running in Bypass Permissions mode
//   ❯ No, exit
//     Yes, I accept
//   Enter to confirm · Esc to cancel
//
// It is the trust dialog's shape: "No, exit" is the default highlight and
// Escape is also "No, exit". Read as the Rewind modal its footer resembles, the
// Escape we sent quit every session a fresh machine launched (ct-55193). The
// launch already chose bypass mode, so accepting is what it asked for, and it is
// answered the trust dialog's way: select "Yes, I accept", then confirm.
export function isClaudeBypassWarning(text: string): boolean {
  return /running in Bypass Permissions mode/i.test(text) && /^[^\S\n]*[❯›>]?[^\S\n]*(?:\d+[.)][^\S\n]*)?Yes,\s*I accept\b/im.test(text);
}

export function isCodexUpdateDialog(text: string): boolean {
  return /^[^\S\n]*[›❯>]?[^\S\n]*\d+[.)][^\S\n]*Update now\b/im.test(text)
    && /^[^\S\n]*[›❯>]?[^\S\n]*\d+[.)][^\S\n]*Skip[^\S\n]*$/im.test(text)
    && /^[^\S\n]*[›❯>]?[^\S\n]*\d+[.)][^\S\n]*Skip until next version[^\S\n]*$/im.test(text)
    && /Press enter to continue/i.test(text);
}

// Grok 1.0.30 first-launch folder-trust dialog, verified against a live pane in
// an untrusted directory (jx702ea, 2026-09-16):
//
//   Do you trust the contents of this directory?
//   /Users/ashot/src/mail
//   Grok Build may run or modify contents in this directory,
//   posing security risks.
//   Yes, proceed                 y
//   No, quit                     n
//   …~30 blank rows…
//   Grok Build  1.0.30 [stable]
//
// Unlike Claude (numbered, cursor on "No, exit") and Codex (numbered
// "Yes, continue"/"No, quit"), grok has no cursor glyph and answers with y/n.
// The question sits in the middle of a full-screen pane, so extractTmuxLiveRegion
// (a 5-line tail when there are no box separators) sees only the footer. Match
// the option pair against the WHOLE pane. "Yes, proceed" is grok's wording —
// Codex says "Yes, continue" — so the two dialogs cannot claim each other.
export function isGrokTrustDialog(text: string): boolean {
  return /Yes,\s*proceed\b[^\n]*\by\b/i.test(text)
    && /No,\s*quit\b[^\n]*\bn\b/i.test(text);
}

// cursor-agent's first launch in a directory: "Workspace Trust Required" over
// "[a] Trust this workspace" / "[q] Quit". The TUI names `a` as the grant key.
// The answered box stays in the pane's history under the composer, so only a
// dialog with nothing painted after its options is live.
export function isCursorTrustDialog(text: string): boolean {
  const at = text.search(/\[a\]\s*Trust this workspace/i);
  if (at < 0 || !/Workspace Trust Required/i.test(text.slice(0, at))) return false;
  const after = text.slice(at);
  return !/Trusting workspace|Cursor Agent|→ /.test(after.slice(after.search(/\[q\]\s*Quit/i) + 1));
}

// cursor-agent's signed-out splash ("Press any key to log in..."). Any key
// starts a browser login nobody at the web can finish, so the pane is held,
// never typed into, until the machine's cursor-agent is logged in again.
export function isCursorLoginScreen(text: string): boolean {
  return /Press any key to log in/i.test(text);
}

// How many tmux history rows a grok classifier must see to reach the y/n
// options above the footer. A 25-line capture of the live pane in jx702ea
// held only padding + "Grok Build  1.0.30 [stable]".
export const GROK_TRUST_PANE_CAPTURE_LINES = 80;

export type TmuxLiveState =
  | "idle"          // empty input prompt — safe to paste
  | "busy"          // spinner / "esc to interrupt" — wait
  | "starting"      // composer painted but the TUI is still booting — wait, send nothing
  | "interrupted"   // "What should Claude do instead?" dialog — Escape to clear
  | "rewind"        // Rewind/Restore modal — Escape to cancel (NEVER Enter, that rewinds)
  | "trust"         // workspace "Quick safety check" prompt — Enter accepts ("Yes, I trust" is preselected)
  | "warning"       // dismissable banner — Enter to ack
  | "update_menu"   // agent's own "Update available" menu — Escape (Enter would RUN the update)
  | "limit_dialog"  // usage/spend limit dialog — Escape (its options are billing actions and a day-long wait)
  | "cwd_picker"    // Codex resume "Choose working directory" picker — answered by answerResumeCwdPicker
  | "signed_out"    // the agent's own login splash — hold, press nothing; the machine must log in
  | "menu"          // a select dialog (parseSelectDialog) or a numbered dialog with its cursor on an option — only a card answer moves it; press nothing, hold delivery
  | "exited"        // bare shell, agent has exited — abort
  | "unknown";      // anything we don't recognize — defer, do not guess

// What the pane's TEXT is allowed to say about liveness. "unknown" is a
// statement about OUR vocabulary, not about the pane — text classification is a
// positive whitelist and can never be complete — so it maps to `unverifiable`
// and authorizes nothing. Only the bare-shell shapes are an observed exit.
export function livenessFromTmuxState(state: TmuxLiveState): LivenessVerdict {
  if (state === "exited") return "exited";
  if (state === "unknown") return "unverifiable";
  return "live";
}

// The part of the region below its newest box-drawing separator — the last frame
// the TUI painted. A TUI that redraws its whole header (codex repaints it three
// times while a resume replays) leaves the earlier frames in the same capture, so
// a boot marker read from the whole region can belong to a frame that is already
// over. Everything else in this classifier is about the CURRENT screen, so only
// the boot marker needs this narrowing.
function newestPaintedFrame(region: string): string {
  const lines = region.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[─━]{20,}/.test(lines[i])) return lines.slice(i + 1).join("\n");
  }
  return region;
}

// Claude Code's running-turn status line: a cycling asterisk glyph, a verb, an
// ellipsis, then the elapsed time in parentheses. The finished form ("✻ Churned
// for 0s · done 9:52 AM") has no "… (" and does not match.
//
// The elapsed time is matched by its first unit, whatever it is: "(50s",
// "(3m 23s", "(2h 2m 38s". Spelled as minutes and seconds only, the rule went
// blind the moment a turn passed one hour, the pane read idle under its
// composer, and the pane reconcile settled a session that was mid-turn. The
// server then flipped it back to working on each synced message and the
// heartbeat settled it again, so a spawned worker's parent was told it had
// ended its turn every few minutes (ct-56131).
//
// The time need not lead the parentheses: while hooks run, their progress
// comes first ("✻ Considering… (running PreToolUse hooks… 1/2 · 36m 18s"),
// and requiring the time up front read that pane idle mid-turn (jx7f4ks).
//
// The glyph cycles, and off macOS one frame is a plain "*" where macOS draws
// ✳: a read that landed on it settled hands mid tool call on Linux.
export const CLAUDE_TURN_STATUS_LINE = /^\s*[·✢✳✶✻✽*]\s+\S[^\n]*…\s*\([^)\n]*?\b\d+[dhms]\b/m;

// Classifies the live region only. Ordering matters: more-specific dialogs are
// matched before more-general ones (e.g. Rewind contains "Interrupted" in its option
// list, so check Rewind first). Idle is a positive whitelist — never inferred from
// absence of other patterns.
export function classifyTmuxLiveState(region: string): TmuxLiveState {
  if (/Resume this session with:/i.test(region)) return "exited";
  if (/-(?:ba)?sh:.*(?:No such file|command not found)/.test(region)) return "exited";
  // Why: a painted composer is not proof the TUI reads stdin. codex paints
  // "› Ask Codex to do anything" while it is still replaying a resumed session
  // ("Resuming session…", header still "model: loading"), the ›-glyph rule below
  // reads that as idle, and the redraw that ends the replay throws the pasted
  // text away — so the message is lost and every retry pastes another copy at
  // the prompt (ct-49614: nine stacked copies, none submitted). Checked before
  // busy: "not reading input yet" is a stronger statement than "a turn is
  // running", and the type-ahead paste busy allows is exactly what is unsafe here.
  if (/^\s*Resuming session[.…]/mi.test(newestPaintedFrame(region))) return "starting";
  if (/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|esc to interrupt/i.test(region)) return "busy";
  // Claude Code's own turn status line: a cycling asterisk glyph, a verb, an
  // ellipsis, then the elapsed time in parentheses — "✶ Perambulating… (50s ·
  // ↓ 161 tokens)". v2.1.270 prints no "esc to interrupt" anywhere on such a
  // pane (the footer says "← for agents"), so without this rule a running turn
  // with its composer painted read as idle (2026-09-14: the daemon skipped a
  // user's Escape as "no active turn" while the pane showed this line). The
  // finished form, "✻ Churned for 0s · done 9:52 AM", has no "… (" and stays idle.
  if (CLAUDE_TURN_STATUS_LINE.test(region)) return "busy";
  // Rewind / cancel-able modal: distinguished from warnings by an Esc option.
  // Warnings have only "Press enter to continue" (no Esc). The "❯ (current)" marker
  // is also unique to the Rewind option list.
  // Workspace trust prompt (first launch in a directory). Its footer is
  // "Enter to confirm · Esc to cancel", so it must be recognized BEFORE the
  // Rewind rule below — misread as Rewind, the Escape we send is this dialog's
  // "No, exit": the agent quits, the resume loops, and the message never lands
  // (17 panes found dead on this on 2026-08-21).
  if (/Quick safety check|trust this folder|Is this a project you created/i.test(region)) return "trust";
  // Codex asks the same question with a numbered menu. Without this rule the
  // shape fell through to update_menu below — a numbered cursor row plus a
  // "Press enter to continue" footer — and the corrective sent Escape, which is
  // this dialog's "No, quit" (ct-49609).
  if (isCodexTrustDialog(region)) return "trust";
  if (isClaudeBypassWarning(region)) return "trust";
  // Claude Code's armed automatic continue at a usage limit also ends in "esc
  // to cancel", under a live composer. Escape there cancels the continue, and
  // the next one opens the real Rewind dialog (2026-09-30: three Escapes left a
  // limit-parked session holding every message for two hours). It is no modal.
  const dialogText = region.split("\n").filter((line) => !isClaudeAutoContinueLine(line)).join("\n");
  // The limit dialog ends in "Esc to cancel" too; named first so its Escape is
  // a deliberate dismissal, not a Rewind cancel that happens to fit.
  if (limitDialogOnPane(region)) return "limit_dialog";
  if (/Esc to cancel|❯\s*\(current\)/i.test(dialogText)) return "rewind";
  if (/What should Claude do instead\?/i.test(region)) return "interrupted";
  // Teammate panel: a lead session with in-process agents renders a chip list
  // (⏺ main, ◯ name · state, "↓ N more") below its footer. Teammate panes split
  // the window, and a squeezed lead pane truncates the footer's "esc to
  // interrupt" marker — or, squeezed further, leaves the chip list as the ONLY
  // content the scraper sees (the jx77h6jcsa0s freeze). Either way the pane is a
  // live Claude Code TUI whose input box takes type-ahead, so classify busy:
  // the paste path skips the leading Escape (never interrupts a mid-turn lead)
  // and paste+Enter still submits when the lead is actually idle. Checked
  // before the prompt-visible idle rule because chips + visible ❯ says nothing
  // about whether the lead is generating. Requires a panel signature (⏺ main
  // header, a second chip, or the overflow marker) so one stray ◯ line in a
  // no-separator fallback region can't hijack the classification.
  const chipLines = region.split("\n").filter((l) => /^\s*◯\s+\S+/.test(l)).length;
  if (chipLines >= 2 || (chipLines >= 1 && /(?:^\s*⏺\s+main\s*$|↓\s*\d+\s*more)/m.test(region))) {
    return "busy";
  }
  // Input prompt visible = no blocking modal. Real warnings ("Press enter to
  // continue", weekly-limit popup) replace the input box, so the prompt glyph
  // disappears while they're up. Persistent footer banners — "Update available!
  // Run: brew upgrade claude-code" sits below the input box on every turn —
  // match the warning regex but DON'T block input; checking idle first prevents
  // an Enter-press-loop that mis-classifies as AGENT_STUCK_WARNING for any
  // Claude Code session with an update pending. Mirrors injectViaTmuxInner's
  // own guard, which only acks warnings when no prompt is visible.
  // A numbered menu the agent never asked for, checked BEFORE the idle rule
  // below because it defeats that rule twice over. Codex's startup banner is:
  //
  //     Update available! 0.147.0 -> 0.153.0
  //   › 1. Update now (runs `bun install -g @openai/codex`)
  //     2. Skip
  //     3. Skip until next version
  //     Press enter to continue
  //
  // Its selection cursor is '›', which `promptVisible` reads as a live composer,
  // so the whole pane classified "idle" and took a paste + Enter. And its footer
  // says "Press enter to continue", so the warning rule would ALSO press Enter.
  // Both are wrong in the same direction: the cursor rests on "Update now", so
  // Enter runs a global package install inside the agent's pane. Escape is the
  // only safe key here (verified against codex 0.147.0), which is why this needs
  // its own state rather than folding into "warning".
  // Keyed on the menu's SHAPE, not on the banner text: the live region is the
  // last few lines, so "Update available!" has usually scrolled out of it by the
  // time we classify. What is always in view is a numbered option row carrying
  // the selection cursor, together with the "Press enter to continue" footer.
  //
  // That pair is specific enough to be safe. A Claude warning banner has the same
  // footer but no numbered options, so it stays "warning" and still gets Enter. An
  // AskUserQuestion menu has numbered options but not this footer, so it stays a
  // blocking menu for parseInteractivePrompt to handle rather than being dismissed
  // out from under the user.
  // Codex's "Choose working directory to resume this session" picker: a
  // `codex resume` launched in a cwd other than the rollout's recorded one. A
  // launch artifact the daemon caused, not a question for the user, so it is
  // answered in place (answerResumeCwdPicker) and never minted as a card.
  // Checked before the update-menu rule: same '›' + numbered rows + "Press
  // enter to continue" shape, but Escape here quits the resume into a bare
  // shell, and the next delivery would then paste into that shell.
  if (isResumeCwdPicker(region)) return "cwd_picker";
  const regionLines = region.split("\n");
  const numberedCursorRow = regionLines.some((line, i) => /^\s*[›❯>]\s*\d+[.)]\s/.test(line) && !isComposerRow(regionLines, i));
  if (numberedCursorRow && /Press enter to continue|Update available!/i.test(region)) {
    return "update_menu";
  }
  // An unnumbered select dialog draws its highlight with the same ❯ glyph, so
  // it must be recognized before the idle rule below: a paste lands in no
  // composer there, and no key of ours is safe to press.
  if (parseSelectDialog(region.split("\n"))) return "menu";
  // A numbered dialog whose cursor sits on an option: the AskUserQuestion menu
  // and the safeguards "Session paused" interstitial ("❯ 1. Switch to Opus
  // 4.8"). The cursor glyph is the same ❯ the idle rule reads as a composer,
  // and it read so on 2026-09-15: the daemon pasted a message into the
  // interstitial, minted a paste receipt for it, and every later message to
  // the pane waited hours behind that receipt. Only a card answer (a poll)
  // moves this cursor; everything else holds.
  if (numberedCursorRow) return "menu";
  const promptVisible = region.includes("❯") || region.includes("›");
  if (promptVisible) return "idle";
  if (/Press enter to continue|Update available|weekly limit|recorded with model|⚠/i.test(region)) return "warning";
  return "unknown";
}

// Clients whose tmux readiness is classified WHOLE-PANE from their registry
// promptReadyPattern, with busy-detection checked first — not the claude-chrome
// ❯/›-glyph whitelist in classifyTmuxLiveState. Two ways in:
//  - No glyph at all: opencode (footer `ctrl+p commands`, placeholder `Ask
//    anything…`) and pi (status-bar context-budget segment, e.g. `0.0%/200k`).
//    Without this the injection pre-flight read their idle prompt as "unknown"
//    and refused to paste — a fresh opencode/pi launch's FIRST message never
//    delivered (ct-39174): tryStartedTmux reached the pane and logged "ready
//    (prompt visible)", then ensureTmuxReady threw AGENT_UNKNOWN_STATE and
//    delivery fell through to materialize/fresh-start, which both fail for a
//    store-owned client that has no session row until it has processed a turn.
//  - Glyph that LIES while busy: grok keeps its ❯ composer visible for the whole
//    turn (live pane capture, v1.0.5), so the glyph-whitelist path would read a
//    mid-turn pane "idle" and the paste's leading Escape would cancel the running
//    turn. grok needs the busy-first order this classifier guarantees.
export const GLYPHLESS_PROMPT_CLIENTS: ReadonlySet<AgentClientId> = new Set(["opencode", "pi", "grok", "cursor"]);

// The registry promptReadyPattern for a client classified whole-pane (see
// GLYPHLESS_PROMPT_CLIENTS above), null for the ❯/›-glyph clients. Every pane
// classification site that knows its client routes through this instead of
// re-testing set membership, so no site can fall back to the claude-chrome
// whitelist for a client it cannot read.
export function glyphlessPromptPattern(agentType: AgentClientId | undefined): RegExp | null {
  return agentType && GLYPHLESS_PROMPT_CLIENTS.has(agentType)
    ? localAgentClient(agentType).promptReadyPattern
    : null;
}

// Injection-readiness for a glyph-less client, tested against the WHOLE pane (not
// extractTmuxLiveRegion's tight live-region tail — opencode has no ─/━ separator,
// so that tail drops to the status bar and misses the footer marker). Tool
// permission prompts ride the store watcher (panePromptMonitoring:false), but
// grok's first-launch folder-trust dialog is a pane-driven modal that appears
// before any store exists — classifyGlyphlessClientPaneState reports it as
// "trust" so ensureTmuxReady can answer `y`. Otherwise readiness is the narrow
// question "is the TUI up and accepting input": a visible readyPattern with no
// active spinner means ready-to-paste. `busy` is best-effort — the store, not the
// pane, owns turn state — but a visible spinner still says to skip the
// interrupting Escape and paste into the type-ahead box instead.
export function classifyGlyphlessClientPaneState(
  paneContent: string,
  readyPattern: RegExp,
): TmuxLiveState {
  if (/-(?:ba)?sh:.*(?:No such file|command not found)/.test(paneContent)) return "exited";
  // Grok's first-launch folder-trust dialog is a pane-driven modal that appears
  // BEFORE any store/transcript exists (jx702ea). Without this rule the pane
  // classified "unknown" (no ❯ yet) and ensureTmuxReady's glyphless skip polled
  // until timeout, never sending the `y` the dialog asks for.
  if (isGrokTrustDialog(paneContent) || isCursorTrustDialog(paneContent)) return "trust";
  if (isCursorLoginScreen(paneContent)) return "signed_out";
  // cursor-agent's tool approval menu ("Run this command?" … "Skip & tell the
  // agent what to do instead") when it runs without --force: only a person
  // can answer it, and its "→ Run (once)" row is not the composer.
  if (/Skip & tell the agent what to do instead/i.test(paneContent)) return "menu";
  // Busy before ready, always. Braille spinner frames + "esc to interrupt" cover
  // opencode/pi; `Esc:cancel` / `Waiting for response` / `[stop]` are grok's busy
  // chrome (live pane capture, v1.0.5 — the spinner sits in grok's HEADER, which a
  // short capture window can crop, so the footer/status text must count too).
  // CAUTION: keep these markers literal — grok's IDLE states contain the words
  // "send a message to interrupt", so a generic /interrupt/ heuristic would read
  // an idle grok pane as busy forever.
  // cursor-agent's spinner is a two-glyph braille pair before a verb
  // ("⠰⠳ Working", "⠀⠞ Editing") while its composer stays painted.
  if (/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|⬝⬝|esc (?:to )?interrupt|Esc:cancel|Waiting for response|\[stop\]/i.test(paneContent)) return "busy";
  if (/^\s*[\u2800-\u28FF]{2} [A-Z][a-z]+\b/m.test(paneContent)) return "busy";
  if (readyPattern.test(paneContent)) return "idle";
  return "unknown";
}

// Whole-pane live-state for a KNOWN client — the reaper's idle gates go through
// this. GLYPHLESS_PROMPT_CLIENTS classify with busy-first ordering against
// their registry pattern: classifyTmuxLiveState would read grok's persistent ❯
// composer as "idle" mid-turn (a busy grok must never look reapable), and read
// pi/opencode as a permanent "unknown" (their idle terminals were never
// reaped). Other clients keep the claude-chrome whitelist unchanged.
export function classifyLivePaneFor(agentType: AgentClientId, paneContent: string): TmuxLiveState {
  const glyphless = glyphlessPromptPattern(agentType);
  return glyphless
    ? classifyGlyphlessClientPaneState(paneContent, glyphless)
    : classifyTmuxLiveState(paneContent);
}
