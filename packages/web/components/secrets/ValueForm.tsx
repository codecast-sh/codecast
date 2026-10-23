"use client";
// Typing a secret's value: the fields for its kind (add, rotate and filling a
// request all use them), smart paste, and the editor that writes a new value
// into an existing row. A value goes from this component's state straight to
// its Convex action and nowhere else.

import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { payloadFingerprint, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { useInboxStore } from "../../store/inboxStore";
import { useFillRequest } from "../../hooks/useSyncSecrets";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { CopyButton, SecretInput } from "./parts";
import { SigninRequestFill } from "./SaveSignin";
import { EMPTY_DRAFT, checkedPayload, classifyPaste, type ValueDraft } from "./vaultModel";

const inputCls =
  "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 font-mono text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";

export function ValueFields({
  kind,
  draft,
  onChange,
  onEnvLine,
  onImport,
  onIssuer,
  autoFocus,
  site,
}: {
  kind: SecretKind;
  draft: ValueDraft;
  onChange: (d: ValueDraft) => void;
  /** A pasted `KEY=value`: the value is filled here, the env var goes to the caller. */
  onEnvLine?: (env: string) => void;
  /** A pasted .env with several keys: the caller opens Import with the text. */
  onImport?: (text: string) => void;
  /** A pasted 2FA link's issuer, a name the caller may suggest. */
  onIssuer?: (issuer: string) => void;
  autoFocus?: boolean;
  /** For a sign-in, the site the CLI line names. */
  site?: string;
}) {
  const set = (patch: Partial<ValueDraft>) => onChange({ ...draft, ...patch });
  // A paste is read before it lands: a 2FA link goes to the seed wherever it is
  // pasted, one KEY=value splits into env and value, a whole .env opens Import.
  const smartPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    const p = classifyPaste(text);
    if (!p) return;
    if (p.kind === "otp" && kind === "login") {
      e.preventDefault();
      set({ totp_seed: p.seed, ...(p.account && !draft.username ? { username: p.account } : {}) });
      if (p.issuer) onIssuer?.(p.issuer);
    } else if (p.kind === "env-line" && kind === "key") {
      e.preventDefault();
      set({ value: p.value });
      onEnvLine?.(p.env);
    } else if (p.kind === "env-file" && onImport && kind !== "file") {
      e.preventDefault();
      onImport(text);
    }
  };

  if (kind === "key") {
    return <SecretInput value={draft.value} onChange={(value) => set({ value })} onPaste={smartPaste} placeholder="Paste the key" autoFocus={autoFocus} name="vault-value" />;
  }
  if (kind === "login") {
    // Each line keeps a short label, since a filled field has no placeholder left to say which it is.
    const line = (label: string, field: React.ReactNode) => (
      <div className="flex min-w-0 items-start gap-2">
        <span className="w-16 shrink-0 pt-1.5 text-[11.5px] text-sol-text-dim">{label}</span>
        {field}
      </div>
    );
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {line("Username", <input value={draft.username} onChange={(e) => set({ username: e.target.value })} onPaste={smartPaste} placeholder="bot@acme.dev" autoFocus={autoFocus} autoComplete="new-password" spellCheck={false} data-1p-ignore className={inputCls} name="vault-username" />)}
        {line("Password", <SecretInput value={draft.password} onChange={(password) => set({ password })} onPaste={smartPaste} name="vault-password" />)}
        {line("2FA", <SecretInput value={draft.totp_seed} onChange={(totp_seed) => set({ totp_seed })} onPaste={smartPaste} placeholder="Setup key or otpauth:// link" name="vault-totp" />)}
      </div>
    );
  }
  if (kind === "file") {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <input value={draft.filename} onChange={(e) => set({ filename: e.target.value })} placeholder="Filename (optional), like service-account.json" spellCheck={false} className={inputCls} />
        <SecretInput value={draft.content} onChange={(content) => set({ content })} onPaste={smartPaste} placeholder="Paste the file's content" autoFocus={autoFocus} multiline name="vault-file" />
      </div>
    );
  }
  const cmd = `cast vault save-signin ${site?.trim() || "<site>"}`;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-sol-border/70 bg-sol-bg-alt/50 px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-sol-text">{cmd}</code>
      <CopyButton get={() => cmd} label="Copy command" />
    </div>
  );
}

