import type { useReaderFold } from "../../hooks/useReaderFold";

// The button a folded Threads body shows above itself: the items
// hooks/useReaderFold held back, one click away, and one click to fold them
// away again.
export function EarlierButton({ fold, noun }: { fold: Pick<ReturnType<typeof useReaderFold>, "folded" | "expanded" | "toggle">; noun: string }) {
  const count = fold.folded;
  if (count <= 0) return null;
  const items = count === 1 ? noun : `${noun}s`;
  return (
    <button type="button" className="th-task-earlier" onClick={fold.toggle}>
      {fold.expanded ? `Hide ${count} earlier ${items}` : `Show ${count} earlier ${items}`}
    </button>
  );
}
