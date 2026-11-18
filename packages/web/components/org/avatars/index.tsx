// Personified roles (docs/architecture/org-staffing.md S13): the art for each
// avatar key. The key list and the default-for-a-handle live in the shared
// contract (packages/shared/contracts/orgAvatars.ts); the ART lives here,
// web-only, because it is React and image files.
//
// The 24 WebP files beside this module are the single source of the art: a
// faceless cut-paper portrait of one person (at most five flat paper pieces,
// crisp edges, a small shadow between layers), generated with gpt-image-2
// from one shared prompt so the set reads as one family. Each file is a
// 256 px square the caller crops to a circle, so one source serves every size
// from the 15 px author pill to the 96 px scope header. Vite resolves each
// import to a hashed asset URL, and the guard test (avatars.guard.test.ts)
// keeps the keys and the files agreeing. The file names are the avatar keys,
// which still name the animals the set began as (orgAvatars contract).
//
// These are read at 18 to 22 px far more often than large, which sets three
// rules:
//   Silhouette carries identity. With no face drawn, each person differs by
//     hair or headwear outline (a bob, a turban, space buns, a fedora), so
//     the head is large and its outline never cropped.
//   Flat, empty ground. Nothing behind the head but one paper color.
//   The ground contrasts with the figure. Eleven grounds rotate through the
//     set and also tell two similar silhouettes apart in a list.

import { defaultAvatarFor, isAvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_URLS, AVATAR_LABELS, avatarLength } from "../../../lib/orgAvatars";

/**
 * A role's face at `size` px. `avatar` takes whatever a role row carries: a
 * known key draws that key, anything else (a handle, an unknown key from a
 * newer build) draws the stable default for that string, so every role has a
 * face without anyone choosing one.
 */
export function RoleAvatar({ avatar, size = 20, className, title }: { avatar: string; size?: number | string; className?: string; title?: string }) {
  const key = isAvatarKey(avatar) ? avatar : defaultAvatarFor(avatar);
  return (
    <span
      className={className}
      style={{ width: avatarLength(size), height: avatarLength(size), display: "inline-block", flexShrink: 0, borderRadius: "9999px", overflow: "hidden" }}
    >
      <img src={AVATAR_URLS[key]} alt={title ?? AVATAR_LABELS[key]} data-avatar={key} style={{ width: "100%", height: "100%", display: "block" }} />
    </span>
  );
}
