// Whether a permission prompt is still open, read from the transcript.
//
// A card a PermissionRequest hook opened is normally cleared by the hook
// itself (the web answers, or Claude Code drops the hook) or by the session's
// next non-blocked status. Neither is guaranteed: Claude Code's dangerous rm
// dialog denies on its own after 120s and can leave the hook's curl running,
// and a status the launch fence refuses or the bypass-mode filter calls a
// phantom never makes the transition. The card then outlives the prompt, and
// a press on it types a stray key into whatever the session is doing now.
//
// The transcript is the record that cannot be skipped: once the tool call the
// prompt held has a result, or a later call has taken its place, the prompt is
// gone however it ended.

export interface PendingTool {
  tool_name: string;
  arguments_preview: string;
}

export const PROMPT_WATCH_INTERVAL_MS = 3000;

/** Calls `onSettled` once the pending call `toolName` has been seen in the
 *  transcript and then stops being the pending call. Until it is first seen
 *  (the transcript may not have flushed it yet) nothing settles. Returns a stop
 *  function. */
export function watchPromptSettled(opts: {
  readPending: () => Promise<PendingTool | null>;
  toolName: string;
  onSettled: () => void;
  intervalMs?: number;
}): () => void {
  let held: string | undefined;
  let stopped = false;
  let busy = false;
  const key = (p: PendingTool) => `${p.tool_name}\n${p.arguments_preview}`;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const pending = await opts.readPending();
      if (stopped) return;
      if (held === undefined) {
        if (pending?.tool_name === opts.toolName) held = key(pending);
        return;
      }
      if (!pending || key(pending) !== held) {
        stop();
        opts.onSettled();
      }
    } catch {
      // An unreadable tail says nothing about the prompt; try again next tick.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? PROMPT_WATCH_INTERVAL_MS);
  (timer as any).unref?.();
  void tick();
  return stop;
}
