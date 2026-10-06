// The 24 faces, from the web app's art (never copied), plus the URLs an app
// gets in `init`. The app is a public https page, so Chrome refuses
// http://localhost images there: a shell on http sends data: URLs instead.
import { AVATAR_KEYS, type AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_LABELS, AVATAR_URLS } from "../../../web/lib/orgAvatars";

export { AVATAR_KEYS, AVATAR_LABELS, AVATAR_URLS, type AvatarKey };

export function characterTitle(p: { name: string; avatar: AvatarKey }): string {
  return `${p.name} the ${AVATAR_LABELS[p.avatar].toLowerCase()}`;
}

let forApps: Promise<Record<AvatarKey, string>> | null = null;

function dataUrl(url: string): Promise<string> {
  return fetch(url)
    .then((r) => r.blob())
    .then((b) => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(b);
    }));
}

export function avatarUrlsForApps(): Promise<Record<AvatarKey, string>> {
  forApps ??= Promise.all(
    AVATAR_KEYS.map(async (k) => {
      const url = new URL(AVATAR_URLS[k], location.href).href;
      return [k, location.protocol === "https:" ? url : await dataUrl(url)] as const;
    }),
  ).then((pairs) => Object.fromEntries(pairs) as Record<AvatarKey, string>);
  return forApps;
}
