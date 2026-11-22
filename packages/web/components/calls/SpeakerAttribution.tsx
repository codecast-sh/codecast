// Who said each line of a voice note, on the call page
// (docs/architecture/speaker-attribution.md). The provider hands the
// transcript a resolver and one picker; the strip under the audio lists the
// voices. Every write is a store action on callDetails (assignCallSpeaker,
// confirmCallSpeaker, moveCallLineSpeaker), so all of a voice's lines follow
// in the frame it was pressed.
import { useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";
import {
  moveLineTarget,
  recordingSpeakers,
  resolveLineSpeaker,
  shareLabel,
  type SpeakerChoice,
  type SpeakerRoster,
  type WireCallSpeaker,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { AvatarImg } from "../../lib/avatarCache";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { KeyCap } from "../KeyCap";
import { speakerAccent } from "./speakers";
import { SpeakerAttributionContext, useSpeakerAttribution, type SpeakerAttributionValue, type SpeakerPickTarget } from "./speakerContext";
import { speakerPickerItems, type PickerPerson, type SpeakerPickerItem } from "./speakerPickerModel";

type Segment = { seq: number; speaker_id: string; speaker_name: string; t0: number; t1?: number };

const NO_SEGMENTS: Segment[] = [];

function useSpeakerPeople(): { people: PickerPerson[]; roster: SpeakerRoster } {
  const identities = useTeamRosterIdentity();
  return useMemo(() => {
    const people: PickerPerson[] = [];
    const roster: Record<string, string> = {};
    for (const m of identities) {
      if (m.name) roster[m._id] = m.name;
      if (m.is_bot || m.role) continue;
      people.push({ _id: m._id, name: m.name ?? m.email, image: m.image ?? m.github_avatar_url });
    }
    return { people, roster };
  }, [identities]);
}

function choose(transcriptId: string, speakers: WireCallSpeaker[] | undefined, target: SpeakerPickTarget, choice: SpeakerChoice) {
  const s = useInboxStore.getState();
  if (target.kind === "speaker") {
    if ("key" in choice) return;
    s.assignCallSpeaker(transcriptId, target.key, choice);
    return;
  }
  const to = moveLineTarget(speakers, choice);
  if (to.key !== target.key) s.moveCallLineSpeaker(transcriptId, target.seq, to.key);
  if (to.assign) s.assignCallSpeaker(transcriptId, to.key, to.assign);
}

export function SpeakerAttribution({
  call,
  children,
}: {
  call: { _id: string; segments?: Segment[]; speakers?: WireCallSpeaker[] };
  children: React.ReactNode;
}) {
  const transcriptId = String(call._id);
  const speakers = call.speakers;
  const segments = call.segments ?? NO_SEGMENTS;
  const { people, roster } = useSpeakerPeople();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [open, setOpen] = useState<{ target: SpeakerPickTarget; rect: DOMRect } | null>(null);
  const value = useMemo<SpeakerAttributionValue>(
    () => ({
      transcriptId,
      speakers,
      roster,
      resolve: (segment) => resolveLineSpeaker(segment, speakers, roster),
      pick: (target, anchor) => setOpen({ target, rect: anchor.getBoundingClientRect() }),
      hoverKey,
      setHoverKey,
    }),
    [transcriptId, speakers, roster, hoverKey],
  );
  const chips = useMemo(() => recordingSpeakers(segments as any, speakers, roster), [segments, speakers, roster]);
  return (
    <SpeakerAttributionContext.Provider value={value}>
      {children}
      {open && (
        <SpeakerPicker
          key={`${open.target.kind}:${open.target.key}:${open.target.kind === "line" ? open.target.seq : ""}`}
          rect={open.rect}
          items={(q) => speakerPickerItems({ target: open.target, query: q, people, chips, speakers })}
          onPick={(choice) => {
            choose(transcriptId, speakers, open.target, choice);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </SpeakerAttributionContext.Provider>
  );
}

const SECTION_LABEL: Record<SpeakerPickerItem["section"], string | null> = {
  team: "Team",
  recording: "In this recording",
  other: null,
};

function SpeakerPicker({
  rect,
  items: itemsFor,
  onPick,
  onClose,
}: {
  rect: DOMRect;
  items: (query: string) => SpeakerPickerItem[];
  onPick: (choice: SpeakerChoice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const items = itemsFor(query);
  const at = Math.min(active, items.length - 1);
  const select = (item: SpeakerPickerItem | undefined) => {
    if (!item) return;
    if (item.choice) onPick(item.choice);
    else inputRef.current?.focus();
  };
  const move = (to: number) => {
    const next = (to + items.length) % items.length;
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>
        <span aria-hidden style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none" }} />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
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
            placeholder="Who is this"
            aria-label="Who said this"
            aria-activedescendant={items[at] ? `speaker-pick-${items[at].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sol-text outline-none placeholder:text-sol-text-dim"
          />
        </div>
        <div ref={listRef} role="listbox" aria-label="Speakers" className="max-h-72 overflow-y-auto py-1">
          {items.map((item, i) => {
            const label = SECTION_LABEL[item.section];
            const head = label && items[i - 1]?.section !== item.section;
            const divider = !label && items[i - 1] && items[i - 1].section !== item.section;
            return (
              <div key={item.id}>
                {head && <div className="px-2.5 pb-0.5 pt-1.5 text-mark font-medium uppercase tracking-wide text-sol-text-dim">{label}</div>}
                {divider && <div className="my-1 border-t border-sol-border/30" />}
                <div
                  id={`speaker-pick-${item.id}`}
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
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PickerFace({ item }: { item: SpeakerPickerItem }) {
  if (item.person) {
    return (
      <AvatarImg
        src={item.person.image}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
        fallback={
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sol-bg-highlight font-mono text-[10px] text-sol-text-muted">
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
          onMouseEnter={() => ctx.setHoverKey(c.key)}
          onMouseLeave={() => ctx.setHoverKey(null)}
          className={`flex items-center rounded-full border transition-colors ${
            ctx.hoverKey === c.key ? "border-sol-border bg-sol-bg-alt" : "border-sol-border/40"
          } ${c.suggested ? "border-dashed" : ""}`}
        >
          <button
            type="button"
            onClick={(e) => ctx.pick({ kind: "speaker", key: c.key }, e.currentTarget)}
            onFocus={() => ctx.setHoverKey(c.key)}
            onBlur={() => ctx.setHoverKey(null)}
            className="flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-2.5 text-[12px]"
            aria-label={`${c.name}${c.suggested ? ", suggested" : ""}, ${shareLabel(c.share)} of the talking`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full bg-current ${speakerAccent(c.key)}`} />
            <span
              className={
                c.suggested
                  ? "text-sol-text-muted underline decoration-dotted decoration-sol-text-dim underline-offset-[3px]"
                  : "font-medium text-sol-text"
              }
            >
              {c.name}
            </span>
            <span className="font-mono text-mark tabular-nums text-sol-text-dim">{shareLabel(c.share)}</span>
          </button>
          {c.suggested && (
            <button
              type="button"
              onClick={() => useInboxStore.getState().confirmCallSpeaker(ctx.transcriptId, c.key)}
              className="-ml-1 mr-1 rounded-full p-1 text-sol-text-dim transition-colors hover:bg-sol-green/15 hover:text-sol-green"
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
