"use client";
// One secret, opened from the Vault list: its fields masked with reveal and
// copy, a login's live 2FA code, a sign-in's health, its env vars, sites and
// note edited in place, Ask first, previous values with Restore, who used it
// from which session, and Rotate / Delete.

import { useMemo, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { X } from "lucide-react";
import { envFor, envNameProblem, type FilePayload, type KeyPayload, type LoginPayload, type SecretMeta, type SecretVersionMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatRelativeTime, formatFullTimestamp } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyCap";
import { Switch } from "../ui/switch";
import { KIND, KindGlyph, MaskedField, Row, TotpCode, useReveal } from "./parts";
import { ValueEditor } from "./ValueForm";
import { EVENT_TONE, EVENT_VERB, HEALTH, formatIn, nameIssue, namesIn, secretHealth, splitList } from "./vaultModel";

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

/** Turning Ask first off, as the confirm shows it: which agents then read the secret without a person saying yes. */
export function askFirstOffLedger(row: SecretMeta, team: { name: string; people: number } | null): SwitchLedger {
  return {
    name: "Turn off Ask first",
    subject: `${row.name} · ${team ? `Team · ${team.name}` : "Only me"}`,
    shift: ["On", "Off"],
    figures: [
      team ? { value: String(team.people), label: team.people === 1 ? "person's agents read it unasked" : "people's agents read it unasked", tone: "warn" } : { value: "1", label: "your agents read it unasked", tone: "warn" },
      { value: String(row.use_count ?? 0), label: "agent reads so far" },
    ],
    rows: [
      { k: "Who reads it", v: team ? `Every agent in ${team.name}` : "Your agents", tone: "warn" },
      { k: "Approval", v: "None, from the next read", tone: "warn" },
      { k: "Activity", v: "Every read still logged" },
      { k: "To undo", v: "Turn Ask first on" },
    ],
    confirm: "Turn off Ask first",
    keep: "Keep it on",
  };
}

/** Restore, as the confirm shows it: the value coming back, and where the current one goes. */
export function restoreLedger(row: SecretMeta, version: SecretVersionMeta, team: { name: string } | null): SwitchLedger {
  return {
    name: `Restore ${row.name}`,
    subject: team ? `Team · ${team.name}` : "Only me",
    shift: null,
    figures: [
      { value: formatRelativeTime(version.rotated_at), label: "replaced" },
      ...(version.fingerprint ? [{ value: version.fingerprint, label: "value coming back" }] : []),
    ],
    rows: [
      ...(version.rotated_by_name ? [{ k: "Replaced by", v: version.rotated_by_name }] : []),
      { k: "Agents", v: "Read it from their next use", tone: "warn" as const },
      { k: "Current value", v: "Kept 7 days" },
      { k: "To undo", v: "Restore the current value" },
    ],
    confirm: "Restore",
    keep: "Keep current",
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
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: EVENT_TONE[e.kind] ? `var(--sol-${EVENT_TONE[e.kind]})` : "var(--sol-text-dim)" }} />
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
              {e.kind === "approval_requested" && e.decision_short_id ? (
                <span className="shrink-0">
                  <EntityIdPill id={e.decision_short_id} type="decision" compact />
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

/** Values a rotate replaced, kept 7 days: when, by whom, which (fingerprint), how long left, and Restore. */
function Versions({ row, team }: { row: SecretMeta; team: { name: string } | null }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<SecretVersionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = useAction(api.secrets.restore);
  const now = useCoarseNow(60_000);
  const { data } = useQueryNoThrow(api.secrets.versions, open ? { ref: row._id } : "skip");
  const versions = Array.isArray(data) ? (data as SecretVersionMeta[]) : [];
  const count = row.version_count ?? 0;
  return (
    <>
      <Row label="Previous values">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-sol-border px-2 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text"
          data-vault-versions
        >
          <span className="tabular-nums text-sol-text">{count}</span>
          {open ? "Hide" : "Show"}
        </button>
      </Row>
      {open && (
        <ol className="mb-1 ml-[7.25rem] flex flex-col" data-vault-version-list>
          {data === undefined ? (
            <li className="py-1 text-[12px] text-sol-text-dim">Loading</li>
          ) : !versions.length ? (
            <li className="py-1 text-[12px] text-sol-text-dim">None left</li>
          ) : (
            versions.map((v) => (
              <li key={v._id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto_auto] items-center gap-2 py-1 text-[12px]" data-vault-version={v._id}>
                <span className="tabular-nums text-sol-text" title={formatFullTimestamp(v.rotated_at)}>{formatRelativeTime(v.rotated_at, now)}</span>
                <span className="min-w-0 truncate text-sol-text-muted">
                  {v.rotated_by_name ?? "Someone"}
                  {v.fingerprint ? <span className="ml-1.5 font-mono text-sol-text-dim">{v.fingerprint}</span> : null}
                </span>
                <span className="tabular-nums text-sol-text-dim" title={`Gone ${formatFullTimestamp(v.expires_at)}`}>gone {formatIn(v.expires_at, now)}</span>
                <button type="button" onClick={() => (setError(null), setRestoring(v))} className="rounded px-1.5 py-0.5 text-[12px] text-sol-blue hover:bg-sol-blue/10" data-vault-restore>
                  Restore
                </button>
              </li>
            ))
          )}
          {error ? <li className="py-1 text-[11.5px] text-sol-red">{error}</li> : null}
        </ol>
      )}
      {restoring && (
        <SwitchReview
          ledger={restoreLedger(row, restoring, team)}
          onClose={() => setRestoring(null)}
          onConfirm={() => {
            const version = restoring._id;
            setRestoring(null);
            restore({ ref: row._id, version })
              .then((res: any) => setError(res?.error ?? null))
              .catch((err: Error) => setError(err.message));
          }}
        />
      )}
    </>
  );
}

/** Ask first: on is one press; off removes a guard, so it goes through the confirm. */
function AskFirst({ row, team }: { row: SecretMeta; team: { name: string; people: number } | null }) {
  const setSecretAskFirst = useInboxStore((s) => s.setSecretAskFirst);
  const [reviewing, setReviewing] = useState(false);
  const on = !!row.ask_first;
  return (
    <Row label="Ask first">
      <span className="flex items-center gap-2 pt-0.5">
        <Switch checked={on} onCheckedChange={(next) => (next ? setSecretAskFirst(row._id, true) : setReviewing(true))} disabled={isStub(row)} aria-label="Ask first" />
        <span className={`text-[12px] ${on ? "text-sol-cyan" : "text-sol-text-dim"}`} data-vault-ask-first={on ? "on" : "off"}>
          {on ? "Agents ask you per session" : "Agents read it unasked"}
        </span>
      </span>
      {reviewing && (
        <SwitchReview
          ledger={askFirstOffLedger(row, team)}
          onClose={() => setReviewing(false)}
          onConfirm={() => {
            setReviewing(false);
            setSecretAskFirst(row._id, false);
          }}
        />
      )}
    </Row>
  );
}

/** The value fields for a ready secret, per kind. */
function Fields({ row }: { row: SecretMeta }) {
  const { payload, seed, load, error, loading } = useReveal(row._id);
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
        {/* has_otp is stored with the value; a login saved before it existed says nothing, so it keeps the row until a fetch tells. */}
        {row.has_otp !== false && seed !== null && (
          <Row label="2FA code">
            {seed ? (
              <TotpCode seed={seed} />
            ) : (
              <button type="button" onClick={() => void load()} disabled={loading} className="rounded-md border border-sol-border px-2 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text" data-vault-show-code>
                {loading ? "Loading" : "Show code"}
              </button>
            )}
          </Row>
        )}
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
  const now = useCoarseNow(60_000);
  const health = secretHealth(row, now);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isTeam = row.workspace.startsWith("team:");
  const scopeLabel = isTeam ? `Team · ${team && row.team_id === team.id ? team.name : "another team"}` : "Only me";
  const taken = useMemo(() => namesIn(rows, row.workspace, row._id), [rows, row.workspace, row._id]);
  const edit = (fields: Parameters<typeof updateSecretMeta>[1]) => !isStub(row) && updateSecretMeta(row._id, fields);
  const implied = envFor({ ...row, env: [] }).map((b) => b.var);
  const k = KIND[row.kind];
  const teamName = team && row.team_id === team.id ? team.name : "that team";
  const ledgerTeam = isTeam ? { name: teamName, people } : null;

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
            {health ? (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1" style={{ color: `var(--sol-${HEALTH[health].tone})` }} data-vault-health={health}>
                  <span className="size-1.5 rounded-full" style={{ background: "currentColor" }} />
                  {HEALTH[health].label}
                </span>
              </>
            ) : null}
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
              <div className="mb-1.5 text-[12px] text-sol-text-muted">New value. Agents read it from their next use; the old one is kept 7 days.</div>
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
          {row.status === "ready" && <AskFirst row={row} team={ledgerTeam} />}
          {(row.version_count ?? 0) > 0 && <Versions row={row} team={ledgerTeam} />}
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
          ledger={deleteLedger(row, ledgerTeam)}
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
