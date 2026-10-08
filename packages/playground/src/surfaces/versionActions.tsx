// What every view of a live version offers, wherever it is shown (the card,
// the capsule's callout, the phone's peek): its summary, the one-click way
// back, and what to try.
import { useState } from "react";
import type { BuildView } from "../../convex/messages";
import { reverseOf } from "../lib/versionCopy";
import { Button } from "../ui/Button";
import { RestoreIcon } from "../ui/icons";
import { useAppState } from "./appState";

export function useSummary(b: BuildView) {
  const { versionByNumber } = useAppState();
  return b.summary ?? versionByNumber.get(b.result_version ?? 0)?.summary ?? "";
}

/** The one-click way back from `n` while it is live (versionCopy
 *  reverseOf): Undo on a build, Bring back on an undo, busy until done. */
export function useReverse(n: number) {
  const { restore, versionByNumber } = useAppState();
  const [busy, setBusy] = useState(false);
  const entry = versionByNumber.get(n);
  const back = entry ? reverseOf(entry, versionByNumber) : null;
  if (!back) return null;
  return {
    ...back,
    busy,
    run: async () => {
      setBusy(true);
      await restore(back.target, n);
      setBusy(false);
    },
  };
}

/** Undo, or Bring back, busy until the version it restores is live. */
export function ReverseButton({ r, variant, className }: { r: NonNullable<ReturnType<typeof useReverse>>; variant?: "quiet" | "text"; className?: string }) {
  return (
    <Button variant={variant} className={className} busy={r.busy} onClick={r.run}>
      {!r.busy && <RestoreIcon />}
      {r.busy ? r.busyLabel : r.label}
    </Button>
  );
}

/** What to do to notice a change that shows itself only when used. */
export function TryIt({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      <b>Try it</b> {text[0].toLowerCase() + text.slice(1)}
    </p>
  );
}
