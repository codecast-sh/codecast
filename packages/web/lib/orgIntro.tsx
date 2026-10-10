import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";

/** The face the introduction card wears: the head of people. */
export const ORG_INTRO_HEAD_OF_PEOPLE: AvatarKey = "owl";

/** One name for one thing: the page is Org, the feature is the organization,
 *  so the card says it. */
export const ORG_INTRO_TITLE = "Meet your organization";

// ---------------------------------------------------------------- seen, on the store

type SeenPrefs = { org_upsell_seen?: boolean };

export type OrgSeenStore = { clientState: { ui?: SeenPrefs | null }; updateClientUI: (partial: SeenPrefs) => void };

/** Answering the introduction card sells the feature (S20): the card never
 *  rises afterwards. One write, only when unset. */
export function markOrgUpsellSeen(st: OrgSeenStore) {
  if (!st.clientState.ui?.org_upsell_seen) st.updateClientUI({ org_upsell_seen: true });
}
