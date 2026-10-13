// What the terminal showed when the daemon held a message for a dialog, and
// the press that delivers the message past it. Shared by every queued card
// (a person's own bubble, a session message), so a held send always shows the
// reader what the daemon saw.
export function HeldTerminalScreen({ screen, onSendAnyway, sending, className = "" }: { screen: string; onSendAnyway?: () => void; sending?: boolean; className?: string }) {
  return (
    <div className={`rounded border border-amber-500/25 bg-sol-bg-alt/60 ${className}`} data-testid="held-terminal-screen">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-amber-500/20">
        <span className="text-[10px] font-medium tracking-wide uppercase text-amber-400/80">Terminal</span>
        {onSendAnyway && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSendAnyway(); }}
            disabled={sending}
            data-testid="held-send-anyway"
            className="ml-auto text-[11px] font-medium text-amber-400 border border-amber-500/40 hover:bg-amber-500/15 rounded px-1.5 py-0.5 transition-colors disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send anyway"}
          </button>
        )}
      </div>
      <pre className="px-2 py-1.5 text-[11px] leading-snug text-sol-text-muted overflow-auto max-h-80 whitespace-pre">{screen}</pre>
    </div>
  );
}
