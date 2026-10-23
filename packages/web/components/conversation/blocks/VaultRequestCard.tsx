"use client";
// `cast vault request <name>`: an agent asked for a secret it does not have.
// The card is the request itself, live from the store's `secrets` row: while it
// is open the person fills it right here (the value goes from the field to
// secrets.fulfill and nowhere else, see ValueEditor); once it is ready the card
// rests as one line naming who filled it.

import Link from "next/link";
import { Check, Lock } from "lucide-react";
import { SECRET_KINDS, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import type { VaultReadyMessage } from "@codecast/shared/contracts";
import { useSecrets } from "../../../hooks/useSyncSecrets";
import { stripAnsiCodes } from "../../../lib/ansi";
import { entityRoute } from "../../../lib/entityLinks";
import { formatFullTimestamp, useRelativeTime } from "../../../lib/conversationFormat";
import { vaultShortIdIn } from "../../castCommand";
import { KIND, KindGlyph } from "../../secrets/parts";
import { ValueEditor } from "../../secrets/ValueForm";

const asKind = (k: string | undefined): SecretKind => ((SECRET_KINDS as readonly string[]).includes(k ?? "") ? (k as SecretKind) : "key");

export function VaultRequestCard({ name, kind, why, output, isError }: { name: string; kind?: string; why?: string; output: string; isError: boolean }) {
  const shortId = vaultShortIdIn(output);
  const rows = useSecrets();
  // The short id the CLI printed names the row exactly; before the command
  // finished, the name does (an open request first, if two workspaces share it).
  const row = (shortId ? rows.find((r) => r.short_id === shortId) : undefined)
    ?? rows.find((r) => r.name === name && r.status === "requested")
    ?? rows.find((r) => r.name === name);
  const href = entityRoute("secret", row?.short_id || shortId || name) ?? "/vault";

  if (row?.status === "ready") return <ReadyLine row={row} href={href} />;

  const k = row?.kind ?? asKind(kind);
  const reason = row?.request_why ?? why;
  const failed = isError && !row;
  return (
    <div className="my-2 mx-1 rounded-md border border-[color-mix(in_srgb,var(--sol-magenta)_35%,var(--sol-border))] bg-sol-bg px-3 py-2.5" data-vault-request-card={name}>
      <div className="flex min-w-0 items-center gap-2">
        <KindGlyph kind={k} />
        <Link href={href} className="truncate font-mono text-[13px] font-semibold text-sol-text hover:underline underline-offset-2">{row?.name ?? name}</Link>
        <span className="shrink-0 text-[11.5px] text-sol-text-dim">{KIND[k].label}</span>
        <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium ${failed ? "bg-sol-red/10 text-sol-red" : "bg-sol-magenta/10 text-sol-magenta"}`}>
          {failed ? "not sent" : "needs a value"}
        </span>
      </div>
      {reason ? <div className="mt-1 pl-[34px] text-[12.5px] leading-snug text-sol-text">{reason}</div> : null}
      <div className="mt-2 pl-[34px]">
        {failed ? (
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] text-sol-red">{stripAnsiCodes(output).trim() || "The request failed"}</pre>
        ) : !row ? (
          // A request in a workspace this view does not list (another team), or
          // one still on its way: the Vault page is where it is filled.
          <Link href={href} className="inline-flex items-center gap-1 text-[12px] text-sol-blue hover:underline"><Lock className="h-3 w-3" />Open in Vault</Link>
        ) : (
          // A sign-in request offers its two ways to save one (SaveSignin.tsx) through the same editor.
          <ValueEditor row={row} mode="fulfill" />
        )}
      </div>
    </div>
  );
}

function ReadyLine({ row, href }: { row: SecretMeta; href: string }) {
  const relative = useRelativeTime();
  // The last person to write the row filled it; a secret that already had a
  // value when it was asked for was never written since, so its creator stands in.
  const by = row.updated_by_name ?? row.created_by_name;
  const at = row.updated_at;
  return (
    <div className="my-1 mx-1 flex min-w-0 items-center gap-1.5 text-xs" data-vault-request-card={row.name}>
      <Check className="h-3.5 w-3.5 shrink-0 text-sol-green" />
      <Link href={href} className="truncate font-mono text-sol-text hover:underline underline-offset-2">{row.name}</Link>
      <span className="shrink-0 text-sol-green/80">Ready</span>
      {by ? <span className="truncate text-sol-text-dim">· filled by {by}</span> : null}
      <span className="shrink-0 text-sol-text-dim tabular-nums" title={formatFullTimestamp(at)}>· {relative(at)}</span>
    </div>
  );
}

/** The vault-ready message that woke the session: a system line naming the secret. Its usage text is for the agent. */
export function VaultReadyLine({ vault, timestamp }: { vault: VaultReadyMessage; timestamp: number }) {
  const relative = useRelativeTime();
  return (
    <div className="my-1.5 mx-1 flex min-w-0 items-center gap-1.5 text-xs text-sol-text-dim" title={vault.text} data-vault-ready={vault.name}>
      <Lock className="h-3.5 w-3.5 shrink-0 text-sol-yellow/80" />
      <Link href={entityRoute("secret", vault.id || vault.name) ?? "/vault"} className="truncate font-mono text-sol-text hover:underline underline-offset-2">{vault.name}</Link>
      <span className="shrink-0 text-sol-green/80">ready in Vault</span>
      <span className="shrink-0 tabular-nums" title={formatFullTimestamp(timestamp)}>· {relative(timestamp)}</span>
    </div>
  );
}
