import { useInboxStore } from "../store/inboxStore";

/** What a signed-in viewer sees for a conversation the server will not hand
 *  over, on every surface that can be asked for one by id (the inbox, a stage
 *  pane, the conversation route). The server answers the same "denied" for a
 *  deleted row and another person's private one, so the note names both, and
 *  names the account: a link opened while signed in as the wrong person is the
 *  likeliest way to land here. It never falls back to another session. */
export function ConversationUnavailable({ actionLabel, onAction }: { actionLabel?: string; onAction?: () => void }) {
  const email = useInboxStore((s) => s.currentUser?.email as string | undefined);
  return (
    <div className="h-full flex-1 flex items-center justify-center">
      <div className="text-center max-w-sm px-4">
        <div className="text-sm text-sol-text">This conversation isn't available</div>
        <p className="mt-1 text-xs text-sol-text-dim">
          It was deleted, or it belongs to someone who hasn't shared it with you.
        </p>
        {email && (
          <p className="mt-1 text-xs text-sol-text-dim">
            Signed in as <span className="text-sol-text-muted">{email}</span>
          </p>
        )}
        {onAction && actionLabel && (
          <button
            onClick={onAction}
            className="mt-4 px-3 py-1 rounded border border-sol-border text-xs text-sol-text-secondary hover:bg-sol-bg-alt transition-colors"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
