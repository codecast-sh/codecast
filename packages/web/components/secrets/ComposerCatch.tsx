"use client";
// The composer's catch: a message about to go out holds a credential-shaped
// string (shared/contracts/secretShapes). The bar above the composer names
// what it found, offers to save it to the Vault under a name, and sends the
// message with a reference in its place. The value goes from the composer's
// text straight to secrets.create (useCreate); the store sees metadata only.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { fingerprint, type SecretMeta } from "@codecast/shared/contracts/secrets";
import type { FoundSecret } from "@codecast/shared/contracts/secretShapes";
import { KeyCap } from "../KeyCap";
import { useInboxStore } from "../../store/inboxStore";
import { secretSig } from "../../hooks/useSyncSecrets";
import { useWorkspacesCollection } from "../../hooks/useWorkspaceCollection";
import { ScopePicker, useCreate, type VaultScope } from "./AddSecretDialog";
import { nameIssue, namesIn, withVaultReferences } from "./vaultModel";

export function ComposerCatch({
  text,
  found,
  teamId,
  onSend,
  onCancel,
}: {
  text: string;
  found: FoundSecret[];
  /** The conversation's team, offered beside Only me. */
  teamId: string | null;
  /** Send this text: the original, or the one with references. */
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const personal = useInboxStore((s) => (s.currentUser?._id ? `user:${String(s.currentUser._id)}` : null));
  const teamName = useInboxStore((s) => (teamId ? (s.teams ?? []).find((t: any) => String(t._id) === teamId)?.name ?? "Team" : null));
  const scope: VaultScope = useMemo(() => ({ team: teamId && teamName ? { key: `team:${teamId}`, id: teamId, name: teamName } : null, personal }), [teamId, teamName, personal]);
  const rows = useWorkspacesCollection<SecretMeta>("secrets", secretSig, [scope.team?.key ?? null, personal]);
  const create = useCreate(scope);
  const [where, setWhere] = useState<"team" | "personal">("personal");
  const [names, setNames] = useState(() => found.map((f) => f.name));
  const [saving, setSaving] = useState(false);
  const taken = useMemo(() => namesIn(rows, where === "team" ? scope.team?.key ?? null : personal), [rows, where, scope.team, personal]);
  const issues = names.map((n, i) => nameIssue(n, taken) ?? (names.indexOf(n) !== i ? "Twice here" : null));
  const canSave = !saving && issues.every((x) => !x);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    for (const [i, f] of found.entries()) {
      const err = await create(where, { name: names[i]!, kind: "key", payload: { value: f.value }, env: f.env ? [f.env] : undefined });
      if (err) {
        setSaving(false);
        toast.error(`${names[i]} was not saved: ${err}`);
        return;
      }
    }
    onSend(withVaultReferences(text, found, names));
  };

  return (
    <div
      role="group"
      aria-label="Credential in this message"
      className="flex flex-col gap-1.5 rounded-lg border border-sol-yellow/50 bg-sol-yellow/[0.07] px-3 py-2 text-[12.5px]"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      data-composer-catch
    >
      {found.map((f, i) => (
        <div key={f.start} className="flex min-w-0 items-center gap-2">
          <KeyRound size={13} className="shrink-0 text-sol-yellow" />
          <span className="shrink-0 font-medium text-sol-text">{f.label}</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-sol-text-dim">{fingerprint(f.value) ?? ""}</span>
          <span className="ml-auto shrink-0 text-sol-text-muted">as</span>
          <input
            value={names[i]}
            onChange={(e) => setNames((xs) => xs.map((x, j) => (j === i ? e.target.value.toLowerCase() : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            autoFocus={i === 0}
            spellCheck={false}
            aria-label={`Vault name for the ${f.label}`}
            className={`w-[12rem] min-w-0 rounded-md border bg-sol-bg px-2 py-1 font-mono text-[12px] text-sol-text outline-none focus:border-sol-yellow ${issues[i] ? "border-sol-red/70" : "border-sol-border"}`}
            data-composer-catch-name
          />
          {issues[i] && <span className="shrink-0 text-[11.5px] text-sol-red">{issues[i]}</span>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <ScopePicker scope={scope} value={where} onChange={setWhere} />
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onCancel} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sol-text-muted hover:text-sol-text">
            Cancel <KeyCap size="xs">esc</KeyCap>
          </button>
          <button type="button" onClick={() => onSend(text)} disabled={saving} className="inline-flex h-7 items-center rounded-md border border-sol-border px-2.5 text-sol-text-muted hover:text-sol-text disabled:opacity-50" data-composer-catch-as-is>
            Send as is
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-sol-yellow px-2.5 font-semibold text-sol-bg hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
            data-composer-catch-save
          >
            {saving ? "Saving…" : "Save to Vault and send"}
            {canSave && <KeyCap size="xs" tone="onAccent">↵</KeyCap>}
          </button>
        </div>
      </div>
    </div>
  );
}
