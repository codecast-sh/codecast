// The button a folded Threads body shows above itself: the items
// hooks/useReaderFold held back, one click away.
export function EarlierButton({ count, noun, onClick }: { count: number; noun: string; onClick: () => void }) {
  if (count <= 0) return null;
  return (
    <button type="button" className="th-task-earlier" onClick={onClick}>
      Show {count} earlier {count === 1 ? noun : `${noun}s`}
    </button>
  );
}
