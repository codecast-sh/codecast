/**
 * The one-time setup an agent tool needs on the human's machine, surfaced in
 * the conversation where the agent got blocked.
 *
 * `cast browser` needs the Chrome extension installed and paired; `cast
 * computer` needs two macOS grants for its helper. An agent cannot do either:
 * both are a person clicking in Chrome or System Settings. So when a command
 * fails for that reason, it prints one marker line naming the tool, and the
 * transcript renders a setup card under the command. The card asks the
 * session's machine where setup stands and starts each step there through the
 * `agent_tool_setup` daemon command.
 *
 * PURE isomorphic data: the CLI, Convex and the web all import it.
 */

export const AGENT_SETUP_TOOLS = ["browser", "computer"] as const;
export type AgentSetupTool = (typeof AGENT_SETUP_TOOLS)[number];

export function isAgentSetupTool(value: unknown): value is AgentSetupTool {
  return typeof value === "string" && (AGENT_SETUP_TOOLS as readonly string[]).includes(value);
}

// Same shape as the inline-image marker (cli/src/inlineImage.ts): invisible
// separators around a readable name, on a line of its own.
const MARKER_OPEN = "⁢cast:setup ";
const MARKER_CLOSE = "⁢";
// Leading whitespace is allowed: a batch indents each step's output under it.
const MARKER_LINE = /^[ \t]*\u2062cast:setup (\w+)\u2062[ \t]*$/gm;

/** The line a failed command prints so the transcript shows the setup card. */
export function agentSetupMarker(tool: AgentSetupTool): string {
  return `${MARKER_OPEN}${tool}${MARKER_CLOSE}`;
}

/** What a command tells the agent beside the marker. */
export const AGENT_SETUP_AGENT_LINE =
  "In a codecast session the human now sees a setup card under this command: ask them to finish it there, then retry.";

/** What a command prints after its own failure text: the agent's next step, then the marker line. */
export function agentSetupLines(tool: AgentSetupTool): string[] {
  return [AGENT_SETUP_AGENT_LINE, agentSetupMarker(tool)];
}

/** Cheap test for a marker, for a feed that only needs to know a row carries the card. */
export function hasAgentSetupMarker(text: string | undefined | null): boolean {
  return !!text && text.includes(MARKER_OPEN);
}

/** The tool a command output asks setup for, and the output without the marker. */
export function extractAgentSetup(text: string): { tool: AgentSetupTool | null; text: string } {
  if (!text || !text.includes(MARKER_OPEN)) return { tool: null, text };
  let tool: AgentSetupTool | null = null;
  const cleaned = text.replace(MARKER_LINE, (_m, name: string) => {
    if (isAgentSetupTool(name)) tool = name;
    return "";
  });
  return { tool, text: cleaned.replace(/\n{3,}/g, "\n\n").trimEnd() };
}

/** `agent_tool_setup` args. check reads where setup stands; start runs the next step on that machine. */
export interface AgentToolSetupArgs {
  tool: AgentSetupTool;
  op: "check" | "start";
}

/**
 * The machine's answer. `ready` is the one bit the card turns on; the rest
 * says which step is left. `detail` carries a reason the card shows verbatim
 * (an unsupported platform, a helper that could not be read).
 */
export type AgentToolSetupStatus =
  | {
      tool: "browser";
      ready: boolean;
      /** The bridge holds a token the extension was handed at least once. */
      paired: boolean;
      /** The extension is connected to this machine's bridge host now. */
      connected: boolean;
      chrome_running: boolean;
      detail?: string;
    }
  | {
      tool: "computer";
      ready: boolean;
      accessibility: boolean;
      screen_recording: boolean;
      /** False off macOS/Linux or when the helper cannot be read. */
      supported: boolean;
      detail?: string;
    };
