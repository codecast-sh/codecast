// The new-session page's one line under the message box ("in littlebird ·
// Claude · Mac Studio · worktree"): the shared look of its parts, and the
// words it uses. Pure, so the words test without a render.

/** One part of the line: plain secondary text that opens its picker. */
export const LINE_PICK = "inline-flex items-center gap-1 h-6 px-1.5 rounded text-xs whitespace-nowrap text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt focus-visible:text-sol-text data-[state=open]:bg-sol-bg-alt data-[state=open]:text-sol-text transition-colors";

/** The line's container: every non-empty part after the first gets a quiet
 *  "·" before it, so a part that renders nothing (one machine, no picker to
 *  offer) leaves no stray separator. */
export const LINE_PARTS = "flex min-w-0 flex-wrap items-center gap-y-0.5 [&>:not(:empty)~:not(:empty)]:before:content-['·'] [&>:not(:empty)~:not(:empty)]:before:px-0.5 [&>:not(:empty)~:not(:empty)]:before:text-sol-text-dim";

/**
 * A machine's name as the line says it: a Mac's default hostname drops its
 * owner ("Alexanders-Mac-Studio" → "Mac Studio", "Riley's MacBook Pro" →
 * "MacBook Pro"); any other name stays as it is. The full name is the
 * part's tooltip.
 */
export function shortMachineName(name: string): string {
  const m = /^[^-\s]+?(?:s|'s|’s)[-\s]((?:Mac|iMac)[\w-]*(?:[-\s][\w-]+)*)$/.exec(name.trim());
  if (!m) return name;
  return m[1].replace(/-/g, " ");
}

/** A launch setting set away from its default, as the line names it. */
export function effortNote(effort: string | null | undefined): string | null {
  return effort ? `${effort} effort` : null;
}

export function contextNote(mode: string | null | undefined): string | null {
  if (mode === "off") return "no context";
  if (mode === "team" || mode === "solo") return `${mode} context`;
  return null;
}

/** What the line needs of a cloud agent launch (SessionModeToggles' cloudAgent). */
type PlacedCloudAgent = { on: boolean; spec: { vendor: string; label: string }; lanes?: readonly { lane?: unknown }[] };

/** A cloud agent's place, as the line and the placement menu name it: the
 *  vendor's cloud when it can run on more than one lane, else its label. */
export function cloudAgentPlace(cloudAgent: Omit<PlacedCloudAgent, "on">): string {
  return (cloudAgent.lanes ?? []).filter((l) => l.lane).length > 1 ? `${cloudAgent.spec.vendor}'s cloud` : cloudAgent.spec.label;
}

/**
 * Where the session runs, in the words the new-session line shows when it is
 * set away from the default (this checkout; on a cloud host, its own worktree
 * from my checkout). Empty at the default: the line names only what changed.
 * The machine part already names a cloud host, so the host's own default is
 * not repeated.
 */
export function sessionPlacementNotes({ cloudMode, isolated, shared = false, startFrom = "checkout", cloudAgent }: {
  cloudMode: boolean;
  isolated: boolean;
  shared?: boolean;
  startFrom?: string;
  cloudAgent?: PlacedCloudAgent;
}): string[] {
  if (cloudAgent?.on) return [cloudAgentPlace(cloudAgent)];
  if (cloudMode && !cloudAgent) {
    if (shared) return ["main checkout"];
    return startFrom === "origin_main" ? ["from origin/main"] : [];
  }
  return isolated ? ["worktree"] : [];
}
