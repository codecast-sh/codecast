// Small cloud agent pieces the connect dialogs and the setup card share. A
// leaf module: the dialogs are imported by providerUi.ts, which index.tsx
// imports, so they cannot import index.tsx themselves.
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { CLOUD_AGENT_BACKFILL_DAYS, CLOUD_SESSION_SOURCES, cloudSessionSyncOn, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";

/** A link to the provider's page where access to a repository is given, by its name. */
export function CloudAgentRepoAccessLink({ spec, className }: { spec: CloudAgentProviderSpec; className?: string }) {
  return (
    <a href={spec.repoAccessUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 hover:opacity-80 ${className ?? ""}`}>
      {spec.repoAccessLabel} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

/**
 * In a connect dialog, once connected: whether the provider's agents started
 * elsewhere sync into the inbox (the account's sync setting), or where to turn
 * that on.
 */
export function CloudAgentConnectedSync({ spec, onNavigate }: { spec: CloudAgentProviderSpec; onNavigate?: () => void }) {
  const source = CLOUD_SESSION_SOURCES[spec.syncSource];
  const on = useInboxStore((s) => cloudSessionSyncOn(source.field, (s.currentUser as Record<string, unknown> | null)?.[source.field] as boolean | undefined));
  return (
    <p className="text-[11px] text-sol-text-dim">
      {on ? `Your ${source.label} from the last ${CLOUD_AGENT_BACKFILL_DAYS} days sync into your inbox.` : (
        <>
          To bring your {source.label} into your inbox, turn on{" "}
          <Link href="/settings/sync" onClick={onNavigate} className="underline decoration-dotted underline-offset-2 hover:text-sol-text">Sync {source.label}</Link>.
        </>
      )}
    </p>
  );
}
