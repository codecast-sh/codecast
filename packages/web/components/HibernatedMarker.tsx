import { HIBERNATED_COPY, isHibernated } from "@codecast/shared/contracts";

export function HibernatedMarker({ status, compact = false }: { status?: string | null; compact?: boolean }) {
  if (!isHibernated({ agent_status: status })) return null;
  return <span data-hibernated-marker title={HIBERNATED_COPY} className="inline-flex items-center gap-1 rounded border border-sol-blue/25 bg-sol-blue/10 px-1.5 py-0.5 text-[10px] leading-tight text-sol-blue shrink-0">
    <span className="h-1.5 w-1.5 rounded-full bg-sol-blue/70" />
    {compact ? "hibernated" : HIBERNATED_COPY}
  </span>;
}
