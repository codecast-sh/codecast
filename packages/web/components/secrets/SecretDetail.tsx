"use client";
// One secret, opened from the Vault list: its fields masked with reveal and
// copy, a login's live 2FA code, a sign-in's health, its env vars, sites and
// note edited in place, who used it from which session, and Rotate / Delete.

import { useMemo, useState, type ReactNode } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { X } from "lucide-react";
import { envFor, envNameProblem, type FilePayload, type KeyPayload, type LoginPayload, type SecretMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { formatRelativeTime, formatFullTimestamp } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyCap";
import { KIND, KindGlyph, MaskedField, Row, TotpCode, useReveal } from "./parts";
import { ValueEditor } from "./ValueForm";
import { nameIssue, namesIn, splitList } from "./vaultModel";

const isStub = (row: SecretMeta) => !row.short_id;

/** Delete, as the confirm shows it: who loses the secret, and what goes with it. */
export function deleteLedger(row: SecretMeta, team: { name: string; people: number } | null): SwitchLedger {
  const injects = envFor(row).map((b) => b.var);
  return {
    name: `Delete ${row.name}`,
    subject: team ? `Team · ${team.name}` : "Only me",
    shift: null,
    figures: [
      team ? { value: String(team.people), label: team.people === 1 ? "person and their agents lose it" : "people and their agents lose it", tone: "warn" } : { value: "1", label: "you and your agents lose it", tone: "warn" },
      { value: String(row.use_count ?? 0), label: "agent reads so far" },
    ],
    rows: [
      { k: "Who loses it", v: team ? `Every agent in ${team.name}` : "Your agents", tone: "warn" },
      ...(injects.length ? [{ k: "Env vars", v: injects.join(" "), tone: "warn" as const }] : []),
      ...(row.sites?.length ? [{ k: "Sites", v: row.sites.join(", ") }] : []),
      { k: "Activity", v: "Kept, under its name" },
      { k: "To undo", v: "Add it again, with the value", tone: "warn" },
    ],
    confirm: `Delete ${row.name}`,
    keep: "Keep it",
  };
}

/** A list of short strings edited in place: chips with ×, and a field that adds on Enter, space or comma. */
function ChipEditor({ items, implied, onChange, problemOf, placeholder, mono = true }: { items: string[]; implied?: string[]; onChange: (next: string[]) => void; problemOf?: (s: string) => string | null; placeholder: string; mono?: boolean }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const next = splitList(text).filter((x) => !items.includes(x));
    const bad = next.map((x) => problemOf?.(x)).find(Boolean);
    if (bad) return setProblem(bad);
    if (next.length) onChange([...items, ...next]);
    setText("");
    setProblem(null);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {items.map((x) => (
          <span key={x} className={`inline-flex items-center gap-1 rounded border border-sol-border bg-sol-bg-alt/60 py-[1px] pl-1.5 pr-0.5 text-[11.5px] text-sol-text ${mono ? "font-mono" : ""}`}>
            {x}
            <button type="button" onClick={() => onChange(items.filter((y) => y !== x))} aria-label={`Remove ${x}`} className="rounded p-0.5 text-sol-text-dim hover:text-sol-red">
              <X size={11} />
            </button>
          </span>
        ))}
        {!items.length &&
          implied?.map((x) => (
            <span key={x} className="rounded border border-dashed border-sol-border px-1.5 py-[1px] font-mono text-[11.5px] text-sol-text-dim" title="Used when none is set">
              {x}
            </span>
          ))}
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || (e.key === " " && text.trim())) {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && items.length) onChange(items.slice(0, -1));
          }}
          onBlur={() => text.trim() && add()}
          placeholder={placeholder}
          spellCheck={false}
          className={`min-w-[7rem] flex-1 bg-transparent px-1 py-0.5 text-[12px] text-sol-text outline-none placeholder:text-sol-text-dim ${mono ? "font-mono" : ""}`}
        />
      </div>
      {problem ? <div className="mt-0.5 text-[11.5px] text-sol-red">{problem}</div> : null}
    </div>
  );
}

