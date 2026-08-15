// Which agent-feature snippets should we offer this user as "new"?
//
// The catalog (shared contracts) stamps every snippet with a `shipped` date.
// A snippet is upsell-worthy when it shipped AFTER the account existed (so a
// fresh signup, who meets everything in the install wizard, is never nagged),
// shipped recently enough to still be news, isn't already enabled on any of
// the user's machines, and hasn't been dismissed. Dismissals live in the
// cross-device `clientState.dismissed` bag as one flat stamp per slug.

import {
  SNIPPET_CATALOG,
  type SnippetDescriptor,
  type DeviceSnippetSettings,
} from "@codecast/shared/contracts";

export const SNIPPET_INTRO_PREFIX = "snippet_intro_" as const;

/** Stop advertising a snippet this long after it ships. */
const UPSELL_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/** Ships within days of signup count as "was there when you arrived". */
const NEW_ACCOUNT_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export function snippetIntroKey(slug: string): `snippet_intro_${string}` {
  return `${SNIPPET_INTRO_PREFIX}${slug}`;
}

/** Enabled on this device, reading the canonical slug or its pre-rename twin. */
export function snippetEnabledOn(
  settings: DeviceSnippetSettings | undefined,
  s: SnippetDescriptor,
): boolean {
  const bag = settings?.snippets;
  if (!bag) return false;
  return (bag[s.slug] ?? (s.wireSlug ? bag[s.wireSlug] : undefined)) === true;
}

/** "New" pill on the settings page: recently shipped, regardless of state. */
export function isRecentlyShipped(s: SnippetDescriptor, now = Date.now()): boolean {
  const shipped = Date.parse(s.shipped);
  return Number.isFinite(shipped) && now - shipped < UPSELL_WINDOW_MS;
}

export function newSnippetsFor({
  userCreatedAt,
  devices,
  dismissed,
  now = Date.now(),
}: {
  /** Account creation time (Convex `_creationTime`); undefined = unknown. */
  userCreatedAt: number | undefined;
  devices: Array<{ settings?: DeviceSnippetSettings | null }>;
  dismissed: Record<string, unknown> | undefined;
  now?: number;
}): SnippetDescriptor[] {
  // No machines = not a CLI user yet; the setup banner owns that journey.
  if (devices.length === 0) return [];
  return SNIPPET_CATALOG.filter((s) => {
    const shipped = Date.parse(s.shipped);
    if (!Number.isFinite(shipped)) return false;
    if (now - shipped >= UPSELL_WINDOW_MS) return false;
    // Unknown account age reads as an old account: they have devices, so the
    // account certainly predates anything shipping this window.
    if (userCreatedAt !== undefined && shipped <= userCreatedAt + NEW_ACCOUNT_GRACE_MS)
      return false;
    if (dismissed?.[snippetIntroKey(s.slug)]) return false;
    return !devices.some((d) => snippetEnabledOn(d.settings ?? undefined, s));
  });
}
