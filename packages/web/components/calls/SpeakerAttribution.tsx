// Who said each line of a voice note, on the call page
// (docs/architecture/speaker-attribution.md). The provider hands the
// transcript a resolver and one picker; the strip under the audio lists the
// voices. Every write is a store action on callDetails (assignCallSpeaker,
// confirmCallSpeaker, moveCallLineSpeaker), so all of a voice's lines follow
// in the frame it was pressed.
import { useId, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Check, MoreHorizontal, Search, UserRoundPen } from "lucide-react";
import {
  isSpeakerKey,
  moveLineTarget,
  recordingSpeakers,
  resolveLineSpeaker,
  shareLabel,
  type SpeakerChoice,
    type WireCallSpeaker,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { KeyCap } from "../KeyCap";
import { speakerAccent } from "./speakers";
import { SpeakerAttributionContext, settleSpeakerWrite, useSpeakerAttribution, type SpeakerAttributionValue, type SpeakerPickTarget } from "./speakerContext";
import { speakerPickerItems, type SpeakerPickerItem } from "./speakerPickerModel";
import { useSpeakerPeople } from "./speakerRoster";

type Segment = { seq: number; speaker_id: string; speaker_name: string; t0: number; t1?: number };

const NO_SEGMENTS: Segment[] = [];

function choose(transcriptId: string, speakers: WireCallSpeaker[] | undefined, target: SpeakerPickTarget, choice: SpeakerChoice) {
  const s = useInboxStore.getState();
  if (target.kind === "speaker") {
    if ("key" in choice) return;
    settleSpeakerWrite(s.assignCallSpeaker(transcriptId, target.key, choice));
    return;
  }
  const to = moveLineTarget(speakers, choice);
  if (to.key !== target.key) settleSpeakerWrite(s.moveCallLineSpeaker(transcriptId, target.seq, to.key));
  if (to.assign) settleSpeakerWrite(s.assignCallSpeaker(transcriptId, to.key, to.assign));
}

/** Provides the speakers to everything under it while `enabled` (a voice
 *  note whose lines carry voice keys); otherwise only renders its children,
 *  so the page keeps one tree either way. The voice under the pointer is not
 *  in the context: it is one CSS rule (`data-speaker` on every turn), so
 *  hovering a chip re-renders no turn. */
export function SpeakerAttribution({
  call,
  enabled,
  children,
}: {
  call: { _id: string; team_id?: unknown; segments?: Segment[]; speakers?: WireCallSpeaker[]; speaker_names?: Record<string, string> | null } | null | undefined;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const transcriptId = String(call?._id ?? "");
  const speakers = call?.speakers;
  const segments = call?.segments ?? NO_SEGMENTS;
  const { people, roster } = useSpeakerPeople(call);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [open, setOpen] = useState<{ target: SpeakerPickTarget; opener: Element } | null>(null);
  const value = useMemo<SpeakerAttributionValue>(
    () => ({
      transcriptId,
      speakers,
      roster,
      resolve: (segment) => resolveLineSpeaker(segment, speakers, roster),
      pick: (target, opener) => setOpen({ target, opener }),
      setHoverKey,
    }),
    [transcriptId, speakers, roster],
  );
  const chips = useMemo(() => recordingSpeakers(segments as any, speakers, roster), [segments, speakers, roster]);
  // Back to where the picker was opened from (or that place's successor when a
  // write re-drew it); never after a press elsewhere, which owns the focus now.
  const close = (refocus: boolean) => {
    const was = open;
    setOpen(null);
    if (!refocus || !was) return;
    requestAnimationFrame(() => {
      // Only into a void: focus somewhere else by now was put there on purpose.
      if (document.activeElement && document.activeElement !== document.body) return;
      const t = was.target;
      const el = was.opener.isConnected
        ? was.opener
        : document.querySelector(t.kind === "line" ? `[data-seq="${t.seq}"] [data-line-menu]` : `[data-speaker-name="${t.key}"]`);
      (el as HTMLElement | null)?.focus();
    });
  };
  return (
    <SpeakerAttributionContext.Provider value={enabled ? value : null}>
      {enabled && hoverKey && isSpeakerKey(hoverKey) && <style>{hoverRule(hoverKey)}</style>}
      {children}
      {enabled && open && (
        <SpeakerPicker
          key={`${open.target.kind}:${open.target.key}:${open.target.kind === "line" ? open.target.seq : ""}`}
          opener={open.opener}
          title={open.target.kind === "line" ? "Who said this?" : `Who is ${value.resolve({ speaker_id: open.target.key, speaker_name: open.target.key }).name}?`}
          onConfirm={() => {
            settleSpeakerWrite(useInboxStore.getState().confirmCallSpeaker(transcriptId, open.target.key));
            close(true);
          }}
          items={(q) => speakerPickerItems({ target: open.target, query: q, people, chips, speakers })}
          onPick={(choice) => {
            choose(transcriptId, speakers, open.target, choice);
            close(true);
          }}
          onClose={close}
        />
      )}
    </SpeakerAttributionContext.Provider>
  );
}

/** The hovered voice's turns light and the others step back. `key` is a
 *  `spk:<n>` (checked by the caller), so it is safe inside the selector. */
function hoverRule(key: string): string {
  return `[data-speaker]{transition:opacity .12s}[data-speaker]:not([data-speaker="${key}"]){opacity:.4}[data-speaker="${key}"]{background:color-mix(in srgb,var(--sol-bg-alt) 60%,transparent)}[data-speaker-chip="${key}"]{border-color:var(--sol-border);background:var(--sol-bg-alt)}`;
}

const SECTIONS: Record<SpeakerPickerItem["section"], { label: string; shown: boolean }> = {
  confirm: { label: "Suggested", shown: false },
  team: { label: "Team", shown: true },
  recording: { label: "In this recording", shown: true },
  other: { label: "Other", shown: false },
};

function SpeakerPicker({
  opener,
  title,
  items: itemsFor,
  onPick,
  onConfirm,
  onClose,
}: {
  opener: Element;
  title: string;
  items: (query: string) => SpeakerPickerItem[];
  onPick: (choice: SpeakerChoice) => void;
  onConfirm: () => void;
  onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  // Anchored to the element itself, so it follows a scroll or a re-layout.
  const anchor = useMemo(() => ({ current: opener }), [opener]);
  const outside = useRef(false);
  // The opener left the page (its turn re-drew under a push): nothing to point at.
  useWatchEffect(() => {
    const watch = new MutationObserver(() => {
      if (!opener.isConnected) onClose(false);
    });
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [opener]);
  const items = itemsFor(query);
  const at = Math.min(active, items.length - 1);
  const select = (item: SpeakerPickerItem | undefined) => {
    if (!item) return;
    if (item.confirm) onConfirm();
    else if (item.choice) onPick(item.choice);
    else inputRef.current?.focus();
  };
  const move = (to: number) => {
    const next = (to + items.length) % items.length;
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const groups: Array<{ section: SpeakerPickerItem["section"]; rows: Array<{ item: SpeakerPickerItem; i: number }> }> = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    if (last?.section === item.section) last.rows.push({ item, i });
    else groups.push({ section: item.section, rows: [{ item, i }] });
  });
  return (
    <Popover open onOpenChange={(o) => !o && onClose(!outside.current)}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        align="start"
        className="w-72 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onPointerDownOutside={() => {
          outside.current = true;
        }}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="truncate px-2.5 pt-2 text-[12px] font-medium text-sol-text">{title}</div>
        <div className="flex items-center gap-2 border-b border-sol-border/40 px-2.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(at + 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(at - 1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                select(items[at]);
              }
            }}
            placeholder="Search or type a name"
            role="combobox"
            aria-label="Who said this"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items[at] ? `${listId}-${items[at].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sol-text outline-none placeholder:text-sol-text-dim"
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Speakers" className="max-h-72 overflow-y-auto py-1">
          {groups.map((g, gi) => {
            const sec = SECTIONS[g.section];
            return (
              <div key={g.section} role="group" aria-label={sec.label}>
                {sec.shown ? (
                  <div aria-hidden className="px-2.5 pb-0.5 pt-1.5 text-mark font-medium uppercase tracking-wide text-sol-text-dim">{sec.label}</div>
                ) : gi > 0 ? (
                  <div aria-hidden className="my-1 border-t border-sol-border/30" />
                ) : null}
                {g.rows.map(({ item, i }) => (
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={i === at}
                    data-index={i}
                    onMouseMove={() => i !== at && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(item)}
                    className={`mx-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] ${
                      i === at ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-secondary"
                    }`}
                  >
                    <PickerFace item={item} />
                    <span className={`min-w-0 flex-1 truncate ${item.id === "unknown" ? "text-sol-text-muted" : ""}`}>{item.label}</span>
                    {item.current && <Check className="h-3.5 w-3.5 shrink-0 text-sol-cyan" aria-label="Current" />}
                    {i === at && <KeyCap size="xs">Enter</KeyCap>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PickerFace({ item }: { item: SpeakerPickerItem }) {
  if (item.confirm) return <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sol-green"><Check className="h-3.5 w-3.5" /></span>;
  if (item.person) {
    return (
      <AvatarImg
        src={item.person.image}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
        fallback={
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sol-bg-highlight font-mono text-mark text-sol-text-muted">
            {(item.person.name || "?").charAt(0).toUpperCase()}
          </span>
        }
      />
    );
  }
  if (item.voice) return <span className={`flex h-5 w-5 shrink-0 items-center justify-center ${speakerAccent(item.voice)}`}><span className="h-2 w-2 rounded-full bg-current" /></span>;
  return <span className="h-5 w-5 shrink-0" />;
}

/** One chip per voice, in the order they first speak: color, name, share of
 *  the talking. A voice match's name is provisional until confirmed. */
export function SpeakerStrip({ segments }: { segments: Segment[] | undefined }) {
  const ctx = useSpeakerAttribution();
  const chips = useMemo(
    () => (ctx ? recordingSpeakers((segments ?? NO_SEGMENTS) as any, ctx.speakers, ctx.roster) : []),
    [segments, ctx?.speakers, ctx?.roster],
  );
  if (!ctx || chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Speakers">
      {chips.map((c) => (
        <div
          key={c.key}
          role="listitem"
          data-speaker-chip={c.key}
          onMouseEnter={() => ctx.setHoverKey(c.key)}
          onMouseLeave={() => ctx.setHoverKey(null)}
          className={`flex min-w-0 max-w-[16rem] items-center rounded-full border border-sol-border/40 transition-colors ${c.suggested ? "border-dashed" : ""}`}
        >
          <button
            type="button"
            onClick={(e) => ctx.pick({ kind: "speaker", key: c.key }, e.currentTarget)}
            onFocus={() => ctx.setHoverKey(c.key)}
            onBlur={() => ctx.setHoverKey(null)}
            className="flex min-w-0 items-center gap-1.5 rounded-full py-1 pl-2.5 pr-2.5 text-[12px]"
            aria-label={`${c.name}${c.suggested ? ", suggested" : ""}, ${shareLabel(c.share)} of the talking`}
            title={c.name}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full bg-current ${speakerAccent(c.key)}`} />
            <span
              className={`min-w-0 truncate ${
                c.suggested
                  ? "text-sol-text-muted underline decoration-dotted decoration-sol-text-dim underline-offset-[3px]"
                  : "font-medium text-sol-text"
              }`}
            >
              {c.name}
            </span>
            <span className="shrink-0 font-mono text-mark tabular-nums text-sol-text-dim">{shareLabel(c.share)}</span>
          </button>
          {c.suggested && (
            <button
              type="button"
              onClick={() => settleSpeakerWrite(useInboxStore.getState().confirmCallSpeaker(ctx.transcriptId, c.key))}
              className="-ml-1 mr-1 shrink-0 rounded-full p-1 text-sol-text-dim transition-colors hover:bg-sol-green/15 hover:text-sol-green"
              aria-label={`Confirm ${c.name}`}
              title={`Confirm ${c.name}`}
            >
              <Check className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** The keys a turn would take as a press (seek or select) stay with the
 *  control; any other key (Esc for the page's selection) carries on. */
const keepPress = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/** A turn's speaker in a voice note: the resolved name in the voice's color,
 *  a press opens the picker for the whole voice. Quieter while a voice match
 *  only suggests it. */
export function TurnSpeakerName({ segment, className = "" }: { segment: { speaker_id: string; speaker_name: string }; className?: string }) {
  const ctx = useSpeakerAttribution();
  if (!ctx) return null;
  const who = ctx.resolve(segment);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.pick({ kind: "speaker", key: who.key }, e.currentTarget);
      }}
      onKeyDown={keepPress}
      data-speaker-name={who.key}
      title={who.name}
      className={`inline-block max-w-[20rem] truncate align-bottom rounded-sm font-medium ${speakerAccent(who.key)} ${
        who.suggested ? "opacity-70 underline decoration-dotted underline-offset-[3px]" : ""
      } hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-border ${className}`}
      aria-label={`${who.name}${who.suggested ? ", suggested" : ""}: change who this is`}
    >
      {who.name}
    </button>
  );
}

/** One line's menu: "Said by…" moves just this line to another voice. */
export function LineSpeakerMenu({ seq, speakerKey }: { seq: number; speakerKey: string }) {
  const ctx = useSpeakerAttribution();
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!ctx) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onClick={stop}
          onKeyDown={keepPress}
          onPointerDown={stop}
          data-line-menu
          className="ml-1 inline-flex h-4 w-5 translate-y-[2px] items-center justify-center rounded text-sol-text-dim opacity-0 transition-opacity hover:bg-sol-bg-alt hover:text-sol-text focus-visible:opacity-100 group-hover/line:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-60"
          aria-label="Line menu"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={stop} onKeyDown={keepPress} onPointerDown={stop} onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem
          onSelect={() => {
            const el = triggerRef.current;
            if (el) setTimeout(() => ctx.pick({ kind: "line", seq, key: speakerKey }, el), 0);
          }}
        >
          <UserRoundPen /> Said by…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
