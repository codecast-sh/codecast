export function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-sol-base02 rounded-lg h-20" />
      ))}
    </div>
  );
}
