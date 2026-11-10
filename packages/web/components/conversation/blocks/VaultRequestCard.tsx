"use client";
// `cast vault request <name>`: an agent asked for a secret it does not have.
// The card is the request itself, live from the store's `secrets` row: while it
// is open the person fills it right here (the value goes from the field to
// secrets.fulfill and nowhere else, see ValueEditor) or declines it; once it is
// ready the card rests as one line naming who filled it. Once its row is gone
// (declined here, on the Vault page or by the CLI, or deleted) it rests as a
// line saying so.

import { useState } from "react";
import Link from "next/link";
import { Check, Lock, X } from "lucide-react";
import { SECRET_KINDS, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import type { VaultReadyMessage } from "@codecast/shared/contracts";
import { useHeldSecrets, useSecrets, useSecretsLoaded } from "../../../hooks/useSyncSecrets";
import { stripAnsiCodes } from "../../../lib/ansi";
import { entityRoute } from "../../../lib/entityLinks";
import { formatFullTimestamp, useRelativeTime } from "../../../lib/conversationFormat";
import { vaultShortIdIn } from "../../castCommand";
import { RequestHead } from "../../secrets/parts";
import { DeclineRequest, ValueEditor } from "../../secrets/ValueForm";

const asKind = (k: string | undefined): SecretKind => ((SECRET_KINDS as readonly string[]).includes(k ?? "") ? (k as SecretKind) : "key");

export function VaultRequestCard({ name, kind, why, output, isError }: { name: string; kind?: string; why?: string; output: string; isError: boolean }) {
  const shortId = vaultShortIdIn(output);
  const scoped = useSecrets();
  const held = useHeldSecrets();
  const loaded = useSecretsLoaded();
  // The short id the CLI printed names the row exactly, in whichever of the
  // viewer's workspaces it is; only before the command printed one does the
  // name stand in (an open request first, if two workspaces share it).
  const row = shortId
    ? held.find((r) => r.short_id === shortId)
    : scoped.find((r) => r.name === name && r.status === "requested") ?? scoped.find((r) => r.name === name);
  const href = entityRoute("secret", row?.short_id || shortId || name) ?? "/vault";
  const [declined, setDeclined] = useState(false);

  if (declined) return <GoneLine name={row?.name ?? name} state="Declined" />;
  if (shortId && !row && loaded) return <GoneLine name={name} state="Gone from Vault" />;
  if (row?.status === "ready") return <ReadyLine row={row} href={href} />;

  const k = row?.kind ?? asKind(kind);
  const reason = row?.request_why ?? why;
  const failed = isError && !row;
  return (
    <div className="my-2 rounded-md border border-[color-mix(in_srgb,var(--sol-magenta)_35%,var(--sol-border))] bg-sol-bg px-3 py-2.5" data-vault-request-card={name} data-vault-request-state={failed ? "failed" : "open"}>
      {/* The same head line as the Vault's card; before the row syncs, a tag stands where the asker goes. */}
      <RequestHead
        row={row}
        kind={k}
        name={<Link href={href} className="min-w-0 font-mono text-[13px] font-semibold [overflow-wrap:anywhere] text-sol-text hover:underline underline-offset-2">{row?.name ?? name}</Link>}
        fallback={
          <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${failed ? "bg-sol-red/10 text-sol-red" : "bg-sol-magenta/10 text-sol-magenta"}`}>
            {failed ? "not sent" : "needs a value"}
          </span>
        }
      />
      {reason ? <div className="mt-1 pl-[34px] text-[12.5px] leading-snug text-sol-text">{reason}</div> : null}
      <div className="mt-2 pl-[34px]">
        {failed ? (
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] text-sol-red">{stripAnsiCodes(output).trim() || "The request failed"}</pre>
        ) : !row ? (
          // A request still on its way (the command has not printed its id, or
          // the Vault has not loaded here yet): the Vault page is where it is filled.
          <Link href={href} className="inline-flex items-center gap-1 text-[12px] text-sol-blue hover:underline"><Lock className="h-3 w-3" />Open in Vault</Link>
        ) : (
          // A sign-in request offers its two ways to save one (SaveSignin.tsx) through the same editor; Decline is the Vault card's.
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <ValueEditor row={row} mode="fulfill" />
            </div>
            <DeclineRequest row={row} onDeclined={() => setDeclined(true)} className="h-[30px] shrink-0 rounded-md px-2 text-[12px] text-sol-text-dim hover:bg-sol-red/10 hover:text-sol-red" />
          </div>
        )}
      </div>
    </div>
  );
}

function ReadyLine({ row, href }: { row: SecretMeta; href: string }) {
  // The last person to write the row filled it; a secret that already had a
  // value when it was asked for was never written since, so its creator stands in.
  return <Ready name={row.name} href={href} by={row.updated_by_name ?? row.created_by_name} at={row.updated_at} data-vault-request-card={row.name} />;
}

/** A request whose row is gone (declined here, or removed anywhere): the line names it without a link. */
function GoneLine({ name, state }: { name: string; state: "Declined" | "Gone from Vault" }) {
  return (
    <div className="my-1 flex min-w-0 items-center gap-1.5 text-xs text-sol-text-dim" data-vault-request-card={name} data-vault-request-state={state === "Declined" ? "declined" : "gone"}>
      <X className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-mono text-sol-text">{name}</span>
      <span className="shrink-0">{state}</span>
    </div>
  );
}

/** The vault-ready message that woke the session: a system line naming the secret. Its usage text is for the agent. */
export function VaultReadyLine({ vault, timestamp }: { vault: VaultReadyMessage; timestamp: number }) {
  return <Ready name={vault.name} href={entityRoute("secret", vault.id || vault.name) ?? "/vault"} at={timestamp} title={vault.text} data-vault-ready={vault.name} />;
}

/** A secret that is ready, one look wherever it shows: a filled request card and the message that says so. */
function Ready({ name, href, by, at, title, ...rest }: { name: string; href: string; by?: string; at: number; title?: string } & Record<`data-${string}`, unknown>) {
  const relative = useRelativeTime();
  return (
    <div className="my-1 flex min-w-0 items-center gap-1.5 text-xs text-sol-text-dim" title={title} {...rest}>
      <Check className="h-3.5 w-3.5 shrink-0 text-sol-green" />
      <Link href={href} className="truncate font-mono text-sol-text hover:underline underline-offset-2">{name}</Link>
      <span className="shrink-0 text-sol-green/80">Ready</span>
      {by ? <span className="truncate">· filled by {by}</span> : null}
      <span className="shrink-0 tabular-nums" title={formatFullTimestamp(at)}>· {relative(at)}</span>
    </div>
  );
}
