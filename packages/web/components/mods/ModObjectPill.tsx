// A mod object referenced in prose (`bug-14`): the same quiet chrome as every
// other reference (EntityIdPill), the kind's icon, the object's title once
// the row is in the store, its short id until then. Done objects dim.

import Link from "next/link";
import { DynamicIcon } from "lucide-react/dynamic";
import { objectStatusIsDone } from "@codecast/shared/contracts/mods";
import { useInboxStore } from "../../store/inboxStore";
import { objectByShortId, objectHref, objectKind } from "../../lib/mods/objects";

export function ModObjectPill({ shortId }: { shortId: string }) {
  const id = shortId.toLowerCase();
  const row = useInboxStore((s) => objectByShortId((s as any).modObjects, id));
  const kind = objectKind(id.split("-")[0]);
  const done = objectStatusIsDone(kind, row?.status);
  const label = row?.title ?? id;
  const tip = [row ? `${id} · ${kind?.title ?? "object"}` : `${kind?.title ?? "Object"} ${id}`, row?.status].filter(Boolean).join(" · ");
  return (
    <Link
      href={objectHref(id)}
      title={tip}
      className={`not-prose entity-ref inline-flex items-center gap-[0.2em] px-[0.2em] rounded-[0.2em] text-[1em] font-medium leading-none no-underline hover:underline decoration-current/40 underline-offset-2 align-baseline cursor-pointer text-sol-violet bg-[color-mix(in_srgb,var(--sol-violet)_9%,transparent)] ${done ? "opacity-60 line-through" : ""}`}
    >
      <DynamicIcon name={(kind?.icon ?? "box") as any} className="w-[1em] h-[1em] block flex-shrink-0 opacity-80" />
      <span className="self-baseline">{label}</span>
    </Link>
  );
}