type ValueEditorProps = {
  row: SecretMeta;
  mode: "fulfill" | "rotate";
  /** The confirm a typed value goes through first (a rotate's blast radius). */
  review?: SwitchLedger;
  /** A fill was pressed; the row already reads ready. */
  onStart?: () => void;
  /** The server took it; `delivered` when the session that asked was told. */
  onDone?: (res: { delivered?: boolean }) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
};

/**
 * Writes a new value into an existing row: `fulfill` fills an open request,
 * `rotate` replaces a stored value. Either paints on the row at once (a fill
 * flips it to ready; a rotate counts the kept value and stamps rotated_at);
 * the server's answer confirms it or puts the row back.
 */
export function ValueEditor(props: ValueEditorProps) {
  // A sign-in is never typed in: it is captured from a browser (SaveSignin.tsx).
  if (props.row.kind !== "signin") return <TypedValueEditor {...props} />;
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <div className="min-w-0 flex-1">
        <SigninRequestFill row={props.row} />
      </div>
      {props.onCancel && (
        <button type="button" onClick={props.onCancel} className="h-8 shrink-0 px-1.5 text-[12px] text-sol-text-muted hover:text-sol-text">
          Cancel
        </button>
      )}
    </div>
  );
}

function TypedValueEditor({ row, mode, review, onStart, onDone, onCancel, autoFocus }: ValueEditorProps) {
  const rotate = useAction(api.secrets.rotate);
  const fill = useFillRequest();
  const stageSecret = useInboxStore((s) => s.stageSecret);
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkedPayload(row.kind, draft);
  const ready = "payload" in checked;
  const save = async () => {
    if (!ready || busy) return;
    setReviewing(false);
    const now = Date.now();
    if (mode === "rotate") {
      // The editor closes on the press; the row already shows the swap, and a refusal puts it back.
      stageSecret({ ...row, version_count: (row.version_count ?? 0) + 1, rotated_at: now, updated_at: now, fingerprint: payloadFingerprint(row.kind, checked.payload) });
      setDraft(EMPTY_DRAFT);
      onDone?.({});
      const res: any = await rotate({ ref: row._id, payload: checked.payload }).catch((err: Error) => ({ error: err.message }));
      if (res?.error) {
        stageSecret(row);
        toast.error(`${row.name} was not replaced: ${res.error}`);
      }
      return;
    }
    setBusy(true);
    setError(null);
    const answer = fill(row, checked.payload);
    onStart?.();
    const res = await answer;
    setBusy(false);
    if ("error" in res) return setError(res.error);
    setDraft(EMPTY_DRAFT);
    onDone?.(res);
  };
  const site = row.sites?.[0] ?? row.name;
  return (
    <>
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (review && ready) setReviewing(true);
        else void save();
      }}
      data-vault-value-editor={mode}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <ValueFields kind={row.kind} draft={draft} onChange={setDraft} autoFocus={autoFocus} site={site} />
        </div>
        {row.kind !== "signin" && (
          <button
            type="submit"
            disabled={!ready || busy}
            className="h-[30px] shrink-0 rounded-md bg-sol-yellow px-3 text-[12.5px] font-semibold text-sol-bg hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
          >
            {busy ? "Saving" : mode === "fulfill" ? "Save" : "Replace"}
          </button>
        )}
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-[30px] shrink-0 px-1.5 text-[12px] text-sol-text-muted hover:text-sol-text">
            Cancel
          </button>
        )}
      </div>
      {error ? <div className="text-[11.5px] text-sol-red">{error}</div> : null}
    </form>
    {reviewing && review && <SwitchReview ledger={review} onClose={() => setReviewing(false)} onConfirm={() => void save()} />}
    </>
  );
}
