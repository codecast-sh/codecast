// Personified roles (docs/architecture/org-staffing.md S13): the art for each
// avatar key. The key list and the default-for-a-handle live in the shared
// contract (packages/shared/contracts/orgAvatars.ts); the ART lives here,
// web-only, because it is React and image files.
//
// The 24 WebP files beside this module are the single source of the art: a
// painted storybook portrait of one animal, head and neck in three quarter
// view on a grainy muted sky, generated with gpt-image-2 from one shared style
// reference so the set reads as one family. Each file is a 256 px square that
// the caller crops to a circle, so one source serves every size from the 15 px
// author pill to the 96 px scope header. Vite resolves each import to a hashed
// asset URL. The guard test (avatars.guard.test.ts) keeps the keys and the
// files agreeing.

import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_KEYS, defaultAvatarFor, isAvatarKey } from "@codecast/shared/contracts/orgAvatars";

import bear from "./bear.webp";
import crane from "./crane.webp";
import elephant from "./elephant.webp";
import fox from "./fox.webp";
import frog from "./frog.webp";
import goat from "./goat.webp";
import hare from "./hare.webp";
import hedgehog from "./hedgehog.webp";
import koala from "./koala.webp";
import lynx from "./lynx.webp";
import moth from "./moth.webp";
import octopus from "./octopus.webp";
import otter from "./otter.webp";
import owl from "./owl.webp";
import penguin from "./penguin.webp";
import raccoon from "./raccoon.webp";
import robin from "./robin.webp";
import seal from "./seal.webp";
import snail from "./snail.webp";
import squirrel from "./squirrel.webp";
import stag from "./stag.webp";
import swan from "./swan.webp";
import toucan from "./toucan.webp";
import whale from "./whale.webp";

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

/**
 * A role's face at `size` px. `avatar` takes whatever a role row carries: a
 * known key draws that key, anything else (a handle, an unknown key from a
 * newer build) draws the stable default for that string, so every role has a
 * face without anyone choosing one.
 */
export function RoleAvatar({ avatar, size = 20, className, title }: { avatar: string; size?: number; className?: string; title?: string }) {
  const key = isAvatarKey(avatar) ? avatar : defaultAvatarFor(avatar);
  return (
    <span
      className={className}
      style={{ width: `${size}px`, height: `${size}px`, display: "inline-block", flexShrink: 0, borderRadius: "9999px", overflow: "hidden" }}
    >
      <img src={AVATAR_URLS[key]} alt={title ?? AVATAR_LABELS[key]} data-avatar={key} style={{ width: "100%", height: "100%", display: "block" }} />
    </span>
  );
}
