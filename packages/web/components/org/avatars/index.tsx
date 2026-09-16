// Personified roles (docs/architecture/org-staffing.md S13): the face a role
// wears, keyed by orgAvatars. The art is the 24 SVG files beside this index,
// one per key: a soft round ground in a muted palette tone and one animal
// bust in two or three tones, cropped by the circle like a portrait photo.
// Every tone is a literal hex from globals.css so a file renders on its own
// (a static page, an email, a README), which is also why nothing here reads
// currentColor. Vite resolves each import to a URL (inlined as a data URI at
// build), so a face costs no request and the same file draws at 20 and at 96.
import type { ComponentType } from "react";
import { AVATAR_KEYS, avatarOf, isAvatarKey, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import bear from "./bear.svg";
import crane from "./crane.svg";
import elephant from "./elephant.svg";
import fox from "./fox.svg";
import frog from "./frog.svg";
import goat from "./goat.svg";
import hare from "./hare.svg";
import hedgehog from "./hedgehog.svg";
import koala from "./koala.svg";
import lynx from "./lynx.svg";
import moth from "./moth.svg";
import octopus from "./octopus.svg";
import otter from "./otter.svg";
import owl from "./owl.svg";
import penguin from "./penguin.svg";
import raccoon from "./raccoon.svg";
import robin from "./robin.svg";
import seal from "./seal.svg";
import snail from "./snail.svg";
import squirrel from "./squirrel.svg";
import stag from "./stag.svg";
import swan from "./swan.svg";
import toucan from "./toucan.svg";
import whale from "./whale.svg";

/** The file behind each key. */
export const AVATAR_URLS: Record<AvatarKey, string> = {
  fox, owl, otter, crane, bear, hare, moth, whale, hedgehog, stag, raccoon, penguin,
  seal, lynx, octopus, toucan, frog, goat, swan, snail, elephant, koala, squirrel, robin,
};

/** The animal's name, for alt text and the picker. */
export const AVATAR_LABELS: Record<AvatarKey, string> = Object.fromEntries(
  AVATAR_KEYS.map((k) => [k, k.charAt(0).toUpperCase() + k.slice(1)]),
) as Record<AvatarKey, string>;

export type AvatarArtProps = { className?: string; title?: string };

/** The face as a picture that fills its box; the caller sizes the box. */
function artFor(key: AvatarKey): ComponentType<AvatarArtProps> {
  const Art = ({ className, title }: AvatarArtProps) => (
    <img
      src={AVATAR_URLS[key]}
      alt={title ?? AVATAR_LABELS[key]}
      title={title}
      draggable={false}
      data-avatar={key}
      className={className}
      style={{ width: "100%", height: "100%", display: "block", borderRadius: "50%" }}
    />
  );
  Art.displayName = `Avatar.${key}`;
  return Art;
}

/** One component per key. The chart's role node, ghost seat, scope header,
 *  chat pill and wake card pick from this map; a total record, so a key the
 *  contract knows always has art. */
export const AVATAR_ART: Record<AvatarKey, ComponentType<AvatarArtProps>> = Object.fromEntries(
  AVATAR_KEYS.map((k) => [k, artFor(k)]),
) as Record<AvatarKey, ComponentType<AvatarArtProps>>;

/** A role's face at a given size. `avatar` is a key from orgAvatars, or
 *  anything a role row carries (its handle is enough): an unknown value falls
 *  back to the handle's default so every role has a face. */
export function RoleAvatar({ avatar, size = 20, className, title }: { avatar: string; size?: number; className?: string; title?: string }) {
  const key: AvatarKey = isAvatarKey(avatar) ? avatar : avatarOf({ handle: avatar });
  const Art = AVATAR_ART[key];
  return (
    <span className={className} style={{ width: size, height: size, display: "inline-block", flexShrink: 0, lineHeight: 0 }}>
      <Art title={title} />
    </span>
  );
}
