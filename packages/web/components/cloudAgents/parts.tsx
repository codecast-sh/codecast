// Small cloud agent pieces the connect dialogs, the setup card, the composer
// and the session header share. A leaf module: the dialogs are imported by
// providerUi.ts, which index.tsx imports, so they cannot import index.tsx
// themselves.
import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink, Info } from "lucide-react";
import { CLOUD_AGENT_BACKFILL_DAYS, CLOUD_SESSION_SOURCES, cloudSessionSyncOn, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** A short line that opens its detail: on a tap too, since a touch device shows no title. */
export function DetailPopover({ label, about, className, small = false, children }: { label: string; about: string; className: string; small?: boolean; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`inline-flex shrink-0 items-center gap-1 text-center ${small ? "text-[10px]" : "text-[11px]"} ${className}`}>
          {label}
          <Info className={`${small ? "h-2.5 w-2.5" : "h-3 w-3"} shrink-0`} aria-label={about} />
        </button>
      </PopoverTrigger>
      {/* Above the compose modal's layer (ComposeHost), where the composer's row also renders. */}
      <PopoverContent side="top" className="z-[250] w-80 border-sol-border bg-sol-bg p-3 text-xs leading-relaxed text-sol-text-muted">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A link to one of the provider's pages, by its name. */
export function CloudAgentPageLink({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2 hover:opacity-80 ${className ?? ""}`}>
      {label} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

/** A link to the provider's page where access to a repository is given, by its name. */
export function CloudAgentRepoAccessLink({ spec, className }: { spec: CloudAgentProviderSpec; className?: string }) {
  return <CloudAgentPageLink href={spec.repoAccessUrl} label={spec.repoAccessLabel} className={className} />;
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
