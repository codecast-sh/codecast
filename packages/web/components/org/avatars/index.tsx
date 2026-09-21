// Personified roles (docs/architecture/org-staffing.md S13): the art for each
// avatar key. The key list and the default-for-a-handle live in the shared
// contract (packages/shared/contracts/orgAvatars.ts); the ART lives here,
// web-only, because it is React and image files.
//
// The 24 WebP files beside this module are the single source of the art: a
// soft painted storybook portrait of one animal, generated with gpt-image-2
// from one shared style reference so the set reads as one family. Each file is
// a 256 px square the caller crops to a circle, so one source serves every
// size from the 15 px author pill to the 96 px scope header. Vite resolves
// each import to a hashed asset URL, and the guard test
// (avatars.guard.test.ts) keeps the keys and the files agreeing.
//
// Three rules earn their keep, because these are read at 18 to 22 px far more
// often than large, and the first round failed there:
//   Whole head, tight. The head fills about 80 percent of the frame and its
//     outline is never cropped. What identifies an animal that small is its
//     silhouette (a fox's ears, a stag's antlers), not its eyes, so a face
//     crop that cuts the ears is unreadable however sharp it is.
//   Flat, empty ground. The first round spent half of each frame on sky, moon
//     and cloud, which left the animal about 7 px wide once shrunk.
//   The ground CONTRASTS with the animal rather than matching it. An orange
//     fox on peach is a blob at 18 px; the same fox on teal is unmistakable.
//     The six grounds (teal, slate blue, sand gold, sage, terracotta, rose)
//     also do the work of telling two tawny animals apart in a list.

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
