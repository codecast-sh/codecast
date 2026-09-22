// Badge for a session parked on an unresolved Claude Code auth/API-error banner
// (signed out / rate-limited / connection dropped mid-turn). A distinct amber
// pill — "login" with a key glyph for auth banners, "limit" with an hourglass
// for usage-limit banners, "dropped" with a bolt for connection drops — set
// apart from the plain status dots so a stuck session reads at a glance.
// Shared by both SessionCard variants.
export function AuthErrorBadge({ kind, agentType }: { kind?: string | null; agentType?: string | null }) {
  // Only the parked-and-won't-heal kinds get a badge. kind "error" (a marked
  // opencode/pi client error) is informational and has no recovery behind it.
  if (kind !== "limit" && kind !== "auth" && kind !== "connection" && kind !== "fatal" && kind !== "throttle" && kind !== "safety" && kind !== "context") return null;
  if (kind === "context") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="The conversation no longer fits the model's context window — send /compact (or /clear) in the session to continue; a plain continue re-fails"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
        </svg>
        context full
      </span>
    );
  }
  if (kind === "safety") {
    return <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-500 border border-amber-500/30" title="OpenAI stopped this conversation for safety review. Automatic retries and account switching cannot resolve it.">safety</span>;
  }
  if (kind === "throttle") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="The provider's per-minute rate limit rejected a request burst — codecast retries a few sessions at a time; send continue to retry now"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        throttled
      </span>
    );
  }
  if (kind === "fatal") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="API request failed and won't auto-retry — send continue (or any message) to retry the turn"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 15.5v.5" strokeLinecap="round" />
        </svg>
        failed
      </span>
    );
  }
  if (kind === "connection") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="Connection dropped mid-response — send continue (or any message) to resume"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        dropped
      </span>
    );
  }
  if (kind === "limit") {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
        title="Usage limit reached — the session can resume once the limit resets"
      >
        <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path d="M6 3h12M6 21h12M8 3v3.5c0 2 4 4 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 4-4 5.5s4 3.5 4 5.5V21" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        limit
      </span>
    );
  }
  // opencode and grok re-auth via their own CLI in a terminal; pi / Claude / Codex
  // via /login in the session — name the right one in the tooltip.
  const authTip = agentType === "opencode"
    ? "Provider not authenticated — run `opencode auth login` in a terminal, then retry"
    : agentType === "grok"
      ? "Signed out — run `grok login` in a terminal (browser OAuth), then retry"
      : agentType === "muse"
        ? "Signed out — run `muse login` in a terminal (device flow), then retry"
      : "Signed out — run /login in the terminal to re-authenticate";
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/30"
      title={authTip}
    >
      <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      login
    </span>
  );
}
