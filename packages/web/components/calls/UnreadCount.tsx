import "./arrival.css";

/** The count of thread lines that arrived unread, on the control that opens
 *  them. Keyed by the count so each new number arrives with the same 150ms
 *  scale in; past 99+ the key stops changing. Nothing at zero. When the newest
 *  line is an agent's answer the badge turns violet and rings twice
 *  (arrival.css), the one cue a call gives for "the agent replied". */
export function UnreadCount({ count, agent = false, className = "" }: { count: number; agent?: boolean; className?: string }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      key={`${label}:${agent}`}
      className={`min-w-[16px] rounded-full px-1 text-center font-mono text-[9.5px] font-semibold leading-4 tabular-nums text-sol-base03 ${
        agent ? "arrival-ring bg-sol-violet" : "bg-sol-cyan animate-in zoom-in-75 fade-in duration-150 motion-reduce:animate-none"
      } ${className}`}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
