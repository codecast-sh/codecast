// "Who are you today?" (DESIGN 6.9): any of the 24 animals and a name. Opened
// from any you chip; the change shows everywhere at once (optimistic `me`).
import { createContext, useCallback, useContext, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CHARACTER_NAMES, CHARACTER_NAME_MAX, characterNameFor, cleanCharacterName } from "@codecast/shared/contracts/sessionCharacter";
import { AVATAR_KEYS, AVATAR_LABELS, AVATAR_URLS, type AvatarKey } from "../lib/avatars";
import { useIdentity } from "../lib/identity";
import { useDesktop } from "../lib/useMedia";
import { Button, IconButton } from "../ui/Button";
import type { Person } from "../ui/Face";
import { DiceIcon } from "../ui/icons";
import { Keys } from "../ui/Keys";
import { Modal } from "../ui/Modal";
import s from "./CharacterPicker.module.css";

type Open = (herePeople?: Person[]) => void;
const PickerContext = createContext<Open>(() => {});

export const useCharacterPicker = () => useContext(PickerContext);

export function CharacterPickerHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Person[] | null>(null);
  const show = useCallback<Open>((here = []) => setOpen(here), []);
  return (
    <PickerContext.Provider value={show}>
      {children}
      {open && <CharacterPicker here={open} onClose={() => setOpen(null)} />}
    </PickerContext.Provider>
  );
}

const pick = <T,>(xs: readonly T[], not?: T): T => {
  const pool = xs.length > 1 && not !== undefined ? xs.filter((x) => x !== not) : xs;
  return pool[Math.floor(Math.random() * pool.length)];
};

function CharacterPicker({ here, onClose }: { here: Person[]; onClose: () => void }) {
  const { me, setCharacter } = useIdentity();
  const desktop = useDesktop();
  const [avatar, setAvatar] = useState<AvatarKey>(me.avatar);
  const [name, setName] = useState(me.name);
  const [popKey, setPopKey] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const cols = desktop ? 6 : 4;
  const countId = useId();

  const worn = new Map<AvatarKey, number>();
  for (const p of here) if (p.id !== me.id) worn.set(p.avatar, (worn.get(p.avatar) ?? 0) + 1);

  const choose = (next: AvatarKey) => {
    if (next === avatar) return;
    // A name that was just the old face's default follows the face.
    if ((CHARACTER_NAMES[avatar] as readonly string[]).includes(name.trim())) setName(characterNameFor(me.id, next));
    setAvatar(next);
    setPopKey((k) => k + 1);
  };

  const finalName = cleanCharacterName(name) ?? characterNameFor(me.id, avatar);

  const save = () => {
    // Both parts, always: a cleared name would otherwise fall back to the
    // default for the face the visitor started with.
    void setCharacter({ avatar, name: finalName });
    onClose();
  };

  const surprise = () => {
    const next = pick(AVATAR_KEYS, avatar);
    setAvatar(next);
    setName(pick(CHARACTER_NAMES[next]));
    setPopKey((k) => k + 1);
  };

  const onGridKey = (e: KeyboardEvent) => {
    const idx = AVATAR_KEYS.indexOf((document.activeElement as HTMLElement | null)?.dataset.key as AvatarKey);
    if (idx < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(Math.max(idx + step, 0), AVATAR_KEYS.length - 1);
    grid.current?.querySelector<HTMLElement>(`[data-key="${AVATAR_KEYS[next]}"]`)?.focus();
  };

  return (
    <Modal onClose={onClose} label="Who are you today?" className={s.modal}>
      <div className={s.me}>
        <h2 className={s.title}>Who are you today?</h2>
        <span className={s.bigFace} key={popKey}>
          <img src={AVATAR_URLS[avatar]} alt={AVATAR_LABELS[avatar]} />
        </span>
        <div className={s.nameRow}>
          <div className={s.nameField}>
            <input
              aria-label="Name"
              aria-describedby={countId}
              value={name}
              maxLength={CHARACTER_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              spellCheck={false}
            />
            <span className={s.count} id={countId}>{name.length} / {CHARACTER_NAME_MAX}</span>
          </div>
          <IconButton label="Roll a name" size={44} className={s.dice} onClick={() => setName(pick(CHARACTER_NAMES[avatar], name))}>
            <DiceIcon />
          </IconButton>
        </div>
        <div className={s.suggest}>
          {CHARACTER_NAMES[avatar].map((n) => (
            <button key={n} className={`${s.suggestion} ${n === name.trim() ? s.current : ""}`} aria-pressed={n === name.trim()} onClick={() => setName(n)}>
              {n}
            </button>
          ))}
        </div>
        <p className={s.footnote}>Everyone sees this face next to what you say and what you change.</p>
      </div>

      <div className={s.zooSide}>
        <div className={s.zooHead}>
          <h3 className={s.zooTitle}>24 animals</h3>
          {worn.size > 0 && (
            <span className={s.legend}>
              <i className={s.wornDot} /> someone here has it
            </span>
          )}
        </div>
        <div className={s.zoo} ref={grid} onKeyDown={onGridKey} role="listbox" aria-label="Animals" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Enter">
          {AVATAR_KEYS.map((k) => {
            const count = worn.get(k);
            const label = count ? `${AVATAR_LABELS[k]} · ${count} here` : AVATAR_LABELS[k];
            return (
              <button
                key={k}
                data-key={k}
                role="option"
                aria-selected={k === avatar}
                aria-label={label}
                title={label}
                tabIndex={k === avatar ? 0 : -1}
                className={`${s.animal} ${k === avatar ? s.selected : ""}`}
                onClick={() => choose(k)}
              >
                <img src={AVATAR_URLS[k]} alt="" draggable={false} />
                {count && <i className={s.wornDot} />}
              </button>
            );
          })}
        </div>
        {desktop && (
          <p className={s.keys}>
            <Keys keys={["←", "→", "↑", "↓"]}>move</Keys>
            <Keys keys={["Enter"]}>choose</Keys>
            <Keys keys={["Esc"]}>close</Keys>
          </p>
        )}
        <div className={s.foot}>
          <p className={s.repeat}>Names can repeat. Faces tell you apart.</p>
          <Button size="md" onClick={surprise}>Surprise me</Button>
          <Button size="md" variant="ink" className={s.be} onClick={save}>
            Be {finalName}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
