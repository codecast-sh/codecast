// Shown to every visitor while the AWS outage lasts. Static on purpose: the
// backend it would otherwise read from is the thing that is down.
export function OutageBanner() {
  return (
    <div
      role="status"
      className="pointer-events-none fixed left-1/2 top-2 z-[2147483000] -translate-x-1/2 rounded-md border border-sol-yellow/40 bg-sol-yellow/15 px-3 py-1 font-mono text-xs text-sol-yellow shadow-sm backdrop-blur"
    >
      We are experiencing some downtime due to an AWS outage
    </div>
  );
}
