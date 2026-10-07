// The hosted transcript's loading state (ConversationPlaceholder, and the
// messages loader in sessionChrome): quiet bars at the reading measure, never
// the logo and progress bar, which read as the app restarting.

/** Three muted bars where the transcript will be: the person's ask on the
 *  right, the start of an answer on the left, in the reply column. */
export function TranscriptSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden pt-8" role="status" aria-label="Loading the conversation" data-transcript-skeleton>
      <div className="mx-auto conv-col space-y-4 px-4">
        <span className="ml-auto block h-3 w-2/5 rounded-full bg-sol-text-dim/10 animate-pulse" />
        <span className="block h-3 w-4/5 rounded-full bg-sol-text-dim/10 animate-pulse" />
        <span className="block h-3 w-3/5 rounded-full bg-sol-text-dim/10 animate-pulse" />
      </div>
    </div>
  );
}
