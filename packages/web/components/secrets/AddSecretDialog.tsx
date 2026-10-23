"use client";
// Adding to the Vault: one secret of any kind, or many keys from a pasted
// .env. The row paints at once from a metadata stub (stageSecret); the value
// goes from this dialog's state straight to secrets.create, and the stub takes
// the short_id the action answers with so the server's row supersedes it.

import { useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { envNameProblem, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";
import { useInboxStore } from "../../store/inboxStore";
import { KIND, Row } from "./parts";
import { ValueFields } from "./ValueForm";
import { EMPTY_DRAFT, checkedPayload, nameIssue, namesIn, parseEnvText, slugify, splitList, suggestName, type EnvEntry, type ValueDraft } from "./vaultModel";

export type AddMode = { kind: SecretKind } | { import: EnvEntry[] };

export type VaultScope = { team: { key: string; id: string; name: string } | null; personal: string | null };

const KINDS: SecretKind[] = ["key", "login", "file", "signin"];
const fieldCls =
  "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";

/** Paint the row, create it, and settle the stub on the answer. Resolves with the error sentence, or null. */
export function useCreate(scope: VaultScope) {
  const create = useAction(api.secrets.create);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  return async (where: "team" | "personal", fields: { name: string; kind: SecretKind; payload: unknown; env?: string[]; sites?: string[]; note?: string }) => {
    const { stageSecret, settleSecretStub } = useInboxStore.getState();
    const now = Date.now();
    const stubId = `sec_stub_${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const team = where === "team" ? scope.team : null;
    const { payload, ...meta } = fields;
    stageSecret({
      _id: stubId,
      short_id: undefined as unknown as string,
      status: "ready",
      workspace: team ? team.key : scope.personal!,
      team_id: team?.id,
      created_by: me,
      created_at: now,
      updated_at: now,
      ...meta,
      env: meta.env?.length ? meta.env : undefined,
      sites: meta.sites?.length ? meta.sites : undefined,
      note: meta.note?.trim() || undefined,
    } as SecretMeta);
    const res: any = await create({ ...fields, ...(team ? { team_id: team.id as any } : { personal: true }) }).catch((err: Error) => ({ error: err.message }));
    settleSecretStub(stubId, res?.error ? null : res.short_id);
    return res?.error ? (res.error as string) : null;
  };
}

/** Team <name> or Only me, both always named, so where a secret lands is never a guess. */
export function ScopePicker({ scope, value, onChange }: { scope: VaultScope; value: "team" | "personal"; onChange: (v: "team" | "personal") => void }) {
  const opts = [...(scope.team ? [{ id: "team" as const, label: scope.team.name }] : []), { id: "personal" as const, label: "Only me" }];
  return (
    <div className="inline-flex rounded-md border border-sol-border/70 p-0.5 text-[12px]" role="radiogroup" aria-label="Who can use it">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`max-w-[14rem] truncate rounded px-2.5 py-1 transition-colors ${value === o.id ? "bg-sol-bg-alt text-sol-text shadow-[inset_0_0_0_1px_var(--sol-border)]" : "text-sol-text-muted hover:text-sol-text"}`}
          data-vault-scope={o.id}
        >
          {o.id === "team" ? `Team · ${o.label}` : o.label}
        </button>
      ))}
    </div>
  );
}

export function AddSecretDialog({ mode, onClose, scope, rows, onCreated }: { mode: AddMode; onClose: () => void; scope: VaultScope; rows: SecretMeta[]; onCreated?: (name: string) => void }) {
  const [imported, setImported] = useState<EnvEntry[] | null>("import" in mode ? mode.import : null);
  const [where, setWhere] = useState<"team" | "personal">(scope.team ? "team" : "personal");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        hideClose
        className="w-[34rem] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl [&>*]:min-w-0"
        data-vault-add
      >
        {imported ? (
          <ImportPane entries={imported} scope={scope} where={where} setWhere={setWhere} rows={rows} onClose={onClose} />
        ) : (
          <SinglePane initial={"kind" in mode ? mode.kind : "key"} scope={scope} where={where} setWhere={setWhere} rows={rows} onClose={onClose} onImport={setImported} onCreated={onCreated} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Footer({ onClose, submit, label, disabled }: { onClose: () => void; submit: () => void; label: string; disabled: boolean }) {
  return (
    <footer className="flex items-center justify-between gap-2 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3">
      <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-2 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text">
        Cancel <KeyCap size="xs">esc</KeyCap>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="inline-flex h-8 items-center gap-2 rounded-md bg-sol-yellow px-3.5 text-[12.5px] font-semibold text-sol-bg hover:brightness-110 disabled:cursor-not-allowed disabled:bg-sol-border disabled:text-sol-text-dim"
        data-vault-add-submit
      >
        {label}
        {!disabled && (
          <span className="inline-flex items-center gap-0.5">
            <KeyCap size="xs" tone="onAccent">{isMac ? "⌘" : "ctrl"}</KeyCap>
            <KeyCap size="xs" tone="onAccent">↵</KeyCap>
          </span>
        )}
      </button>
    </footer>
  );
}

function SinglePane({
  initial,
  scope,
  where,
  setWhere,
  rows,
  onClose,
  onImport,
  onCreated,
}: {
  initial: SecretKind;
  scope: VaultScope;
  where: "team" | "personal";
  setWhere: (v: "team" | "personal") => void;
  rows: SecretMeta[];
  onClose: () => void;
  onImport: (entries: EnvEntry[]) => void;
  onCreated?: (name: string) => void;
}) {
  const create = useCreate(scope);
  const [kind, setKind] = useState<SecretKind>(initial);
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [envText, setEnvText] = useState("");
  const [sitesText, setSitesText] = useState("");
  const [note, setNote] = useState("");
  const [issuer, setIssuer] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const env = splitList(envText);
  const sites = splitList(sitesText);
  // The name follows the env var, site or pasted key until the person types one.
  const name = typedName ?? (suggestName({ kind, env: env[0], site: sites[0], value: kind === "key" ? draft.value : undefined }) || slugify(issuer));
  const workspace = where === "team" ? scope.team?.key ?? null : scope.personal;
  const taken = useMemo(() => namesIn(rows, workspace), [rows, workspace]);
  const nameProblem = nameIssue(name, taken);
  const envProblem = env.map(envNameProblem).find(Boolean) ? "Letters, digits and _, like STRIPE_SECRET_KEY" : null;
  const checked = checkedPayload(kind, draft);
  const valueReady = "payload" in checked;
  const canSave = valueReady && !nameProblem && !envProblem && kind !== "signin";
  // Save stays pressable while only the name is missing: the press says so by taking the person to it.
  const canPress = valueReady && !envProblem && kind !== "signin";

  const submit = async () => {
    if (canPress && nameProblem) return nameRef.current?.focus();
    if (!canSave) return;
    onCreated?.(name);
    onClose();
    const err = await create(where, { name, kind, payload: checked.payload, env, sites, note });
    if (err) toast.error(`${name} was not saved: ${err}`);
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <header className="flex items-center gap-3 border-b border-sol-border/60 px-5 py-3.5">
        <DialogTitle className="text-[15px] font-semibold tracking-normal text-sol-text">Add to Vault</DialogTitle>
        <DialogDescription className="sr-only">A key, login, file or sign-in, stored encrypted for your agents.</DialogDescription>
        <div className="ml-auto inline-flex rounded-md border border-sol-border/70 p-0.5" role="radiogroup" aria-label="Kind">
          {KINDS.map((k) => {
            const Icon = KIND[k].icon;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors ${kind === k ? "bg-sol-bg-alt text-sol-text shadow-[inset_0_0_0_1px_var(--sol-border)]" : "text-sol-text-muted hover:text-sol-text"}`}
                data-vault-kind={k}
              >
                <Icon size={13} style={{ color: kind === k ? KIND[k].tone : undefined }} />
                {KIND[k].label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-col px-5 py-3">
        {(kind === "login" || kind === "signin") && (
          <Row label="Site">
            <input value={sitesText} onChange={(e) => setSitesText(e.target.value)} placeholder={kind === "signin" ? "vercel.com" : "github.com (optional)"} spellCheck={false} className={`${fieldCls} font-mono`} autoFocus={kind === "signin"} />
          </Row>
        )}
        <Row label={kind === "login" ? "Sign in as" : kind === "file" ? "File" : kind === "signin" ? "Save it" : "Value"}>
          <ValueFields kind={kind} draft={draft} onChange={setDraft} onEnvLine={(v) => setEnvText(v)} onImport={onImport} onIssuer={setIssuer} autoFocus={kind !== "signin"} site={sites[0]} />
          {kind === "key" && (
            <button type="button" onClick={() => onImport([])} className="mt-1 text-[11.5px] text-sol-text-dim hover:text-sol-text">
              Many keys? Import a .env
            </button>
          )}
        </Row>
        {kind !== "signin" && (
          <>
            <Row label="Env var">
              <input
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={kind === "login" ? "GITHUB_USER GITHUB_PASSWORD (optional)" : kind === "file" ? "GOOGLE_APPLICATION_CREDENTIALS (optional)" : "STRIPE_SECRET_KEY (optional)"}
                spellCheck={false}
                className={`${fieldCls} font-mono`}
              />
              {envProblem ? <div className="mt-0.5 text-[11.5px] text-sol-red">{envProblem}</div> : null}
            </Row>
            <Row label="Name">
              <div className="flex items-center gap-2">
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setTypedName(e.target.value.toLowerCase())}
                  placeholder="stripe-test"
                  spellCheck={false}
                  aria-required
                  className={`${fieldCls} font-mono ${(name || valueReady) && nameProblem ? "border-sol-red/70" : ""}`}
                  data-vault-name
                />
                <span className={`shrink-0 text-[11.5px] ${nameProblem ? "text-sol-red" : "text-sol-green"}`} data-vault-name-state>
                  {name || valueReady ? nameProblem ?? "Free" : null}
                </span>
              </div>
            </Row>
            <Row label="Note">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for (optional)" className={fieldCls} />
            </Row>
            <Row label="Who can use it">
              <ScopePicker scope={scope} value={where} onChange={setWhere} />
            </Row>
          </>
        )}
      </div>
      <Footer onClose={onClose} submit={kind === "signin" ? onClose : () => void submit()} label={kind === "signin" ? "Done" : "Save"} disabled={kind !== "signin" && !canPress} />
    </div>
  );
}

function ImportPane({ entries: initial, scope, where, setWhere, rows, onClose }: { entries: EnvEntry[]; scope: VaultScope; where: "team" | "personal"; setWhere: (v: "team" | "personal") => void; rows: SecretMeta[]; onClose: () => void }) {
  const create = useCreate(scope);
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<(EnvEntry & { name: string; on: boolean })[]>(() => initial.map((e) => ({ ...e, name: slugify(e.key), on: true })));
  const workspace = where === "team" ? scope.team?.key ?? null : scope.personal;
  const taken = useMemo(() => namesIn(rows, workspace), [rows, workspace]);
  const picked = entries.filter((e) => e.on);
  const issueOf = (e: (typeof entries)[number], i: number) => nameIssue(e.name, taken) ?? (entries.findIndex((x) => x.on && x.name === e.name) !== i ? "Twice in this list" : null);
  const blocked = picked.some((e) => issueOf(e, entries.indexOf(e)));

  const readText = (t: string) => {
    const parsed = parseEnvText(t);
    if (parsed.length) {
      setEntries(parsed.map((e) => ({ ...e, name: slugify(e.key), on: !taken.has(slugify(e.key)) })));
      setText("");
    } else setText(t);
  };

  const submit = async () => {
    if (!picked.length || blocked) return;
    onClose();
    // Each key paints its row now; the creates run one after another so a refusal names the key it belongs to.
    const failed: string[] = [];
    for (const e of picked) {
      const err = await create(where, { name: e.name, kind: "key", payload: { value: e.value }, env: [e.key] });
      if (err) failed.push(`${e.name}: ${err}`);
    }
    if (failed.length) toast.error(`${failed.length} not saved`, { description: failed.join("\n") });
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <header className="flex items-center gap-3 border-b border-sol-border/60 px-5 py-3.5">
        <DialogTitle className="text-[15px] font-semibold tracking-normal text-sol-text">Import .env</DialogTitle>
        <DialogDescription className="sr-only">Each key becomes its own secret, named from its env var.</DialogDescription>
        {entries.length > 0 && <span className="ml-auto text-[12px] tabular-nums text-sol-text-muted">{picked.length} of {entries.length}</span>}
      </header>
      <div className="flex flex-col gap-2 px-5 py-3">
        {entries.length === 0 ? (
          <textarea
            value={text}
            onChange={(e) => readText(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              readText(e.clipboardData.getData("text"));
            }}
            placeholder={"Paste a .env\nSTRIPE_SECRET_KEY=sk_test_…\nDATABASE_URL=postgres://…"}
            autoFocus
            rows={6}
            spellCheck={false}
            className={`${fieldCls} resize-y font-mono text-transparent [text-shadow:0_0_6px_var(--sol-text-muted)] placeholder:[text-shadow:none]`}
            data-vault-import-paste
          />
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto rounded-md border border-sol-border/60" data-vault-import-list>
            {entries.map((e, i) => {
              const issue = e.on ? issueOf(e, i) : null;
              return (
                <li key={e.key} className="flex items-center gap-2.5 border-b border-sol-border/40 px-2.5 py-1.5 last:border-b-0">
                  <input
                    type="checkbox"
                    checked={e.on}
                    onChange={() => setEntries((xs) => xs.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}
                    className="size-3.5 shrink-0 accent-[var(--sol-yellow)]"
                    aria-label={`Import ${e.key}`}
                  />
                  <span className={`w-[36%] min-w-0 truncate font-mono text-[12px] ${e.on ? "text-sol-text" : "text-sol-text-dim line-through"}`} title={e.key}>{e.key}</span>
                  <input
                    value={e.name}
                    onChange={(ev) => setEntries((xs) => xs.map((x, j) => (j === i ? { ...x, name: ev.target.value.toLowerCase() } : x)))}
                    disabled={!e.on}
                    spellCheck={false}
                    className={`min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono text-[12px] text-sol-text-muted outline-none focus:border-sol-yellow disabled:opacity-40 ${issue ? "border-sol-red/70" : "border-transparent hover:border-sol-border"}`}
                    aria-label={`Name for ${e.key}`}
                  />
                  <span className="w-[6rem] shrink-0 truncate text-right text-[11px]" style={{ color: issue ? "var(--sol-red)" : "var(--sol-text-dim)" }}>
                    {issue ?? `${e.value.length} chars`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Row label="Who can use it">
          <ScopePicker scope={scope} value={where} onChange={setWhere} />
        </Row>
      </div>
      <Footer onClose={onClose} submit={() => void submit()} label={picked.length ? `Import ${picked.length}` : "Import"} disabled={!picked.length || blocked} />
    </div>
  );
}

