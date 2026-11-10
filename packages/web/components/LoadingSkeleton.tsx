import { useIsModernStyle } from "../hooks/useVisualStyle";
import { Skeleton } from "./ui/skeleton";

export function LoadingSkeleton() {
  // Modern: three card-sized blocks on the shared Skeleton (theme highlight,
  // no pulse under reduced motion). Classic and Minimal keep their blocks.
  const modern = useIsModernStyle();
  if (modern) {
    return (
      <div role="status" aria-label="Loading" className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 rounded-card" />
        ))}
      </div>
    );
  }
  return (
    <div className="animate-pulse motion-reduce:animate-none space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-sol-bg-highlight rounded-lg h-20" />
      ))}
    </div>
  );
}
