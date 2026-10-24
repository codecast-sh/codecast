// Settings > Accounts > Touch ID: the person's passkeys (convex/passkeys.ts),
// each with when it was added and last used. A name renames in place; Remove
// and a second Add take Touch ID (lib/passkeyPresence). One they did not add
// is the alarm the enrollment email points here for.
import { useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { Fingerprint, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { NOT_CONFIRMED, type PasskeyMeta } from "@codecast/shared/contracts/secrets";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { PERSON_ONLY, useAgentDrivenTab } from "../../lib/agentTabGuard";
import { addPasskey, usePresence, withPresence } from "../../lib/passkeyPresence";
import { Button } from "../ui/button";
import { SettingsSection } from "./ui";

function PasskeyRow({ passkey }: { passkey: PasskeyMeta }) {
  const rename = useMutation(api.passkeys.rename);
  const remove = useMutation(api.passkeys.remove);
  const confirm = usePresence();
  const [name, setName] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name?.trim();
    setName(null);
    if (!next || next === passkey.name) return;
    const res: any = await rename({ id: passkey._id, name: next });
    setError(res?.error ?? null);
  };
  const drop = async () => {
    setRemoving(true);
    try {
      const res: any = await withPresence(() => confirm("remove_passkey", passkey._id), () => remove({ id: passkey._id }), true);
      setError(res === NOT_CONFIRMED ? null : res?.error ?? null);
    } finally {
      setRemoving(false);
    }
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
              aria-label="Passkey name"
              className="sol-input w-56 py-0.5 text-sm"
            />
          )}
          <div className="mt-0.5 flex gap-3 text-xs text-sol-text-muted">
            <span title={formatFullTimestamp(passkey.created_at)}>added {formatRelativeTime(passkey.created_at)}</span>
            <span title={passkey.last_used_at ? formatFullTimestamp(passkey.last_used_at) : undefined}>{passkey.last_used_at ? `used ${formatRelativeTime(passkey.last_used_at)}` : "never used"}</span>
          </div>
          {error && <div className="mt-0.5 text-xs text-sol-red">{error}</div>}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => void drop()} disabled={removing} title="Remove with Touch ID" className="text-sol-red border-sol-red/30 hover:bg-sol-red/10" data-passkey-remove>
        {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-3.5 w-3.5" />}
        Remove
      </Button>
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
  return (
    <SettingsSection
      title="Touch ID"
      icon={Fingerprint}
      actions={
        <Button variant="outline" size="sm" onClick={() => void add()} disabled={adding || passkeys === undefined || agentTab} title={agentTab ? PERSON_ONLY.enroll : undefined} data-passkey-add>
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Plus className="h-3.5 w-3.5" />}
          Add passkey
        </Button>
      }
    >
      {passkeys === undefined ? (
        <div className={`px-4 py-3 text-sm sm:px-5 ${error ? "text-sol-red" : "text-sol-text-dim"}`}>{error ? "Could not load passkeys" : "Loading"}</div>
      ) : passkeys.length === 0 ? (
        <div className="px-4 py-3 text-sm text-sol-text-muted sm:px-5" data-passkeys-empty>No passkeys</div>
      ) : (
        passkeys.map((p) => <PasskeyRow key={p._id} passkey={p} />)
      )}
    </SettingsSection>
  );
}