/** Text saved when focus leaves or on ⌘↵, reverted on Esc. */
function InlineText({ value, onSave, placeholder, problemOf, className, multiline, label }: { value: string; onSave: (v: string) => void; placeholder: string; problemOf?: (v: string) => string | null; className: string; multiline?: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const problem = draft !== null ? problemOf?.(draft) ?? null : null;
  const commit = () => {
    if (draft !== null && draft !== value && !problem) onSave(draft);
    setDraft(null);
  };
  const props = {
    value: shown,
    "aria-label": label,
    placeholder,
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDraft(null);
        (e.target as HTMLElement).blur();
      } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
    },
    className: `w-full rounded border bg-transparent outline-none placeholder:text-sol-text-dim focus:bg-sol-bg ${problem ? "border-sol-red/70" : "border-transparent hover:border-sol-border focus:border-sol-yellow"} ${className}`,
  };
  return (
    <div className="min-w-0">
      {multiline ? <textarea rows={Math.min(6, Math.max(2, shown.split("\n").length))} {...props} /> : <input {...props} />}
      {problem ? <div className="text-[11.5px] text-sol-red">{problem}</div> : null}
    </div>
  );
}

const EVENT_VERB: Record<string, string> = {
  created: "added it",
  updated: "edited it",
  rotated: "replaced the value",
  revealed: "revealed it",
  read: "read it",
  injected: "injected it",
  signed_in: "signed in with it",
  refreshed: "refreshed the sign-in",
  requested: "asked for it",
  fulfilled: "filled it",
  deleted: "deleted it",
};
const EVENT_TONE: Record<string, string> = { read: "var(--sol-blue)", injected: "var(--sol-blue)", signed_in: "var(--sol-cyan)", revealed: "var(--sol-orange)", rotated: "var(--sol-yellow)", requested: "var(--sol-magenta)", fulfilled: "var(--sol-green)", created: "var(--sol-green)" };

