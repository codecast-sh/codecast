import { useState } from "react";
import { AVATAR_URLS, characterTitle, type AvatarKey } from "../lib/avatars";
import { Dots } from "./Dots";
import s from "./Face.module.css";

export type Person = { id: string; avatar: AvatarKey; name: string };

/** A character's face: a squircle (a circle at 24px and below) with an ink
 *  border sized to the face, an optional typing bubble, and a letter on cream
 *  if the art fails. */
export function Face({ person, size = 30, typing = false, className = "" }: { person: Pick<Person, "avatar" | "name">; size?: number; typing?: boolean; className?: string }) {
  const [broken, setBroken] = useState(false);
  const tier = size >= 48 ? s.thick : size > 24 ? s.mid : s.thin;
  const title = characterTitle(person);
  return (
    <span className={`${s.face} ${tier} ${className}`} style={{ width: size, height: size, borderRadius: size > 24 ? size * 0.35 : "50%" }} title={title}>
      {broken ? (
        <span className={s.letter} style={{ fontSize: size * 0.45 }}>{person.name.charAt(0)}</span>
      ) : (
        <img src={AVATAR_URLS[person.avatar]} alt={title} draggable={false} onError={() => setBroken(true)} />
      )}
      {typing && (
        <span className={s.typing} aria-label="typing">
          <Dots size={4} />
        </span>
      )}
    </span>
  );
}
