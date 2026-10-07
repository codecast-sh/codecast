import { useState } from "react";
import { AVATAR_URLS, characterTitle, type AvatarKey } from "../lib/avatars";
import { Dots } from "./Dots";
import s from "./Face.module.css";

export type Person = { id: string; avatar: AvatarKey; name: string };

/** A character's face: a squircle (radius 30%) with a faint edge, an optional
 *  typing bubble, and the name's first letter if the art fails (DESIGN 5).
 *  `decorative`: the name is already said beside it, so screen readers skip it. */
export function Face({ person, size = 28, typing = false, decorative = false, className = "" }: { person: Pick<Person, "avatar" | "name">; size?: number; typing?: boolean; decorative?: boolean; className?: string }) {
  const [broken, setBroken] = useState(false);
  const title = characterTitle(person);
  return (
    <span className={`${s.face} ${className}`} style={{ width: size, height: size }} title={title} aria-hidden={decorative || undefined}>
      {broken ? (
        <span className={s.letter} style={{ fontSize: Math.round(size * 0.45) }}>{person.name.charAt(0)}</span>
      ) : (
        <img src={AVATAR_URLS[person.avatar]} alt={title} draggable={false} onError={() => setBroken(true)} />
      )}
      {typing && (
        <span className={s.typing} aria-label="typing">
          <Dots size={3} />
        </span>
      )}
    </span>
  );
}
