// A 2px sweep along the top edge of whatever is loading: says "on its way"
// without moving anything below it. Position it with `className` (it fills
// its parent's width); the label is for screen readers and text queries.
export function LoadingBar({ className = "" }: { className?: string }) {
  return (
    <div role="progressbar" aria-label="Loading" className={`pointer-events-none h-[2px] overflow-hidden ${className}`}>
      <span className="sr-only">Loading</span>
      <div className="h-full w-1/4 bg-sol-cyan/70 animate-[indeterminateBar_1.3s_ease-in-out_infinite]" />
    </div>
  );
}
