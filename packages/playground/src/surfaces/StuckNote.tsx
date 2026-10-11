// While this browser is still becoming a visitor and it is taking a while:
// one plain line says why, with a way to try now. Pages draw without waiting
// for it; this only shows when the wait is long enough to notice.
import { useAfter } from "../lib/useAfter";
import { Button } from "../ui/Button";
import { Dots } from "../ui/Dots";
import s from "./StuckNote.module.css";

const STUCK_MS = 5000;

export function StuckNote({ onRetry, className }: { onRetry: () => void; className?: string }) {
  const stuck = useAfter(STUCK_MS);
  if (!stuck) return null;
  return (
    <div className={`${s.stuck} ${className ?? ""}`} role="status">
      <p>Can't reach Clayground. Trying again <Dots /></p>
      <Button size="sm" variant="quiet" onClick={onRetry}>Try again</Button>
    </div>
  );
}
