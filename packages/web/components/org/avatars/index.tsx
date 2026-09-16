// Personified roles (docs/architecture/org-staffing.md S13): the art for each
// avatar key. The key list and the default-for-a-handle live in the shared
// contract (packages/shared/contracts/orgAvatars.ts); the ART lives here,
// web-only, because it is React and SVG.
//
// The 24 SVG files beside this module are the single source of the art. Vite
// resolves each import to a URL (inlined as a data URI when small), and every
// key draws as an <img> that fills the box its caller sized — so one file
// renders the same inline, in a static page, and in a contact sheet. The
// guard test (avatars.guard.test.ts) keeps the keys, the files and the palette
// agreeing.

import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_KEYS, defaultAvatarFor, isAvatarKey } from "@codecast/shared/contracts/orgAvatars";

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
      return <img src={AVATAR_URLS[key]} alt={title ?? AVATAR_LABELS[key]} data-avatar={key} className={className} style={{ width: "100%", height: "100%", display: "block" }} />;
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
