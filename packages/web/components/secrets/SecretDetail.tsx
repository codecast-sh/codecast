"use client";
// One secret, opened from the Vault list: its fields masked with reveal and
// copy, a login's live 2FA code, a sign-in's health, its env vars, sites and
// note edited in place, a new value typed into the field it replaces, Ask
// first, previous values with Restore, who used it from which session, and Delete.

import { useMemo, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ChevronLeft, ChevronRight, Eye, X } from "lucide-react";
import { envNameProblem, isExpiring, siteProblem, type FilePayload, type KeyPayload, type LoginPayload, type SecretMeta, type SecretVersionMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import { useSecretHistory, type SecretEvent } from "../../hooks/useSyncSecrets";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatRelativeTime, formatFullTimestamp } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";
import { SwitchReview, type SwitchFigure, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyCap";
import { Switch } from "../ui/switch";
import { KIND, KindGlyph, MaskedField, ReplaceButton, Row, ScopeMark, TotpCode, useCopy, useReveal, type Replace } from "./parts";
import { DeclineRequest, ValueEditor } from "./ValueForm";
import { EVENT_TONE, EVENT_VERB, HEALTH, envVars, formatIn, isStub, nameIssue, namesIn, secretHealth, splitList, withPendingSwap } from "./vaultModel";

type LedgerTeam = { name: string; people: number } | null;

const FOOTER_ACT = "h-7 rounded-md px-2.5 text-[12px] text-sol-text-dim hover:bg-sol-red/10 hover:text-sol-red";

/** Where a ledger's secret lives, the same on every confirm. */
const scopeSubject = (team: { name: string } | null) => (team ? `Team · ${team.name}` : "Only me");

/** Whose agents the press reaches, named by audience (a count here would read as agents), and what it does to them ("lose it", "switch to it"). */
const audienceFigure = (team: LedgerTeam, verb: string): SwitchFigure =>
  team
    ? { value: team.name, label: `${team.people} ${team.people === 1 ? "person's" : "people's"} agents ${verb}`, tone: "warn" }
    : { value: "Only you", label: `your agents ${verb}`, tone: "warn" };

const readsFigure = (row: SecretMeta): SwitchFigure => ({ value: String(row.use_count ?? 0), label: "agent reads so far" });

/** Delete, as the confirm shows it: who loses the secret, and what goes with it. */
export function deleteLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  const injects = envVars(row);
  return {
    name: `Delete ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [audienceFigure(team, "lose it"), readsFigure(row)],
    rows: [
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
export function askFirstOffLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  return {
    name: "Turn off Ask first",
    subject: `${row.name} · ${scopeSubject(team)}`,
    shift: ["On", "Off"],
    figures: [audienceFigure(team, "read it unasked"), readsFigure(row)],
    rows: [
      { k: "Approval", v: "None, from the next read", tone: "warn" },
      { k: "Activity", v: "Every read still logged" },
      { k: "To undo", v: "Turn Ask first on" },
    ],
    confirm: "Turn off Ask first",
    keep: "Keep it on",
  };
}

/** Restore, as the confirm shows it: the value coming back, and where the current one goes. */
export function restoreLedger(row: SecretMeta, version: SecretVersionMeta, team: LedgerTeam): SwitchLedger {
  return {
    name: `Restore ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [
      { value: formatRelativeTime(version.rotated_at), label: "replaced" },
      ...(version.fingerprint ? [{ value: version.fingerprint, label: "value coming back" }] : []),
    ],
    rows: [
      ...(version.rotated_by_name ? [{ k: "Replaced by", v: version.rotated_by_name }] : []),
      { k: "Agents", v: "Read it from their next use", tone: "warn" as const },
      { k: "Current", v: "Kept 7 days" },
      { k: "To undo", v: "Restore the current value" },
    ],
    confirm: "Restore",
    keep: "Keep current",
  };
}

