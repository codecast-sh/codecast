// A mod object referenced in prose (`bug-14`): the same pill as every other
// reference (EntityIdPill). Quiet chrome with the kind's icon, tinted by the
// object's status; the title once the row is in the store, the short id until
// then; done objects dim. Hover shows a card drawn from the kind's declaration
// (status, filled fields, notes), and the caret opens the object's page in the
// band under the line, the way a task does.

import { useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { DynamicIcon } from "lucide-react/dynamic";
import { objectStatusIsDone, type ModObjectKind } from "@codecast/shared/contracts/mods";
import { useInboxStore } from "../../store/inboxStore";
import { objectByShortId, objectHref, objectKind, statusTone } from "../../lib/mods/objects";
import { useHoverCard } from "../../hooks/useHoverCard";
import { useRevealRef } from "../../lib/revealHost";
import { HoverCardClose } from "../../lib/hoverCardsOff";
import { stripMarkdown } from "../../lib/notificationText";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { RevealOpenLink } from "../ObjectReveal";
import { ShortId } from "../ShortId";
import { FieldValue, StatusBadge } from "./objectFields";

/** How many filled fields the hover card lists before it stops: a preview, not the page. */
const CARD_FIELDS = 5;

export function ModObjectPill({ shortId }: { shortId: string }) {
  const id = shortId.toLowerCase();
  const row = useInboxStore((s) => objectByShortId((s as any).modObjects, id));
  const kind = objectKind(id.split("-")[0]);
  const done = objectStatusIsDone(kind, row?.status);
  const label = row?.title ?? id;
  const href = objectHref(id);
  const kindTitle = kind?.title ?? "Object";

  const { open: hoverOpen, setOpen: setHoverOpen, openSoon, closeSoon, closeNow } = useHoverCard();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const openLabel = `Open ${kindTitle.toLowerCase()}`;
  const onOpen = useCallback(() => closeNow(), [closeNow]);
  const revealTarget = useMemo(() => ({ href, title: `${kindTitle}: ${label}`, onOpen, openLabel }), [href, kindTitle, label, onOpen, openLabel]);
  const { host: revealHost, open: revealOpen, toggle: toggleReveal } = useRevealRef(revealTarget, linkRef);
  const canReveal = !!revealHost && !!row;
  // The status's own color on the icon, the way a task's disc says where it stands.
  const iconTone = kind && row?.status ? statusTone(kind, row.status) : undefined;

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <Link
          ref={linkRef}
          href={href}
          onClick={onOpen}
          onMouseEnter={revealOpen ? closeNow : openSoon}
          onMouseLeave={closeSoon}
          data-reveal-open={revealOpen ? "" : undefined}
          className={`not-prose entity-ref${canReveal ? " entity-ref--split" : ""} inline-flex items-center gap-[0.2em] px-[0.2em] rounded-[0.2em] text-[1em] font-medium leading-none ${revealOpen ? "underline" : "no-underline"} hover:underline decoration-current/40 underline-offset-2 align-baseline cursor-pointer transition-colors text-sol-violet bg-sol-violet/[0.08] hover:bg-sol-violet/[0.16] ${done ? "opacity-60" : ""}`}
        >
          <DynamicIcon name={(kind?.icon ?? "box") as any} className="w-[1em] h-[1em] block flex-shrink-0 opacity-80" style={iconTone ? { color: iconTone } : undefined} />
          <span className="self-baseline">{label}</span>
        </Link>
      </PopoverAnchor>
      {canReveal && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeNow(); toggleReveal(); }}
          onMouseEnter={closeNow}
          aria-expanded={revealOpen}
          aria-label={revealOpen ? "Hide full page" : "Show full page here"}
          title={revealOpen ? "Hide full page" : "Show full page here"}
          className={`not-prose entity-ref__expand text-sol-violet${done ? " opacity-60" : ""}`}
        >
          <ChevronDown aria-hidden className="entity-ref__caret" />
        </button>
      )}
      <PopoverContent
        className="w-80 max-w-[calc(100vw-16px)] bg-sol-bg border border-sol-border shadow-xl p-0 relative"
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onMouseEnter={openSoon}
        onMouseLeave={closeSoon}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <span aria-hidden className="absolute inset-x-0 top-full h-2" />
        <HoverCardClose.Provider value={closeNow}>
          <Link href={href} onClick={onOpen} className="block p-3 no-underline cursor-pointer">
            {row && kind ? <ObjectHoverContent row={row} kind={kind} /> : <div className="text-[11px] text-sol-text-dim">{kindTitle} {id} is not in this workspace</div>}
          </Link>
          {canReveal && (
            <div className="flex items-center justify-between gap-2 border-t border-sol-border/60 px-3 py-1.5 text-[10px] text-sol-text-dim">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <ChevronDown className="h-3 w-3 shrink-0" />
                <span className="truncate">The arrow opens it here</span>
              </span>
              <RevealOpenLink href={href} label={openLabel} onOpen={onOpen} variant="compact" />
            </div>
          )}
        </HoverCardClose.Provider>
      </PopoverContent>
    </Popover>
  );
}

/** The preview of one object: what it is and where it stands, its filled fields, the start of its notes. */
function ObjectHoverContent({ row, kind }: { row: any; kind: ModObjectKind & { modTitle?: string } }) {
  const fields = Object.entries(kind.fields ?? {})
    .filter(([name, f]) => f.type !== "markdown" && row.fields?.[name] !== undefined && row.fields?.[name] !== null && row.fields?.[name] !== "")
    .slice(0, CARD_FIELDS);
  const notes = row.body ? stripMarkdown(row.body).slice(0, 220) : "";
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <DynamicIcon name={(kind.icon ?? "box") as any} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-violet" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{row.title || row.short_id}</div>
          {row.status ? <div className="mt-1"><StatusBadge kind={kind} status={row.status} /></div> : null}
        </div>
      </div>
      {fields.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-[22px] text-[11px]">
          {fields.map(([name, f]) => (
            <div key={name} className="contents">
              <dt className="text-sol-text-dim whitespace-nowrap">{f.label ?? name.replace(/_/g, " ")}</dt>
              <dd className="min-w-0 truncate text-sol-text-muted"><FieldValue field={f} value={row.fields[name]} /></dd>
            </div>
          ))}
        </dl>
      ) : null}
      {notes ? <p className="pl-[22px] text-[11px] leading-relaxed text-sol-text-muted line-clamp-3">{notes}</p> : null}
      <div className="flex items-center justify-between gap-2 border-t border-sol-border/60 pt-1.5 text-[10px] text-sol-text-dim">
        <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <ShortId id={row.short_id} />
          <span>·</span>
          <span className="truncate">{kind.title}{kind.modTitle ? ` · ${kind.modTitle}` : ""}</span>
        </span>
        {row.updated_at ? <span className="shrink-0">updated {formatRelativeTime(row.updated_at)}</span> : null}
      </div>
    </div>
  );
}
