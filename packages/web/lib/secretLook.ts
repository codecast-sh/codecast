// The Vault's shared look: each kind's icon, accent and words, and the
// classes its fields and dialogs share.
import { FileText, Globe, KeyRound, UserRound, type LucideIcon } from "lucide-react";
import type { SecretKind } from "@codecast/shared/contracts/secrets";
import type { VaultScope } from "../hooks/useSyncSecrets";
import { KIND_LOOK } from "../components/secrets/vaultModel";

const KIND_ICON: Record<SecretKind, LucideIcon> = { key: KeyRound, login: UserRound, file: FileText, signin: Globe };

/** Each kind's icon, CSS accent and words (vaultModel KIND_LOOK). */
export const KIND = Object.fromEntries(
  (Object.keys(KIND_LOOK) as SecretKind[]).map((k) => [k, { ...KIND_LOOK[k], icon: KIND_ICON[k], tone: `var(--sol-${KIND_LOOK[k].tone})` }]),
) as Record<SecretKind, { icon: LucideIcon; tone: string; label: string; short: string }>;

/** A Vault form field's look; FIELD_MONO for what is typed as code (names, values, sites, env vars). */
export const FIELD = "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";
export const FIELD_MONO = `${FIELD} font-mono`;

/** A field's border while a file is dragged over it. */
export const DROP_OVER = "!border-sol-yellow/60";

/** The Vault's dialogs: pinned near the top so a taller form grows downward and the controls above stay under the pointer. */
export const VAULT_DIALOG =
  "top-[12vh] w-[34rem] max-w-[calc(100vw-1.5rem)] translate-y-0 grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 sm:rounded-xl [&>*]:min-w-0";

/** Where a new secret goes until the person picks: the team when there is one. The dialog and the composer's catch both open on it. */
export const defaultWhere = (scope: VaultScope): "team" | "personal" => (scope.team ? "team" : "personal");