/** Rotate, as the confirm shows it: who reads the new value, and that the current one stays restorable. */
export function rotateLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  const injects = envVars(row);
  return {
    name: `Replace ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [audienceFigure(team, "switch to it"), readsFigure(row)],
    rows: [
      ...(injects.length ? [{ k: "Env vars", v: injects.join(" ") }] : []),
      { k: "From", v: "Each agent's next use", tone: "warn" },
      { k: "Current", v: "Kept 7 days under Previous" },
      { k: "To undo", v: "Restore the current value" },
    ],
    confirm: "Replace",
    keep: "Keep current",
  };
}

/** A list of short strings edited in place: chips with ×, and a field that adds on Enter, space or comma. */
function ChipEditor({ items, implied, onChange, problemOf, placeholder, mono = true }: { items: string[]; implied?: string[]; onChange: (next: string[]) => void; problemOf?: (s: string) => string | null; placeholder: string; mono?: boolean }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const showImplied = !items.length && !!implied?.length;
  // Beside the vars in use by default, the field stays a quiet slot until it is focused.
  const quiet = showImplied && !focused && !text;
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
          <span key={x} className={`inline-flex items-center gap-1 rounded border border-sol-border bg-sol-bg-alt/60 py-[1px] pl-1.5 pr-0.5 text-[11px] text-sol-text ${mono ? "font-mono" : ""}`}>
            {x}
            <button type="button" onClick={() => onChange(items.filter((y) => y !== x))} aria-label={`Remove ${x}`} className="rounded p-0.5 text-sol-text-dim hover:text-sol-red">
              <X size={11} />
            </button>
          </span>
        ))}
        {/* The vars injected while none is set: dashed, as the list draws them, since they come from the name. */}
        {showImplied &&
          implied?.map((x) => (
            <span key={x} className="rounded border border-dashed border-sol-border/70 px-1.5 py-[1px] font-mono text-[11px] text-sol-text-muted" data-vault-env-default>
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
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) add();
          }}
          placeholder={quiet ? undefined : placeholder}
          aria-label={placeholder}
          spellCheck={false}
          // Beside chips the field takes what is left of their line ("Add" needs 3rem), so it wraps under them only when the line is full.
          className={`${items.length ? "min-w-[3rem]" : quiet ? "min-w-[2rem]" : "min-w-[7rem]"} flex-1 bg-transparent px-1 py-0.5 text-[12px] text-sol-text outline-none placeholder:text-sol-text-dim ${mono ? "font-mono" : ""}`}
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
      {multiline ? <textarea rows={Math.min(6, Math.max(1, shown.split("\n").length))} {...props} className={`${props.className} [field-sizing:content]`} /> : <input {...props} />}
      {problem ? <div className="text-[11.5px] text-sol-red">{problem}</div> : null}
    </div>
  );
}

/** A list's query failed for good: say so, with the way to ask again. */
function NotLoaded({ retry, as: Tag = "div" }: { retry: () => void; as?: "div" | "li" }) {
  return (
    <Tag className="flex items-center gap-2 py-1 text-[12px]" data-vault-not-loaded>
      <span className="text-sol-red">Not loaded</span>
      <button type="button" onClick={retry} className="rounded px-1.5 py-0.5 text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text">
        Retry
      </button>
    </Tag>
  );
}

/** Placeholder rows in a list's shape, so its height holds while it loads. */
function LoadingRows({ as: Tag = "div" }: { as?: "div" | "li" }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <Tag key={i} aria-hidden className="flex h-5 items-center gap-2 py-1" data-vault-loading>
          <span className="size-1.5 shrink-0 rounded-full bg-sol-border" />
          <span className="h-2 w-[40%] rounded bg-sol-border/50" />
        </Tag>
      ))}
    </>
  );
}

function Activity({ row }: { row: SecretMeta }) {
  const { rows: data, error, retry } = useSecretHistory("events", row._id, !isStub(row));
  const me = useInboxStore((s) => s.currentUser?.name ?? "You");
  const events = data === undefined ? [] : withPendingSwap(data, row, { _id: "pending-swap", kind: "rotated", at: row.rotated_at ?? 0, actor_name: me } as SecretEvent);
  return (
    <section className="border-t border-sol-border/50 px-4 pb-4 pt-3" data-vault-activity>
      <h3 className="mb-1.5 text-[12px] font-medium text-sol-text-muted">Activity</h3>
      {error && data === undefined ? (
        <NotLoaded retry={retry} />
      ) : data === undefined && !isStub(row) ? (
        <LoadingRows />
      ) : !events.length ? (
        <div className="text-[12px] text-sol-text-dim">Nothing yet</div>
      ) : (
        <ol className="flex flex-col">
          {events.map((e) => (
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
function Versions({ row, team }: { row: SecretMeta; team: LedgerTeam }) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<SecretVersionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = useAction(api.secrets.restore);
  const now = useCoarseNow(60_000);
  const { rows: data, error: loadError, retry } = useSecretHistory("versions", row._id, open);
  const versions = data ?? [];
  const count = row.version_count ?? 0;
  return (
    <>
      <Row label="Previous">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-sol-text-muted hover:text-sol-text"
          data-vault-versions
        >
          <ChevronRight size={12} className={`transition-transform duration-[120ms] ease-out ${open ? "rotate-90" : ""}`} />
          <span className="tabular-nums text-sol-text">{count}</span> kept
        </button>
      </Row>
      {open && (
        <ol className="mb-1 ml-[calc(6.5rem+0.75rem)] flex flex-col" data-vault-version-list>
          {loadError && data === undefined ? (
            <NotLoaded retry={retry} as="li" />
          ) : data === undefined ? (
            <LoadingRows as="li" />
          ) : !versions.length ? (
            <li className="py-1 text-[12px] text-sol-text-dim">None left</li>
          ) : (
            versions.map((v) => (
              <li key={v._id} className="flex flex-col gap-0.5 py-1" data-vault-version={v._id}>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-sol-text">{v.fingerprint ?? "Earlier value"}</span>
                  <button type="button" onClick={() => (setError(null), setRestoring(v))} className="h-6 shrink-0 rounded-md border border-sol-border px-2 text-[11.5px] text-sol-text-muted hover:text-sol-text" data-vault-restore>
                    Restore
                  </button>
                </span>
                {/* The name gives way; when it was replaced and when it goes stay whole. */}
                <span className="flex min-w-0 gap-1 whitespace-nowrap text-[11.5px] text-sol-text-dim">
                  <span className="shrink-0" title={formatFullTimestamp(v.rotated_at)}>replaced {formatRelativeTime(v.rotated_at, now)}</span>
                  <span className="min-w-0 truncate">by {v.rotated_by_name ?? "someone"}</span>
                  <span className="shrink-0" title={formatFullTimestamp(v.expires_at)}>· gone {formatIn(v.expires_at, now)}</span>
                </span>
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
function AskFirst({ row, team }: { row: SecretMeta; team: LedgerTeam }) {
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

/** The value fields for a ready secret, per kind; `replace` goes on the field that holds the value. */
function Fields({ row, replace }: { row: SecretMeta; replace?: Replace }) {
  const { payload, seed, load, error, loading } = useReveal(row._id, row.value_updated_at);
  const field = <T,>(pick: (p: T) => string | undefined) => async () => {
    const p = await load();
    return p ? pick(p as T) : undefined;
  };
  const p = payload as any;
  let body: ReactNode;
  if (row.kind === "key") {
    body = <MaskedField label="Value" value={p?.value} load={field<KeyPayload>((x) => x.value)} hint={row.fingerprint} replace={replace} />;
  } else if (row.kind === "login") {
    const login = p as LoginPayload | null;
    body = (
      <>
        <MaskedField label="Username" value={login ? login.username ?? "" : undefined} load={field<LoginPayload>((x) => x.username)} plain />
        <MaskedField label="Password" value={login?.password} load={field<LoginPayload>((x) => x.password)} replace={replace} />
        {/* has_otp is stored with the value; a login saved before it existed says nothing, so it keeps the row until a fetch tells. */}
        {row.has_otp !== false && seed !== null &&
          (seed ? (
            <TotpCode seed={seed} />
          ) : (
            // The placeholder is drawn the size TotpCode draws its code, so revealing swaps the text in place.
            <Row
              label="2FA code"
              actions={
                <>
                  <button type="button" onClick={() => void load()} disabled={loading} title="Reveal" aria-label="Show 2FA code" className="inline-flex h-6 w-6 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text" data-vault-show-code>
                    <Eye size={13} />
                  </button>
                  {/* The copy slot, so this eye lines up with the eyes above it. */}
                  <span aria-hidden className="w-6" />
                </>
              }
            >
              <span className="-mt-0.5 inline-flex items-center">
                <span className="font-mono text-[17px] font-semibold tracking-[0.08em] text-sol-text-dim">··· ···</span>
              </span>
            </Row>
          ))}
      </>
    );
  } else if (row.kind === "file") {
    const file = p as FilePayload | null;
    body = <MaskedField label={file?.filename ?? "Content"} value={file?.content} load={field<FilePayload>((x) => x.content)} multiline replace={replace} />;
  } else {
    const s = p as SigninPayload | null;
    const exp = row.signin_expires_at;
    const expired = exp !== undefined && exp < Date.now();
    body = (
      <>
        <Row label="Expires">
          <span className="text-[12.5px]" style={{ color: exp === undefined ? "var(--sol-text-muted)" : expired ? "var(--sol-red)" : isExpiring(exp, Date.now()) ? "var(--sol-orange)" : "var(--sol-text)" }} title={exp ? formatFullTimestamp(exp) : undefined}>
            {exp === undefined ? "When the browser closes" : expired ? `Expired ${formatRelativeTime(exp)}` : formatFullTimestamp(exp)}
          </span>
        </Row>
        <Row label="Captured" align={replace?.editor ? "input" : undefined} actions={replace && !replace.editor ? <ReplaceButton onClick={replace.start} /> : undefined}>
          {replace?.editor ? (
            replace.editor
          ) : s ? (
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

/** The secret's short id, dim; a press copies it, and it goes green, or red when the clipboard refused. */
function ShortIdButton({ id }: { id: string | undefined }) {
  const { state, copy } = useCopy();
  if (!id) return <span className="font-mono text-[11px] text-sol-text-dim">saving</span>;
  return (
    <button
      type="button"
      onClick={() => void copy(() => id)}
      title={state === "copied" ? "Copied" : state === "failed" ? "Not copied" : "Copy id"}
      className={`rounded px-1 py-0.5 font-mono text-[11px] transition-colors ${state === "copied" ? "text-sol-green" : state === "failed" ? "text-sol-red" : "text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"}`}
      data-vault-short-id
    >
      {id}
    </button>
  );
}

/** `over` when it covers the list (a narrow page): a back row on top takes the close button's place. */
export function SecretDetail({ row, rows, team, over, onClose }: { row: SecretMeta; rows: SecretMeta[]; team: { id: string; name: string } | null; over?: boolean; onClose: () => void }) {
  const updateSecretMeta = useInboxStore((s) => s.updateSecretMeta);
  const removeSecret = useInboxStore((s) => s.removeSecret);
  const people = useInboxStore((s) => peopleOf(s.teamMembers).length);
  const now = useCoarseNow(60_000);
  const health = secretHealth(row, now);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isTeam = row.workspace.startsWith("team:");
  const taken = useMemo(() => namesIn(rows, row.workspace, row._id), [rows, row.workspace, row._id]);
  const edit = (fields: Parameters<typeof updateSecretMeta>[1]) => !isStub(row) && updateSecretMeta(row._id, fields);
  const implied = envVars({ ...row, env: [] });
  const ledgerTeam = isTeam ? { name: team && row.team_id === team.id ? team.name : "another team", people } : null;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-sol-border/50 bg-sol-bg" data-vault-detail={row.short_id || row._id}>
      {over && (
        <button type="button" onClick={onClose} className="flex h-9 shrink-0 items-center gap-1 border-b border-sol-border/50 px-2.5 text-[12.5px] text-sol-text-muted hover:text-sol-text" data-vault-detail-back>
          <ChevronLeft size={15} />
          All secrets
        </button>
      )}
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
          {/* One line, whole at any width: the short kind label, the scope, the health. */}
          <div className="mt-0.5 flex min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-sol-text-muted" data-vault-detail-meta>
            <span className="shrink-0">{KIND[row.kind].short}</span>
            <span className="shrink-0 text-sol-text-dim">·</span>
            <ScopeMark row={row} teamName={ledgerTeam?.name} className="shrink-0 text-[11.5px]" />
            {health ? (
              <>
                <span className="shrink-0 text-sol-text-dim">·</span>
                <span className="inline-flex shrink-0 items-center gap-1" style={{ color: `var(--sol-${HEALTH[health].tone})` }} data-vault-health={health}>
                  <span className="size-1.5 rounded-full" style={{ background: "currentColor" }} />
                  {HEALTH[health].label}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ShortIdButton id={row.short_id} />
          {!over && (
            <button type="button" onClick={onClose} aria-label="Close" className="inline-flex items-center gap-1 rounded p-1 text-sol-text-dim hover:text-sol-text">
              <span className="hidden sm:inline-flex">
                <KeyCap size="xs">esc</KeyCap>
              </span>
              <X size={15} />
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto" data-private>
        <section className="px-4 py-2">
          {row.status === "requested" ? (
            <div className="py-1">
              <div className="mb-1.5 text-[12px] text-sol-magenta">Requested{row.requested_by_name ? ` by ${row.requested_by_name}` : ""}{row.request_why ? `: ${row.request_why}` : ""}</div>
              <ValueEditor row={row} mode="fulfill" autoFocus />
            </div>
          ) : isStub(row) ? (
            <div className="py-1.5 text-[12px] text-sol-text-dim">Saving…</div>
          ) : (
            <>
              <Fields
                row={row}
                replace={
                  row.status === "ready"
                    ? {
                        start: () => setRotating(true),
                        editor: rotating ? <ValueEditor row={row} mode="rotate" review={rotateLedger(row, ledgerTeam)} autoFocus onDone={() => setRotating(false)} onCancel={() => setRotating(false)} /> : null,
                      }
                    : undefined
                }
              />
            </>
          )}
        </section>

        <section className="border-t border-sol-border/50 px-4 py-2">
          {row.kind !== "signin" && (
            <Row label="Env vars">
              <ChipEditor items={row.env ?? []} implied={implied} onChange={(env) => edit({ env })} problemOf={envNameProblem} placeholder={row.env?.length ? "Add" : "Set your own"} />
            </Row>
          )}
          {(row.kind === "login" || row.kind === "signin" || !!row.sites?.length) && (
            <Row label="Sites">
              <ChipEditor items={row.sites ?? []} onChange={(sites) => edit({ sites })} problemOf={siteProblem} placeholder={row.sites?.length ? "Add" : "Add a site"} />
            </Row>
          )}
          <Row label="Note">
            <InlineText value={row.note ?? ""} label="Note" multiline placeholder="What it is for" onSave={(note) => edit({ note })} className="-ml-1 block min-h-0 resize-none px-1 py-0.5 text-[12.5px] leading-[18px] text-sol-text" />
          </Row>
          {row.status === "ready" && <AskFirst row={row} team={ledgerTeam} />}
          {(row.version_count ?? 0) > 0 && <Versions row={row} team={ledgerTeam} />}
        </section>

        <section className="border-t border-sol-border/50 px-4 py-2 text-[12.5px]">
          {/* Who added or replaced it, and when, is Activity's first lines. */}
          <Row label="Use">
            <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sol-text-muted" data-vault-use>
              {!row.use_count && !row.last_used_at ? (
                <span className="text-sol-text-dim">Never used</span>
              ) : (
                <>
                  <span className="shrink-0">
                    <span className="tabular-nums text-sol-text">{row.use_count ?? 0}</span> {row.use_count === 1 ? "read" : "reads"}
                  </span>
                  {row.last_used_at ? (
                    <>
                      <span className="shrink-0 text-sol-text-dim">·</span>
                      <span className="shrink-0" title={formatFullTimestamp(row.last_used_at)}>last {formatRelativeTime(row.last_used_at, now)}</span>
                    </>
                  ) : null}
                </>
              )}
              {row.last_used_by_conversation ? (
                <span className="min-w-0 truncate">
                  <EntityIdPill id={row.last_used_by_conversation} type="session" compact />
                </span>
              ) : null}
            </span>
          </Row>
        </section>

        <Activity row={row} />
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-sol-border/50 px-4 py-2.5">
        {row.status === "requested" ? (
          <DeclineRequest row={row} onDeclined={onClose} className={FOOTER_ACT} />
        ) : (
          <button type="button" onClick={() => setDeleting(true)} disabled={isStub(row)} className={`${FOOTER_ACT} disabled:opacity-40`} data-vault-delete>
            Delete
          </button>
        )}
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