function Activity({ row }: { row: SecretMeta }) {
  const { data } = useQueryNoThrow(api.secrets.events, isStub(row) ? "skip" : { ref: row._id });
  const events = Array.isArray(data) ? data : [];
  return (
    <section className="border-t border-sol-border/50 px-4 pb-4 pt-3" data-vault-activity>
      <h3 className="mb-1.5 text-[12px] font-medium text-sol-text-muted">Activity</h3>
      {!events.length ? (
        <div className="text-[12px] text-sol-text-dim">{data === undefined && !isStub(row) ? "Loading" : "Nothing yet"}</div>
      ) : (
        <ol className="flex flex-col">
          {events.map((e: any) => (
            <li key={e._id} className="flex items-center gap-2 py-1 text-[12px]" data-vault-event={e.kind}>
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: EVENT_TONE[e.kind] ?? "var(--sol-text-dim)" }} />
              <span className="shrink-0 text-sol-text">{e.actor_name ?? "Someone"}</span>
              <span className="shrink-0 text-sol-text-muted">
                {EVENT_VERB[e.kind] ?? e.kind}
                {e.purpose && e.kind === "read" ? ` · ${e.purpose}` : ""}
              </span>
              {e.conversation_id ? (
                <span className="min-w-0 truncate">
                  <EntityIdPill id={e.conversation_id} type="session" label={e.session_title ?? e.session_short_id} compact />
                </span>
              ) : null}
              <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim" title={formatFullTimestamp(e.at)}>{formatRelativeTime(e.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The value fields for a ready secret, per kind. */
function Fields({ row }: { row: SecretMeta }) {
  const { payload, load, error, loading } = useReveal(row._id);
  const field = <T,>(pick: (p: T) => string | undefined) => async () => {
    const p = await load();
    return p ? pick(p as T) : undefined;
  };
  const p = payload as any;
  let body: ReactNode;
  if (row.kind === "key") {
    body = <MaskedField label="Value" value={p?.value} load={field<KeyPayload>((x) => x.value)} hint={row.fingerprint} />;
  } else if (row.kind === "login") {
    const login = p as LoginPayload | null;
    body = (
      <>
        <MaskedField label="Username" value={login ? login.username ?? "" : undefined} load={field<LoginPayload>((x) => x.username)} plain />
        <MaskedField label="Password" value={login?.password} load={field<LoginPayload>((x) => x.password)} />
        <Row label="2FA code">
          {login ? (
            login.totp_seed ? <TotpCode seed={login.totp_seed} /> : <span className="text-[12px] text-sol-text-dim">No 2FA seed</span>
          ) : (
            <button type="button" onClick={() => void load()} disabled={loading} className="rounded-md border border-sol-border px-2 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text" data-vault-show-code>
              {loading ? "Loading" : "Show code"}
            </button>
          )}
        </Row>
      </>
    );
  } else if (row.kind === "file") {
    const file = p as FilePayload | null;
    body = <MaskedField label={file?.filename ?? "Content"} value={file?.content} load={field<FilePayload>((x) => x.content)} multiline />;
  } else {
    const s = p as SigninPayload | null;
    const exp = row.signin_expires_at;
    const expired = exp !== undefined && exp < Date.now();
    body = (
      <>
        <Row label="Expires">
          <span className="text-[12.5px]" style={{ color: exp === undefined ? "var(--sol-text-muted)" : expired ? "var(--sol-red)" : exp - Date.now() < 3 * 86_400_000 ? "var(--sol-orange)" : "var(--sol-text)" }} title={exp ? formatFullTimestamp(exp) : undefined}>
            {exp === undefined ? "When the browser closes" : expired ? `Expired ${formatRelativeTime(exp)}` : formatFullTimestamp(exp)}
          </span>
        </Row>
        <Row label="Captured">
          {s ? (
            <span className="text-[12.5px] text-sol-text">
              {s.captured_from === "chrome" ? "From Chrome" : "From the agent browser"}
              {s.account_hint ? ` · ${s.account_hint}` : ""}
              <span className="text-sol-text-dim"> · {s.cookies.length} cookies</span>
            </span>
          ) : (
            <button type="button" onClick={() => void load()} disabled={loading} className="rounded-md border border-sol-border px-2 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text">
              {loading ? "Loading" : "Show"}
            </button>
          )}
        </Row>
      </>
    );
  }
  return (
    <>
      {body}
      {error ? <div className="py-1 text-[11.5px] text-sol-red">{error}</div> : null}
    </>
  );
}

export function SecretDetail({ row, rows, team, onClose }: { row: SecretMeta; rows: SecretMeta[]; team: { id: string; name: string } | null; onClose: () => void }) {
  const updateSecretMeta = useInboxStore((s) => s.updateSecretMeta);
  const removeSecret = useInboxStore((s) => s.removeSecret);
  const people = useInboxStore((s) => peopleOf(s.teamMembers).length);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isTeam = row.workspace.startsWith("team:");
  const scopeLabel = isTeam ? `Team · ${team && row.team_id === team.id ? team.name : "another team"}` : "Only me";
  const taken = useMemo(() => namesIn(rows, row.workspace, row._id), [rows, row.workspace, row._id]);
  const edit = (fields: Parameters<typeof updateSecretMeta>[1]) => !isStub(row) && updateSecretMeta(row._id, fields);
  const implied = envFor({ ...row, env: [] }).map((b) => b.var);
  const k = KIND[row.kind];

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-sol-border/50 bg-sol-bg" data-vault-detail={row.short_id || row._id}>
      <header className="flex items-start gap-3 border-b border-sol-border/50 px-4 pb-3 pt-3.5">
        <KindGlyph kind={row.kind} size={16} />
        <div className="min-w-0 flex-1">
          <InlineText
            value={row.name}
            label="Name"
            placeholder="name"
            problemOf={(v) => (v === row.name ? null : nameIssue(v.trim(), taken))}
            onSave={(name) => edit({ name: name.trim() })}
            className="-ml-1 px-1 font-mono text-[15px] font-semibold text-sol-text"
          />
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-sol-text-dim">
            <span className="font-mono">{row.short_id || "saving"}</span>
            <span>·</span>
            <span style={{ color: k.tone }}>{k.label}</span>
            <span>·</span>
            <span>{scopeLabel}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex items-center gap-1 rounded p-1 text-sol-text-dim hover:text-sol-text">
          <KeyCap size="xs">esc</KeyCap>
          <X size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="px-4 py-2">
          {row.status === "requested" ? (
            <div className="py-1">
              <div className="mb-1.5 text-[12px] text-sol-magenta">Requested{row.requested_by_name ? ` by ${row.requested_by_name}` : ""}{row.request_why ? `: ${row.request_why}` : ""}</div>
              <ValueEditor row={row} mode="fulfill" autoFocus />
            </div>
          ) : rotating ? (
            <div className="py-1">
              <div className="mb-1.5 text-[12px] text-sol-text-muted">New value. Agents read it from their next use.</div>
              <ValueEditor row={row} mode="rotate" autoFocus onDone={() => setRotating(false)} onCancel={() => setRotating(false)} />
            </div>
          ) : isStub(row) ? (
            <div className="py-1.5 text-[12px] text-sol-text-dim">Saving…</div>
          ) : (
            <Fields row={row} />
          )}
        </section>

        <section className="border-t border-sol-border/50 px-4 py-2">
          {row.kind !== "signin" && (
            <Row label="Env vars">
              <ChipEditor items={row.env ?? []} implied={implied} onChange={(env) => edit({ env })} problemOf={(x) => (envNameProblem(x) ? "Letters, digits and _, like STRIPE_SECRET_KEY" : null)} placeholder={row.env?.length ? "Add" : "Set your own"} />
            </Row>
          )}
          {(row.kind === "login" || row.kind === "signin" || !!row.sites?.length) && (
            <Row label="Sites">
              <ChipEditor items={row.sites ?? []} onChange={(sites) => edit({ sites })} problemOf={(x) => (/\s/.test(x) ? "One hostname each" : null)} placeholder="Add a site" />
            </Row>
          )}
          <Row label="Note">
            <InlineText value={row.note ?? ""} label="Note" multiline placeholder="What it is for" onSave={(note) => edit({ note })} className="-ml-1 resize-none px-1 py-0.5 text-[12.5px] text-sol-text" />
          </Row>
        </section>

        <section className="border-t border-sol-border/50 px-4 py-2 text-[12.5px]">
          <Row label="Last used">
            {row.last_used_at ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-sol-text" title={formatFullTimestamp(row.last_used_at)}>{formatRelativeTime(row.last_used_at)}</span>
                {row.last_used_by_conversation ? (
                  <span className="min-w-0 truncate">
                    <EntityIdPill id={row.last_used_by_conversation} type="session" compact />
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-sol-text-dim">Never</span>
            )}
          </Row>
          <Row label="Agent reads">
            <span className="tabular-nums text-sol-text">{row.use_count ?? 0}</span>
          </Row>
          <Row label="Added">
            <span className="text-sol-text-muted">
              {row.created_by_name ? `${row.created_by_name}, ` : ""}
              {formatRelativeTime(row.created_at)}
              {row.rotated_at ? ` · replaced ${formatRelativeTime(row.rotated_at)}` : ""}
            </span>
          </Row>
        </section>

        <Activity row={row} />
      </div>

      <footer className="flex items-center gap-2 border-t border-sol-border/50 px-4 py-2.5">
        {row.status === "ready" && !rotating && !isStub(row) && (
          <button type="button" onClick={() => setRotating(true)} className="h-7 rounded-md border border-sol-border px-2.5 text-[12px] text-sol-text-muted hover:text-sol-text" data-vault-rotate>
            Rotate
          </button>
        )}
        <button
          type="button"
          // A request holds no value, so dismissing it takes nothing from anyone; deleting a value does.
          onClick={() => (row.status === "requested" ? (removeSecret(row._id), onClose()) : setDeleting(true))}
          disabled={isStub(row)}
          className="ml-auto h-7 rounded-md px-2.5 text-[12px] text-sol-text-dim hover:bg-sol-red/10 hover:text-sol-red disabled:opacity-40"
          data-vault-delete
        >
          {row.status === "requested" ? "Dismiss request" : "Delete"}
        </button>
      </footer>
      {deleting && (
        <SwitchReview
          ledger={deleteLedger(row, isTeam ? { name: team && row.team_id === team.id ? team.name : "that team", people } : null)}
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            removeSecret(row._id);
            onClose();
          }}
        />
      )}
    </aside>
  );
}
