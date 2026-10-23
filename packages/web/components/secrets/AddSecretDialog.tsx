"use client";
// Adding to the Vault: one secret of any kind, or many keys from a pasted
// .env. The row paints at once from a metadata stub (stageSecret); the value
// goes from this dialog's state straight to secrets.create, and the stub takes
// the short_id the action answers with so the server's row supersedes it.

import { useMemo, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { envFor, envNameProblem, totpParams, type LoginPayload, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import type { VaultScope } from "../../hooks/useSyncSecrets";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { KIND, Row } from "./parts";
import { ValueFields } from "./ValueForm";
import { EMPTY_DRAFT, checkedPayload, loginEnv, nameIssue, namesIn, readEnvText, slugify, splitList, suggestName, type ValueDraft } from "./vaultModel";

/** One secret of a kind, or Import with the .env text so far ("" for an empty paste box). */
export type AddMode = { kind: SecretKind } | { import: string };

export type { VaultScope };

const KINDS: SecretKind[] = ["key", "login", "file", "signin"];
/** A name of the kind's own shape, so the empty field shows what fits. */
const NAME_EXAMPLE: Record<SecretKind, string> = { key: "stripe-test", login: "github-bot", file: "gcp-service-account", signin: "vercel" };
/** A line under a form row's field, in the field's column (Row's 6.5rem label plus its gap). */
const UNDER_FIELD = "-mt-1 pb-1 pl-[calc(6.5rem+0.75rem)] text-[11.5px]";
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
      has_otp: fields.kind === "login" ? !!(payload as LoginPayload).totp_seed : undefined,
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
  const [imported, setImported] = useState<string | null>("import" in mode ? mode.import : null);
  const [where, setWhere] = useState<"team" | "personal">(scope.team ? "team" : "personal");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        hideClose
        className="w-[34rem] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl [&>*]:min-w-0"
        data-vault-add
        // The value field takes the cursor (not the first tab stop, the kind picker), so open, paste, ⌘↵ works.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // In priority order: a selector list would match in document order, and a login's optional Site sits above Username.
          const root = e.currentTarget as HTMLElement;
          ["[name=vault-value]", "[name=vault-username]", "[name=vault-file]", "[data-vault-import-paste]", "input, textarea"].map((s) => root.querySelector<HTMLElement>(s)).find(Boolean)?.focus();
        }}
      >
        {imported !== null ? (
          <ImportPane initialText={imported} scope={scope} where={where} setWhere={setWhere} rows={rows} onClose={onClose} />
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
  onImport: (text: string) => void;
  onCreated?: (name: string) => void;
}) {
  const create = useCreate(scope);
  const [kind, setKind] = useState<SecretKind>(initial);
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [envText, setEnvText] = useState("");
  const [userVar, setUserVar] = useState("");
  const [passVar, setPassVar] = useState("");
  const [sitesText, setSitesText] = useState("");
  const [note, setNote] = useState("");
  const [issuer, setIssuer] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const kindsRef = useRef<HTMLDivElement>(null);
  const arrowed = useRef(false);
  // An arrow keeps focus in the kind group; this runs after the new fields' autoFocus would take it.
  useWatchEffect(() => {
    if (!arrowed.current) return;
    arrowed.current = false;
    kindsRef.current?.querySelector<HTMLElement>(`[data-vault-kind=${kind}]`)?.focus();
  }, [kind]);
  const sites = splitList(sitesText);
  const typedEnv = kind === "login" ? [userVar.trim() || passVar.trim()].filter(Boolean) : splitList(envText);
  // The name follows the env var, site or pasted key until the person types one.
  const name = typedName ?? (suggestName({ kind, env: typedEnv[0], site: sites[0], value: kind === "key" ? draft.value : undefined }) || slugify(issuer));
  // A login's empty slots show the pair its name implies, which is what it injects.
  const [userDefault, passDefault] = envFor({ name: name || "github", kind: "login" }).map((b) => b.var);
  const env = kind === "login" ? loginEnv(userVar, passVar, passDefault!) : typedEnv;
  const workspace = where === "team" ? scope.team?.key ?? null : scope.personal;
  const taken = useMemo(() => namesIn(rows, workspace), [rows, workspace]);
  const nameProblem = nameIssue(name, taken);
  const envProblem = env.map(envNameProblem).find(Boolean) ?? null;
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
      <header className="flex flex-col gap-3 border-b border-sol-border/60 px-5 py-3.5">
        <DialogTitle className="whitespace-nowrap text-[15px] font-semibold tracking-normal text-sol-text">Add to Vault</DialogTitle>
        <DialogDescription className="sr-only">A key, username and password, file or browser sign-in, stored encrypted for your agents.</DialogDescription>
        {/* Full width; each segment grows from its label's width, since "Username and password" needs more than a quarter. */}
        <div
          ref={kindsRef}
          className="flex whitespace-nowrap rounded-md border border-sol-border/70 p-0.5"
          role="radiogroup"
          aria-label="Kind"
          // One tab stop; the arrows move between kinds, as a radio group does.
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = KINDS[(KINDS.indexOf(kind) + step + KINDS.length) % KINDS.length]!;
            arrowed.current = true;
            setKind(next);
          }}
        >
          {KINDS.map((k) => {
            const Icon = KIND[k].icon;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                tabIndex={kind === k ? 0 : -1}
                onClick={() => setKind(k)}
                className={`inline-flex min-w-0 grow items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--sol-yellow)_55%,transparent)] ${kind === k ? "bg-sol-bg-alt text-sol-text shadow-[inset_0_0_0_1px_var(--sol-border)]" : "text-sol-text-muted hover:text-sol-text"}`}
                data-vault-kind={k}
              >
                <Icon size={13} className="shrink-0" style={{ color: kind === k ? KIND[k].tone : undefined }} />
                <span className="truncate">{KIND[k].label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-col px-5 py-3">
        {(kind === "login" || kind === "signin") && (
          <Row label="Site" align="input">
            <input value={sitesText} onChange={(e) => setSitesText(e.target.value)} placeholder={kind === "signin" ? "vercel.com" : "github.com (optional)"} spellCheck={false} className={`${fieldCls} font-mono`} autoFocus={kind === "signin"} />
          </Row>
        )}
        {/* A login's own lines (Username, Password, 2FA) are the rows, so the form keeps one label column. */}
        {kind === "login" ? (
          <>
            <ValueFields kind={kind} draft={draft} onChange={setDraft} onImport={onImport} onIssuer={setIssuer} autoFocus rows />
            {draft.totp_seed.trim() ? <AuthenticatorReadBack seed={draft.totp_seed} /> : null}
          </>
        ) : (
          <Row label={kind === "file" ? "File" : kind === "signin" ? "Save it" : "Value"} align="input">
            <ValueFields kind={kind} draft={draft} onChange={setDraft} onEnvLine={(v) => setEnvText(v)} onImport={onImport} autoFocus={kind !== "signin"} site={sites[0]} />
            {kind === "key" && (
              <button type="button" onClick={() => onImport("")} className="mt-1 text-[11.5px] text-sol-text-dim hover:text-sol-text">
                Many keys? Import a .env
              </button>
            )}
          </Row>
        )}
        {kind !== "signin" && (
          // The credentials above, the agent settings below.
          <div className="mt-2 border-t border-sol-border/40 pt-2">
            {kind === "login" ? (
              <Row label="Env vars" align="input" data-vault-login-env>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["Username var", userVar, setUserVar, userDefault],
                      ["Password var", passVar, setPassVar, passDefault],
                    ] as const
                  ).map(([label, value, set, fallback]) => (
                    <input key={label} value={value} onChange={(e) => set(e.target.value)} placeholder={fallback} spellCheck={false} aria-label={label} className={`${fieldCls} font-mono`} />
                  ))}
                </div>
                {envProblem ? <div className="mt-0.5 text-[11.5px] text-sol-red">{envProblem}</div> : null}
              </Row>
            ) : (
              <Row label="Env var" align="input">
                <input
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={kind === "file" ? "GOOGLE_APPLICATION_CREDENTIALS (optional)" : "STRIPE_SECRET_KEY (optional)"}
                  spellCheck={false}
                  className={`${fieldCls} font-mono`}
                />
                {envProblem ? <div className="mt-0.5 text-[11.5px] text-sol-red">{envProblem}</div> : null}
              </Row>
            )}
            <Row label="Name" align="input">
              <div className="flex items-center gap-2">
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setTypedName(e.target.value.toLowerCase())}
                  // A suggested name is selected whole, so typing replaces it rather than adding to it.
                  onFocus={(e) => typedName === null && e.target.select()}
                  placeholder={NAME_EXAMPLE[kind]}
                  spellCheck={false}
                  aria-required
                  className={`${fieldCls} font-mono ${(name || valueReady) && nameProblem ? "border-sol-red/70" : ""}`}
                  data-vault-name
                />
                {(name || valueReady) && nameProblem ? (
                  <span className="shrink-0 text-[11.5px] text-sol-red" data-vault-name-state>
                    {nameProblem}
                  </span>
                ) : null}
              </div>
            </Row>
            <Row label="Note" align="input">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it is for (optional)" className={fieldCls} />
            </Row>
            <Row label="Who can use it" align="input">
              <ScopePicker scope={scope} value={where} onChange={setWhere} />
            </Row>
          </div>
        )}
      </div>
      <Footer onClose={onClose} submit={kind === "signin" ? onClose : () => void submit()} label={kind === "signin" ? "Done" : "Save"} disabled={kind !== "signin" && !canPress} />
    </div>
  );
}

