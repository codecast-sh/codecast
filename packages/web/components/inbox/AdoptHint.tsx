import type { AdoptOver } from "../../hooks/useAdoptDrag";

/** The hovered row's outline and what the drop will do. */
export function AdoptHint({ over }: { over: AdoptOver }) {
  return (
    <div style={{ top: over.top, height: over.height }} className="absolute left-0 right-0 z-10 pointer-events-none ring-1 ring-inset ring-sol-cyan bg-sol-cyan/10 flex items-end justify-end p-1.5">
      <div className="max-w-[90%] rounded-md border border-sol-cyan/60 bg-sol-bg px-2 py-1 shadow-lg">
        <div className="text-meta text-sol-text truncate">Make “{over.title}” its worker</div>
        <div className="text-meta text-sol-text-dim [text-wrap:balance]">{over.leaves ? "It leaves your inbox · this session answers it · ends with it" : "This session answers it · ends with it"}</div>
      </div>
    </div>
  );
}
