import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import bear from "../components/org/avatars/bear.webp";
import crane from "../components/org/avatars/crane.webp";
import elephant from "../components/org/avatars/elephant.webp";
import fox from "../components/org/avatars/fox.webp";
import frog from "../components/org/avatars/frog.webp";
import goat from "../components/org/avatars/goat.webp";
import hare from "../components/org/avatars/hare.webp";
import hedgehog from "../components/org/avatars/hedgehog.webp";
import koala from "../components/org/avatars/koala.webp";
import lynx from "../components/org/avatars/lynx.webp";
import moth from "../components/org/avatars/moth.webp";
import octopus from "../components/org/avatars/octopus.webp";
import otter from "../components/org/avatars/otter.webp";
import owl from "../components/org/avatars/owl.webp";
import penguin from "../components/org/avatars/penguin.webp";
import raccoon from "../components/org/avatars/raccoon.webp";
import robin from "../components/org/avatars/robin.webp";
import seal from "../components/org/avatars/seal.webp";
import snail from "../components/org/avatars/snail.webp";
import squirrel from "../components/org/avatars/squirrel.webp";
import stag from "../components/org/avatars/stag.webp";
import swan from "../components/org/avatars/swan.webp";
import toucan from "../components/org/avatars/toucan.webp";
import whale from "../components/org/avatars/whale.webp";

export type AvatarArt = React.ComponentType<{ className?: string; title?: string }>;

/** Every key's file, by key. */
export const AVATAR_URLS: Record<AvatarKey, string> = {
  fox, owl, otter, crane, bear, hare,
  moth, whale, hedgehog, stag, raccoon, penguin,
  seal, lynx, octopus, toucan, frog, goat,
  swan, snail, elephant, koala, squirrel, robin,
};

/** The animal's name, for the alt text and the hire form's picker. */
export const AVATAR_LABELS: Record<AvatarKey, string> = Object.fromEntries(
  AVATAR_KEYS.map((k) => [k, k.charAt(0).toUpperCase() + k.slice(1)]),
) as Record<AvatarKey, string>;

/** One component per key, each an <img> that fills the box it is given. */
export const AVATAR_ART: Record<AvatarKey, AvatarArt> = Object.fromEntries(
  AVATAR_KEYS.map((key) => [
    key,
    function Art({ className, title }: { className?: string; title?: string }) {
      return <img src={AVATAR_URLS[key]} alt={title ?? AVATAR_LABELS[key]} data-avatar={key} className={className} style={{ width: "100%", height: "100%", display: "block", objectFit: "cover", borderRadius: "9999px" }} />;
    },
  ]),
) as Record<AvatarKey, AvatarArt>;

/** A face's box as a CSS length. A number is pixels; a string is any CSS
 *  length, so a face inside a sentence can be sized in `em` and ride the
 *  prose it sits in (the reference pill draws at 1em). */
export function avatarLength(size: number | string): string {
  return typeof size === "number" ? `${size}px` : size;
}