/** What a typed or pasted 2FA seed was read as, so a wrong paste shows before Save; under the 2FA field, in its column. */
function AuthenticatorReadBack({ seed }: { seed: string }) {
  const p = totpParams(seed);
  if (!p) return <div className={`${UNDER_FIELD} text-sol-red`}>Not a setup key or an otpauth:// link</div>;
  return (
    <div className={`${UNDER_FIELD} truncate text-sol-text-muted`} data-vault-otp-readback>
      Authenticator: <span className="text-sol-text">{[p.issuer, p.account].filter(Boolean).join(", ") || "setup key"}</span>
    </div>
  );
}

/**
 * Import .env in two steps that keep the text: paste (or type, then Review)
 * builds the list of keys, each with its name and a checkbox, plus every line
 * that is left out and why; Edit text goes back to the text as it was.
 */
function ImportPane({ initialText, scope, where, setWhere, rows, onClose }: { initialText: string; scope: VaultScope; where: "team" | "personal"; setWhere: (v: "team" | "personal") => void; rows: SecretMeta[]; onClose: () => void }) {
  const create = useCreate(scope);
  const [text, setText] = useState(initialText);
  const read = useMemo(() => readEnvText(text), [text]);
  const [reviewing, setReviewing] = useState(read.entries.length > 0);
  // What the person changed on a key (its name, unticked), kept across Edit text by the key.
  const [edits, setEdits] = useState<Record<string, { name?: string; on?: boolean }>>({});
  const workspace = where === "team" ? scope.team?.key ?? null : scope.personal;
  const taken = useMemo(() => namesIn(rows, workspace), [rows, workspace]);
  const entries = read.entries.map((e) => {
    const slug = slugify(e.key);
    return { ...e, name: edits[e.key]?.name ?? slug, on: edits[e.key]?.on ?? !taken.has(slug) };
  });
  const picked = entries.filter((e) => e.on);
  const issueOf = (e: (typeof entries)[number], i: number) => nameIssue(e.name, taken) ?? (entries.findIndex((x) => x.on && x.name === e.name) !== i ? "Twice in this list" : null);
  const blocked = picked.some((e) => issueOf(e, entries.indexOf(e)));
  const edit = (key: string, patch: { name?: string; on?: boolean }) => setEdits((m) => ({ ...m, [key]: { ...m[key], ...patch } }));
  const review = () => read.entries.length > 0 && setReviewing(true);

  const submit = async () => {
    if (!reviewing) return review();
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
        {reviewing && (
          <button type="button" onClick={() => setReviewing(false)} className="-ml-1.5 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text" data-vault-import-edit>
            <ChevronLeft size={14} /> Edit text
          </button>
        )}
        <DialogTitle className="text-[15px] font-semibold tracking-normal text-sol-text">Import .env</DialogTitle>
        <DialogDescription className="sr-only">Each key becomes its own secret, named from its env var.</DialogDescription>
        {reviewing && (
          <span className="ml-auto text-[12px] tabular-nums text-sol-text-muted" data-vault-import-count>
            {picked.length} of {entries.length}
            {read.skipped.length ? <span className="text-sol-orange"> · {read.skipped.length} skipped</span> : null}
          </span>
        )}
      </header>
      <div className="flex flex-col gap-2 px-5 py-3">
        {!reviewing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // A paste builds the list at once; typed text waits for Review.
              const el = e.currentTarget;
              const next = el.value.slice(0, el.selectionStart) + e.clipboardData.getData("text") + el.value.slice(el.selectionEnd);
              e.preventDefault();
              setText(next);
              if (readEnvText(next).entries.length) setReviewing(true);
            }}
            placeholder={"Paste a .env\nSTRIPE_SECRET_KEY=sk_test_…\nDATABASE_URL=postgres://…"}
            autoFocus
            rows={6}
            spellCheck={false}
            className={`${fieldCls} resize-y font-mono`}
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
                    onChange={() => edit(e.key, { on: !e.on })}
                    className="size-3.5 shrink-0 accent-[var(--sol-yellow)]"
                    aria-label={`Import ${e.key}`}
                  />
                  <span className={`w-[36%] min-w-0 truncate font-mono text-[12px] ${e.on ? "text-sol-text" : "text-sol-text-dim line-through"}`} title={e.key}>{e.key}</span>
                  <input
                    value={e.name}
                    onChange={(ev) => edit(e.key, { name: ev.target.value.toLowerCase() })}
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
            {read.skipped.map((k) => (
              <li key={`skip-${k.line}`} className="flex items-center gap-2.5 border-b border-sol-border/40 bg-sol-bg-alt/40 px-2.5 py-1.5 text-[12px] last:border-b-0" data-vault-import-skipped={k.line}>
                <span className="w-3.5 shrink-0" />
                <span className="w-[36%] min-w-0 truncate font-mono text-sol-text-dim" title={k.key}>{k.key}</span>
                <span className="min-w-0 flex-1 truncate text-sol-orange">{k.why}</span>
                <span className="w-[6rem] shrink-0 text-right text-[11px] tabular-nums text-sol-text-dim">line {k.line}</span>
              </li>
            ))}
          </ul>
        )}
        <Row label="Who can use it">
          <ScopePicker scope={scope} value={where} onChange={setWhere} />
        </Row>
      </div>
      {reviewing ? (
        <Footer onClose={onClose} submit={() => void submit()} label={picked.length ? `Import ${picked.length}` : "Import"} disabled={!picked.length || blocked} />
      ) : (
        <Footer onClose={onClose} submit={review} label={read.entries.length ? `Review ${read.entries.length}` : "Review"} disabled={!read.entries.length} />
      )}
    </div>
  );
}

