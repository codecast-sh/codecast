"use client";
// Typing a secret's value: the fields for its kind (add, rotate and filling a
// request all use them), smart paste, and the editor that writes a new value
// into an existing row. A value goes from this component's state straight to
// its Convex action and nowhere else.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { useFillRequest, useSwapValue, useVaultActions } from "../../hooks/useSyncSecrets";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { Row, SecretInput } from "./parts";
import { FIELD_MONO, VAULT_PRIMARY } from "../../lib/secretLook";
import { declineLedger } from "../../lib/secretLedgers";
import { useFileDrop } from "../../hooks/useFileDrop";
import { SigninRequestFill } from "./SaveSignin";
import { EMPTY_DRAFT, checkedPayload, classifyPaste, type ValueDraft } from "./vaultModel";

const KEEP = "Keep current";

export function ValueFields({
  kind,
  draft,
  onChange,
  onEnvLine,
  onImport,
  onIssuer,
  autoFocus,
  rows,
  keep,
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
  /** A login's lines as form rows, their labels in the form's label column. */
  rows?: boolean;
  /** Replacing a login: a field left blank keeps its current value, so each says so, and the password takes focus. */
  keep?: boolean;
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
    const line = (label: string, field: React.ReactNode) =>
      rows ? (
        <Row label={label} align="input">
          {field}
        </Row>
      ) : (
        <div className="flex min-w-0 items-start gap-2">
          <span className="w-16 shrink-0 pt-1.5 text-[11.5px] text-sol-text-dim">{label}</span>
          {field}
        </div>
      );
    return (
      <div className={`flex min-w-0 flex-col ${rows ? "" : "gap-1.5"}`}>
        {line("Username", <input value={draft.username} onChange={(e) => set({ username: e.target.value })} onPaste={smartPaste} placeholder={keep ? KEEP : "bot@acme.dev"} autoFocus={autoFocus && !keep} autoComplete="new-password" spellCheck={false} data-1p-ignore className={FIELD_MONO} name="vault-username" />)}
        {line("Password", <SecretInput value={draft.password} onChange={(password) => set({ password })} onPaste={smartPaste} placeholder={keep ? KEEP : undefined} autoFocus={autoFocus && keep} name="vault-password" />)}
        {line("2FA", <SecretInput value={draft.totp_seed} onChange={(totp_seed) => set({ totp_seed })} onPaste={smartPaste} placeholder={keep ? KEEP : "Setup key or otpauth:// link"} name="vault-totp" />)}
      </div>
    );
  }
  // A sign-in is never typed: it is captured from a browser (SaveSignin.tsx).
  return kind === "file" ? <FileFields draft={draft} set={set} onPaste={smartPaste} autoFocus={autoFocus} /> : null;
}

/** A file's name and content: typed, pasted, chosen or dropped. */
function FileFields({ draft, set, onPaste, autoFocus }: { draft: ValueDraft; set: (patch: Partial<ValueDraft>) => void; onPaste: (e: React.ClipboardEvent) => void; autoFocus?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const take = async (f: File) => set({ filename: f.name, content: await f.text() });
  const drop = useFileDrop((f) => void take(f));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <input value={draft.filename} onChange={(e) => set({ filename: e.target.value })} placeholder="Filename (optional), like service-account.json" spellCheck={false} className={FIELD_MONO} />
        <button type="button" onClick={() => picker.current?.click()} className="h-8 shrink-0 rounded-md border border-sol-border px-2.5 text-[12px] text-sol-text-muted hover:text-sol-text" data-vault-file-choose>
          Choose file
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void take(f);
          }}
        />
      </div>
      <SecretInput value={draft.content} onChange={(content) => set({ content })} onPaste={onPaste} placeholder="Paste or drop the file" autoFocus={autoFocus} multiline name="vault-file" drop={drop} />
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
  const swapValue = useSwapValue();
  const fill = useFillRequest();
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkedPayload(row.kind, draft);
  const ready = "payload" in checked;
  // Replacing a login lays its lines out in the panel's label column, each blank one keeping its current value.
  const loginReplace = mode === "rotate" && row.kind === "login";
  const save = async () => {
    if (!ready || busy) return;
    setReviewing(false);
    if (mode === "rotate") {
      // The editor closes on the press; the panel already shows the swap, and a refusal puts it back.
      setDraft(EMPTY_DRAFT);
      onDone?.({});
      const error = await swapValue(row, { kind: "rotated", payload: checked.payload });
      if (error) toast.error(`${row.name} was not replaced: ${error}`);
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
  const actions = (
    <span className="flex shrink-0 items-center gap-1.5">
      <button
        type="submit"
        disabled={!ready || busy}
        className={`h-[30px] shrink-0 rounded-md px-3 text-[12.5px] ${VAULT_PRIMARY}`}
      >
        {busy ? "Saving" : mode === "fulfill" ? "Save" : "Replace"}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} className="h-[30px] shrink-0 px-1.5 text-[12px] text-sol-text-muted hover:text-sol-text">
          Cancel
        </button>
      )}
    </span>
  );
  return (
    <>
    <form
      className={`flex min-w-0 flex-col ${loginReplace ? "" : "gap-1.5"}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (review && ready) setReviewing(true);
        else void save();
      }}
      data-vault-value-editor={mode}
      data-private
    >
      {mode === "rotate" ? (
        // A replace takes the field's whole width, its buttons under it.
        <>
          <ValueFields kind={row.kind} draft={draft} onChange={setDraft} autoFocus={autoFocus} rows={loginReplace} keep={loginReplace} />
          {loginReplace ? <Row label="">{actions}</Row> : <div className="flex items-center">{actions}</div>}
        </>
      ) : (
        <div className="flex min-w-0 items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <ValueFields kind={row.kind} draft={draft} onChange={setDraft} autoFocus={autoFocus} />
          </div>
          {actions}
        </div>
      )}
      {error ? <div className="text-[11.5px] text-sol-red">{error}</div> : null}
    </form>
    {reviewing && review && <SwitchReview ledger={review} onClose={() => setReviewing(false)} onConfirm={() => void save()} />}
    </>
  );
}

/**
 * The other answer to a request: it closes, and the sessions that asked are
 * told no (secrets.remove). Waking a session goes through the confirm first;
 * a request no session made closes on the press. The decline names the
 * request, so a stale card or a replay after someone filled it removes nothing.
 */
export function DeclineRequest({ row, onDeclined, className }: { row: SecretMeta; onDeclined?: () => void; className: string }) {
  const { remove } = useVaultActions();
  const [reviewing, setReviewing] = useState(false);
  const decline = () => {
    setReviewing(false);
    remove(row._id, "requested");
    onDeclined?.();
  };
  return (
    <>
      <button type="button" onClick={() => (row.requested_from_conversation ? setReviewing(true) : decline())} className={className} data-vault-request-decline>
        Decline
      </button>
      {reviewing && <SwitchReview ledger={declineLedger(row)} onClose={() => setReviewing(false)} onConfirm={decline} />}
    </>
  );
}
