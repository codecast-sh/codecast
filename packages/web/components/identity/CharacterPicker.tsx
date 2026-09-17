// Choosing a character (docs/architecture/session-characters.md S2). The
// default flow is one click: the grid applies a face the moment it is picked,
// optimistically, with no save button. The name field and the shuffle are
// there for whoever wants them. With several sessions ticked the same picker
// serves the whole selection, and the footer decides whether they share one
// face or take a different face each.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Shuffle, RotateCcw } from "lucide-react";
import {
  AVATAR_KEYS,
  type AvatarKey,
} from "@codecast/shared/contracts/orgAvatars";
import {
  CHARACTER_NAME_MAX,
  characterNameFor,
  cleanCharacterName,
} from "@codecast/shared/contracts/sessionCharacter";
import { AVATAR_LABELS, RoleAvatar } from "../org/avatars";
import { useInboxStore } from "../../store/inboxStore";
import { sessionIdentity, type IdentityRow } from "../../lib/sessionIdentity";
import { moveRadioIndex } from "../team/radioNav";

const COLUMNS = 6;

/** A distinct face each: walk the key list from the picked face so a squad of
 *  N gets N different animals, and give each row that face's own name. */
export function spreadCharacters(ids: string[], from: AvatarKey): Array<{ id: string; avatar: AvatarKey; name: string }> {
  const start = AVATAR_KEYS.indexOf(from);
  return ids.map((id, i) => {
    const avatar = AVATAR_KEYS[(start + i) % AVATAR_KEYS.length];
    return { id, avatar, name: characterNameFor(id, avatar) };
  });
}

export function CharacterPicker({ rows, onDone }: { rows: Array<IdentityRow & Record<string, unknown>>; onDone?: () => void }) {
  const store = useInboxStore;
  const many = rows.length > 1;
  const first = rows[0];
  const current = useMemo(() => (first ? sessionIdentity(first) : null), [first]);
  const currentAvatar = current?.kind === "character" ? current.avatar : AVATAR_KEYS[0];

  const [avatar, setAvatar] = useState<AvatarKey>(currentAvatar);
  const [name, setName] = useState(current?.name ?? "");
  const [nudge, setNudge] = useState(0);
  const [spread, setSpread] = useState(false);
  const [focus, setFocus] = useState(() => Math.max(0, AVATAR_KEYS.indexOf(currentAvatar)));
  const faceRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  // Applying is the gesture: every change writes through immediately, so the
  // face on the card behind the popover answers the click.
  const apply = useCallback((next: { avatar?: AvatarKey; name?: string | null }) => {
    if (many) {
      const s = store.getState();
      const face = next.avatar ?? avatar;
      if (spread && next.avatar !== undefined) s.setSessionCharacters(spreadCharacters(rows.map((r) => r._id), face));
      else s.setSessionCharacters(rows.map((r) => ({ id: r._id, ...next })));
      return;
    }
    if (first) store.getState().setSessionCharacter(first._id, next);
  }, [avatar, first, many, rows, spread, store]);

  const pickFace = useCallback((key: AvatarKey) => {
    setAvatar(key);
    setNudge(0);
    // A face carries its own names, so a name nobody typed follows the face.
    const typed = cleanCharacterName(name);
    const wasSuggested = !typed || (first && typed === characterNameFor(first._id, avatar, nudge));
    const nextName = many || wasSuggested ? (first ? characterNameFor(first._id, key) : null) : typed;
    if (!many && nextName) setName(nextName);
    apply({ avatar: key, ...(many ? {} : { name: nextName }) });
  }, [apply, avatar, first, many, name, nudge]);

  const shuffle = useCallback(() => {
    if (!first) return;
    const n = nudge + 1;
    setNudge(n);
    const next = characterNameFor(first._id, avatar, n);
    setName(next);
    apply({ name: next });
  }, [apply, avatar, first, nudge]);

  const reset = useCallback(() => {
    setNudge(0);
    apply({ avatar: null as unknown as AvatarKey, name: null });
    if (first) {
      const d = sessionIdentity({ _id: first._id });
      setAvatar(d.avatar);
      setName(d.name);
    }
    onDone?.();
  }, [apply, first, onDone]);

  const commitName = useCallback(() => {
    const cleaned = cleanCharacterName(name);
    apply({ name: cleaned });
  }, [apply, name]);

  const onFaceKey = useCallback((e: React.KeyboardEvent, index: number) => {
    const next = moveRadioIndex(e.key, index, AVATAR_KEYS.length, COLUMNS);
    if (next == null) return;
    e.preventDefault();
    setFocus(next);
    faceRefs.current[next]?.focus();
    pickFace(AVATAR_KEYS[next]);
  }, [pickFace]);

  useEffect(() => { faceRefs.current[focus]?.focus(); /* mount focus only */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!first) return null;

  return (
    <div className="p-3 w-[19rem]" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-wide text-sol-text-dim">
          {many ? `Character for ${rows.length} sessions` : "Character"}
        </span>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text"
          title="Back to the one this session was given"
        >
          <RotateCcw className="w-3 h-3" /> Default
        </button>
      </div>

      <div role="radiogroup" aria-label="Character face" className="grid grid-cols-6 gap-1.5">
        {AVATAR_KEYS.map((key, i) => {
          const picked = key === avatar;
          return (
            <button
              key={key}
              ref={(el) => { faceRefs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={picked}
              aria-label={AVATAR_LABELS[key]}
              title={AVATAR_LABELS[key]}
              tabIndex={i === focus ? 0 : -1}
              onKeyDown={(e) => onFaceKey(e, i)}
              onClick={() => { setFocus(i); pickFace(key); }}
              className={`rounded-full transition-transform hover:scale-110 focus-visible:outline-none ${picked ? "scale-110" : ""}`}
              style={picked ? { boxShadow: "0 0 0 2px var(--sol-cyan)" } : undefined}
            >
              <RoleAvatar avatar={key} size={40} />
            </button>
          );
        })}
      </div>

      {!many && (
        <div className="mt-3 flex items-center gap-1.5">
          <input
            ref={nameRef}
            value={name}
            maxLength={CHARACTER_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitName(); onDone?.(); }
              if (e.key === "Escape") { e.preventDefault(); onDone?.(); }
            }}
            placeholder="Name"
            aria-label="Character name"
            className="flex-1 min-w-0 bg-sol-bg-inset border border-sol-border/50 rounded px-2 py-1 text-xs text-sol-text focus:outline-none focus:border-sol-cyan"
          />
          <button
            type="button"
            onClick={shuffle}
            title="Another name for this face"
            aria-label="Another name for this face"
            className="p-1.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
          >
            <Shuffle className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {many && (
        <div className="mt-3 flex items-center gap-3 text-[11px] text-sol-text-muted">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="radio" checked={!spread} onChange={() => setSpread(false)} className="accent-sol-cyan" />
            One face for all
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="radio" checked={spread} onChange={() => { setSpread(true); store.getState().setSessionCharacters(spreadCharacters(rows.map((r) => r._id), avatar)); }} className="accent-sol-cyan" />
            A different face each
          </label>
        </div>
      )}
    </div>
  );
}
