// Settings > Accounts > Touch ID: the person's passkeys (convex/passkeys.ts),
// each with when it was added and last used, or how long a new one waits out
// its probation. A name renames in place; Remove and a second Add take Touch
// ID (lib/passkeyPresence), except Remove of one that went in with no grant
// (removableUnasked), which is one press. One they did not add is the alarm
// the enrollment email, the phone notice and the banner point here for.
import { useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { Fingerprint, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { inProbation, type PasskeyMeta } from "@codecast/shared/contracts/secrets";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { PERSON_ONLY, useAgentDrivenTab } from "../../lib/agentTabGuard";
import { addPasskey } from "../../lib/passkeyPresence";
import { VAULT_PRIMARY } from "../../lib/secretLook";
import { probationHours, useRemovePasskey } from "../../hooks/useRemovePasskey";
import { Button } from "../ui/button";
import { SettingsSection } from "./ui";

function PasskeyRow({ passkey, count }: { passkey: PasskeyMeta; count: number }) {
  const rename = useMutation(api.passkeys.rename);
  const { drop, removing, error: removeError, unasked } = useRemovePasskey(passkey, count);
  const [name, setName] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const error = removeError ?? renameError;
  const save = async () => {
    const next = name?.trim();
    setName(null);
    if (!next || next === passkey.name) return;
    const res: any = await rename({ id: passkey._id, name: next });
    setRenameError(res?.error ?? null);
  };
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5" data-passkey={passkey._id}>
      <div className="flex min-w-0 items-center gap-3">
        <Fingerprint className="h-4 w-4 shrink-0 text-sol-text-dim" />
        <div className="min-w-0">
          {name === null ? (
            <button type="button" onClick={() => setName(passkey.name)} title="Rename" className="block max-w-full truncate text-left text-sm text-sol-text hover:text-sol-cyan" data-passkey-name>
              {passkey.name}
            </button>
          ) : (
            <input
              autoFocus
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setName(null);
              }}
              aria-label="Name"
              className="sol-input w-56 py-0.5 text-sm"
            />
          )}
          <div className="mt-0.5 flex gap-3 text-xs text-sol-text-muted">
            <span title={formatFullTimestamp(passkey.created_at)}>added {formatRelativeTime(passkey.created_at)}</span>
            {inProbation(passkey) ? (
              <span className="text-sol-orange" title={formatFullTimestamp(passkey.probation_until!)} data-passkey-probation>
                confirms in {probationHours(passkey)}h
              </span>
            ) : (
              <span title={passkey.last_used_at ? formatFullTimestamp(passkey.last_used_at) : undefined}>{passkey.last_used_at ? `used ${formatRelativeTime(passkey.last_used_at)}` : "never used"}</span>
            )}
          </div>
          {error && <div className="mt-0.5 text-xs text-sol-red">{error}</div>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void drop()}
        disabled={removing}
        title={unasked ? "Remove" : "Remove with Touch ID"}
        aria-label={unasked ? "Remove" : "Remove with Touch ID"}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red disabled:opacity-50"
        data-passkey-remove
      >
        {removing ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Trash2 size={14} />}
      </button>
    </div>
  );
}

export function PasskeysSection() {
  // Accounts stays up if the list cannot be read; the section says so instead.
  const { data: passkeys, error } = useQueryNoThrow(api.passkeys.list, {});
  const client = useConvex();
  const agentTab = useAgentDrivenTab();
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    try {
      await addPasskey(client, !!passkeys?.length);
    } finally {
      setAdding(false);
    }
  };
  const addProps = { onClick: () => void add(), disabled: adding || passkeys === undefined || agentTab, title: agentTab ? PERSON_ONLY.enroll : undefined, "data-passkey-add": true };
  const addIcon = adding ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : agentTab ? <Lock className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />;
  return (
    <SettingsSection
      title="Touch ID"
      icon={Fingerprint}
      actions={
        passkeys?.length ? (
          <Button variant="outline" size="sm" {...addProps}>
            {addIcon}
            Add Touch ID
          </Button>
        ) : null
      }
    >
      {passkeys === undefined ? (
        <div className={`px-4 py-3 text-sm sm:px-5 ${error ? "text-sol-red" : "text-sol-text-dim"}`}>{error ? "Could not load Touch ID" : "Loading"}</div>
      ) : passkeys.length === 0 ? (
        <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5" data-passkeys-empty>
          <div className="flex min-w-0 items-center gap-3">
            <Fingerprint className="h-4 w-4 shrink-0 text-sol-text-dim" />
            <span className="text-sm text-sol-text-muted">Not set up</span>
          </div>
          <button
            type="button"
            {...addProps}
            className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] ${VAULT_PRIMARY}`}
          >
            {addIcon}
            Add Touch ID
          </button>
        </div>
      ) : (
        passkeys.map((p) => <PasskeyRow key={p._id} passkey={p} count={passkeys.length} />)
      )}
    </SettingsSection>
  );
}
