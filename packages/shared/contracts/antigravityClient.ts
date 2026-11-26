// The Antigravity CLI descriptor, kept out of agentClients.ts for its line
// cap; agentClients.ts lists it in LOCAL_AGENT_CLIENTS like every other client.

import type { AgentClientDescriptor, AgentModelConfig } from "./agentClients";
import { ANTIGRAVITY_EFFORT_LEVELS, ANTIGRAVITY_MODEL_OPTIONS } from "./modelOptions";

const ANTIGRAVITY_MODEL: AgentModelConfig = {
  models: ANTIGRAVITY_MODEL_OPTIONS,
  efforts: ANTIGRAVITY_EFFORT_LEVELS,
  // `--model` and `--effort` are launch flags; the TUI's model menu is
  // interactive. The transcript names the model per response after that.
  midSession: false,
  // Which models an account can run depends on its plan (a starter-quota
  // account lists Gemini 3.8 Flash, Claude 4.6 and GPT-OSS; Pro adds Gemini 4
  // Neon), and agy refuses a --model the account lacks ("not recognized as a
  // known model"). So the picker lists the base ids of the device's own
  // `agy models` (agyBaseModelIds), under the curated labels above where
  // they match; the curated list stands in until a device reports.
  dynamic: "bare",
};

export const ANTIGRAVITY_CLIENT: AgentClientDescriptor = {
  // Google's Antigravity CLI, the successor Google named for Gemini CLI. Every
  // fact below was measured on agy 1.5.14 (macOS, 2026-11-22) unless it says
  // otherwise.
  id: "antigravity",
  displayName: "Antigravity",
  convexId: "antigravity",
  // tmux TUI only. `agy acp` (an ACP stdio server) exists and is unresearched.
  executionTransports: ["tmux"],
  binary: "agy",
  launchArgs: [],
  // `agy -p "<prompt>"`: -p is the print flag and takes the prompt as its value.
  printMode: { kind: "flag", token: "-p", promptAsValue: true },
  // `agy --conversation <id>` reopens that conversation and appends to the
  // same transcript (verified: steps 7-9 landed in the original file). The id
  // is the conversation's UUID, checked by isValidResumeSessionId.
  resumeCmd: (sessionId) => `agy --conversation ${sessionId}`,
  // ~/.gemini/antigravity-cli/brain/<conversation uuid>/.system_generated/logs/
  // transcript_full.jsonl: one JSON row per finished step, appended while the
  // turn runs. transcript.jsonl beside it is the same rows with long fields
  // cut (truncated_fields) and is not watched. conversations/<uuid>.db and
  // .pb hold the same history as protobuf blobs; the working directory lives
  // in conversation_summaries.db (antigravityTranscript.ts reads it).
  transcriptRoots: ["~/.gemini/antigravity-cli/brain"],
  watcherKind: "jsonl-dir",
  // The composer is a `>` row directly under a full-width ─ rule, and it stays
  // painted while a turn runs ("esc to cancel" in the footer is the busy
  // mark), so antigravity sits in GLYPHLESS_PROMPT_CLIENTS and is classified
  // busy-first. Anchoring on the rule keeps the first-launch trust dialog
  // ("> Yes, I trust this folder", no rule above it) and a shell's `> `
  // continuation prompt from reading as the composer.
  promptReadyPattern: /^─{8,}[ \t]*\n>(?: |$)/m,
  // The idle footer "? for shortcuts" paints below the composer once the
  // frame is complete; the trust dialog's footer is "↑/↓ Navigate".
  paneReadiness: { frameCompleteAfter: /\? for shortcuts/, settleMs: 500 },
  // `ag-` — free: cc/cx/cu/gm/oc/pi/gk/ms taken.
  tmuxPrefix: "ag",
  modelConfig: ANTIGRAVITY_MODEL,
  capabilities: {
    // No matcher exists for agy's permission prompts; managed panes launch
    // with --dangerously-skip-permissions (launchCommand.ts) so none appear.
    panePromptMonitoring: false,
    // A bracketed paste of two lines stayed in the composer as two lines and
    // did not submit (tmux paste-buffer -p into a live pane).
    bracketedPaste: true,
    // No fork verb and no transcript writer agy would load: fork and
    // reconstitute stay absent, so the fork UI hides and a switch into
    // antigravity on a session with history is refused up front.
  },
  agentFileTargets: {
    // Both verified with planted files: a project AGENTS.md and a user
    // ~/.gemini/GEMINI.md each supplied a code word `agy -p` repeated back.
    // agy also reads project GEMINI.md and ~/.gemini/AGENTS.md (its bundled
    // docs); GEMINI.md is the user slot because Gemini CLI reads it too.
    instructionFile: { user: "~/.gemini/GEMINI.md", project: "AGENTS.md", format: "markdown" },
    // OMITTED, honestly: skillsDir (~/.gemini/config/skills), mcpConfig
    // (~/.gemini/config/mcp_config.json), hooksConfig (~/.gemini/config/
    // hooks.json) and plugins all appear in agy's bundled docs but were not
    // verified by a planted-file run.
  },
};
