// The org pages' synced collections, registered in CLIENT_SYNC_REGISTRY by
// spread (store/clientSyncRegistry.ts), kept here to hold that file under its size.
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const ORG_SYNC_COLLECTIONS = {
  // A template role's instance (org-hire.md H11) as the role page reads it
  // (orgTemplates.instanceForRole), one row per role viewed. Delta: each role
  // page feeds its own row. localFirst: a hire answer changed on the page
  // lands on the draft's `config` (answerOrgTemplateInput) and the echo
  // retires the lock. Most of the row is nested objects the identity reuse
  // skips, so the feeder stamps `rev`, a digest of the whole row.
  orgTemplateInstances: {
    persistence: { kind: "collection", key: "orgTemplateInstances" },
    hydration: { phase: "deferred" },
    localFirst: true,
    sync: { isDelta: true },
    feeds: ["orgTemplates.instanceForRole"],
    writtenBy: ["orgTemplates"],
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
