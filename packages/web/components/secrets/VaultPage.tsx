"use client";
// The team Vault (docs/architecture/vault.md): keys, logins, files and saved
// sign-ins every agent in the team can use, and the requests agents made for
// ones that are missing. Open requests pin to the top with their field
// inline; the list shows what each secret is for, who used it last and its
// health (vaultModel secretHealth), with a filter for the ones that need a
// look; a row opens its detail beside the list (?s=sec-N). Metadata comes
// from the store; values never do.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, FileUp, Plus, Search, ShieldCheck } from "lucide-react";
import { type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { useInboxStore } from "../../store/inboxStore";
import { useSecrets, useSecretsLoaded, useVaultScope } from "../../hooks/useSyncSecrets";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { useEventListener } from "../../hooks/useEventListener";
import { useTabActive } from "../../hooks/usePagePresence";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { formatRelativeTime, formatFullTimestamp } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyCap";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AddSecretDialog, type AddMode } from "./AddSecretDialog";
import { SaveSigninDialog } from "./SaveSignin";
import { SecretDetail } from "./SecretDetail";
import { DeclineRequest, ValueEditor } from "./ValueForm";
import { CommandDisclosure, KIND, KindGlyph, RequestHead, ScopeMark, ScopeTag } from "./parts";
import { HEALTH, filterSecrets, formatIn, isStub, secretHealth, whereUsed, type Scope } from "./vaultModel";

type Fit = "narrow" | "medium" | "wide";
const fitFor = (width: number): Fit => (width < 720 ? "narrow" : width < 1120 ? "medium" : "wide");

const REQUEST_LINE = 'cast vault request stripe-test --why "…"';

const keyOf = (r: SecretMeta) => r.short_id || r._id;

// Glyph, name and note, what it injects or opens, who can use it, and when it was last used.
// Who can use it is left out while every row shown lives in one workspace. The last column is always there,
// so a secret's first use fills a cell instead of moving the grid. At medium the name gives up width to the env chips.
const rowCols = ({ fit, scoped }: { fit: Fit; scoped: boolean }) =>
  ["24px", fit === "medium" ? "minmax(9rem,1.4fr)" : "minmax(12rem,1.7fr)", "minmax(0,1fr)", scoped && "minmax(4.5rem,7rem)", "minmax(7rem,9rem)"].filter(Boolean).join(" ");

const CHIPS_SHOWN = 2;

function AddMenu({ onPick, compact }: { onPick: (m: AddMode) => void; compact?: boolean }) {
  const kinds: SecretKind[] = ["key", "login", "file", "signin"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Add to Vault" className="inline-flex h-7 items-center gap-1.5 rounded-md bg-sol-yellow pl-2.5 pr-2 text-[12.5px] font-semibold text-sol-bg transition-transform duration-150 ease-out hover:brightness-110 active:scale-[0.97]" data-vault-add-menu>
          <Plus size={14} />
          {compact ? null : "Add"}
          <ChevronDown size={13} className="opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        {kinds.map((k) => {
          const Icon = KIND[k].icon;
          return (
            <DropdownMenuItem key={k} onSelect={() => onPick({ kind: k })} data-vault-add-kind={k}>
              <Icon size={14} style={{ color: KIND[k].tone }} />
              {KIND[k].label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onPick({ import: "" })} data-vault-add-import>
          <FileUp size={14} />
          Import .env
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScopeFilter({ value, onChange, counts }: { value: Scope; onChange: (s: Scope) => void; counts: Record<Scope, number> }) {
  const opts: { id: Scope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "team", label: "Team" },
    { id: "personal", label: "Only me" },
  ];
  return (
    <div className="inline-flex rounded-md border border-sol-border/60 p-0.5 text-[12px]" role="radiogroup" aria-label="Show">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 transition-colors ${value === o.id ? "bg-sol-bg-alt text-sol-text shadow-[inset_0_0_0_1px_var(--sol-border)]" : "text-sol-text-muted hover:text-sol-text"}`}
        >
          {o.label}
          <span className="tabular-nums text-sol-text-dim">{counts[o.id]}</span>
        </button>
      ))}
    </div>
  );
}

/** Show only the secrets whose health needs a look; the count says how many before it is pressed. */
function AttentionFilter({ on, count, onChange }: { on: boolean; count: number; onChange: (on: boolean) => void }) {
  if (!count && !on) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[12px] transition-colors ${on ? "border-sol-orange/60 bg-sol-orange/10 text-sol-text" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text"}`}
      data-vault-attention={on ? "on" : "off"}
    >
      <span className="size-1.5 rounded-full bg-sol-orange" />
      Needs attention
      <span className="tabular-nums text-sol-text-dim">{count}</span>
    </button>
  );
}

/** A filled request keeps its card a moment to say where the value went, then folds away and hands over to its row. */
type Filled = { id: string; sent?: { delivered: boolean }; leaving?: boolean };

/** An agent asked for a secret: who, why, where it lands, and the field to fill it, right here. */
function RequestCard({ row, active, filled, onOpen, onStart, onSent }: { row: SecretMeta; active: boolean; filled?: Filled; onOpen: () => void; onStart: () => void; onSent: (delivered: boolean) => void }) {
  const sent = filled?.sent;
  return (
    <li className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${filled?.leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"}`}>
    <div className="min-h-0 overflow-hidden">
    <div
      className={`rounded-lg border bg-sol-bg px-3 py-2.5 transition-colors animate-in fade-in-0 duration-200 motion-reduce:animate-none ${sent ? "border-sol-green/60" : active ? "border-sol-magenta/70" : "border-[color-mix(in_srgb,var(--sol-magenta)_35%,var(--sol-border))]"}`}
      data-vault-request={row.name}
      data-vault-request-state={sent ? "sent" : "open"}
    >
      <RequestHead
        row={row}
        kind={row.kind}
        name={
          <button type="button" onClick={onOpen} className="-mx-1 truncate px-1 font-mono text-[13px] font-semibold text-sol-text outline-none hover:underline underline-offset-2 focus-visible:bg-sol-bg-alt/70 focus-visible:shadow-[inset_2px_0_0_var(--sol-yellow)]">
            {row.name}
          </button>
        }
      />
      {row.request_why ? <div className="mt-1 pl-[34px] text-[12.5px] leading-snug text-sol-text">{row.request_why}</div> : null}
      <div className="mt-2 pl-[34px]">
        {sent ? (
          <div className="flex h-[30px] min-w-0 items-center gap-1.5 text-[12.5px]" data-vault-request-sent>
            <Check size={14} className="shrink-0 text-sol-green" />
            {sent.delivered && row.requested_from_conversation ? (
              <>
                <span className="shrink-0 text-sol-text">Sent to</span>
                <span className="min-w-0 truncate">
                  <EntityIdPill id={row.requested_from_conversation} type="session" />
                </span>
              </>
            ) : (
              <span className="text-sol-text">Saved</span>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <ValueEditor row={row} mode="fulfill" onStart={onStart} onDone={(res) => onSent(!!res.delivered)} />
            </div>
            {/* No value to give, or not one to give an agent: the request closes and the session that asked is told no. */}
            <DeclineRequest row={row} className="h-8 shrink-0 rounded-md px-2 text-[12px] text-sol-text-muted hover:bg-sol-red/10 hover:text-sol-red" />
          </div>
        )}
      </div>
    </div>
    </div>
    </li>
  );
}

/** The right column: when it was last used, or when the state its health names began or ends, behind the state's dot. */
function UsedCell({ row, fit, now, detailOpen }: { row: SecretMeta; fit: Fit; now: number; detailOpen: boolean }) {
  if (isStub(row)) return <>saving</>;
  const health = secretHealth(row, now);
  const exp = row.signin_expires_at;
  const at = health === "expired" || health === "expiring" ? exp! : row.last_used_at;
  return (
    <>
      {health ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: `var(--sol-${HEALTH[health].tone})` }} title={HEALTH[health].label} data-vault-health={health} /> : null}
      {health === "expired" || health === "expiring" ? (
        <span className="shrink-0 tabular-nums" style={{ color: `var(--sol-${HEALTH[health].tone})` }} title={`${HEALTH[health].label} · ${formatFullTimestamp(at!)}`}>
          {health === "expired" ? `expired ${formatRelativeTime(at!, now)}` : `expires ${formatIn(at!, now)}`}
        </span>
      ) : at ? (
        <>
          {/* The session pill only where the column has room for it: wide, with no detail beside the list. */}
          {fit === "wide" && !detailOpen && row.last_used_by_conversation ? (
            <span className="min-w-0 truncate" onClick={(e) => e.stopPropagation()}>
              <EntityIdPill id={row.last_used_by_conversation} type="session" compact />
            </span>
          ) : null}
          <span className={`shrink-0 tabular-nums ${health === "stale" ? "text-sol-yellow" : ""}`} title={formatFullTimestamp(at)}>{formatRelativeTime(at, now)}</span>
        </>
      ) : fit === "narrow" ? null : (
        // Narrow, the unused dot says it (its title); the words would crowd the name's marks.
        <span className="shrink-0">Never used</span>
      )}
    </>
  );
}

function SecretRow({ row, teamName, showScope, onlyMe, cols, detailOpen, active, cursor, flash, fit, now, onOpen }: { row: SecretMeta; teamName: string; showScope: boolean; onlyMe: boolean; cols: string; detailOpen: boolean; active: boolean; cursor: boolean; flash: boolean; fit: Fit; now: number; onOpen: () => void }) {
  const { named, implied } = whereUsed(row);
  const chips = [...named.map((x) => ({ x, implied: false })), ...implied.map((x) => ({ x, implied: true }))];
  const rest = chips.slice(CHIPS_SHOWN).map((c) => c.x);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`relative grid h-11 w-full items-center gap-3 border-b border-sol-border/30 px-5 text-left outline-none transition-colors focus-visible:shadow-[inset_2px_0_0_var(--sol-yellow)] ${fit === "narrow" ? "grid-cols-[24px_minmax(0,1fr)_auto]" : ""} ${active ? "bg-sol-bg-highlight" : cursor ? "bg-sol-bg-alt/70" : "hover:bg-sol-bg-alt/50 focus-visible:bg-sol-bg-alt/70"} ${isStub(row) ? "opacity-60" : ""}`}
        style={fit === "narrow" ? undefined : { gridTemplateColumns: cols }}
        data-vault-row={row.name}
        data-cursor={cursor || undefined}
      >
        {flash && <span aria-hidden className="pointer-events-none absolute inset-0 bg-sol-green/20 animate-out fade-out-0 duration-1000 [animation-fill-mode:forwards] motion-reduce:hidden" data-vault-row-flash />}
        <KindGlyph kind={row.kind} />
        {/* The note takes only what is left; narrow, the name gives way next, so its marks never run into the last column. */}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span className={`max-w-[60%] truncate font-mono text-[13px] text-sol-text ${fit === "narrow" ? "min-w-[4ch]" : "shrink-0"}`}>{row.name}</span>
          {onlyMe ? <ScopeTag row={row} /> : null}
          {row.has_otp ? (
            <span className="shrink-0 rounded border border-sol-border/70 px-1 text-[10px] font-medium leading-[14px] text-sol-text-muted" title="Has a 2FA code" data-vault-otp-mark>
              2FA
            </span>
          ) : null}
          {row.ask_first ? (
            <span className="shrink-0 text-sol-cyan" title="Ask first" data-vault-ask-first-mark>
              <ShieldCheck size={12} />
            </span>
          ) : null}
          {row.note ? (
            <span className="ml-0.5 min-w-0 flex-[1_1_0%] truncate text-[11.5px] text-sol-text-dim">{row.note}</span>
          ) : fit === "narrow" && chips.length ? (
            // No column for them when narrow: what it fills or opens takes the note's place.
            <span className="ml-0.5 min-w-0 flex-[1_1_0%] truncate font-mono text-[11px] text-sol-text-dim" data-vault-row-where>{chips.map((c) => c.x).join(" ")}</span>
          ) : null}
        </span>
        {fit !== "narrow" && (
          <span className="flex min-w-0 flex-nowrap items-center gap-1">
            {chips.slice(0, CHIPS_SHOWN).map((c) => (
              <span key={c.x} className={`truncate rounded border border-sol-border/70 px-1.5 py-[1px] font-mono text-[11px] ${c.implied ? "border-dashed text-sol-text-dim" : "text-sol-text-muted"}`}>{c.x}</span>
            ))}
            {rest.length ? (
              <span className="shrink-0 rounded px-1 font-mono text-[11px] tabular-nums text-sol-text-dim" title={rest.join(", ")} data-vault-chips-more>
                +{rest.length}
              </span>
            ) : null}
          </span>
        )}
        {showScope && <ScopeMark row={row} teamName={teamName} />}
        <span className="flex min-w-0 items-center justify-end gap-1.5 text-[11.5px] text-sol-text-dim">
          <UsedCell row={row} fit={fit} now={now} detailOpen={detailOpen} />
        </span>
      </button>
    </li>
  );
}

function EmptyVault({ onPick }: { onPick: (m: AddMode) => void }) {
  const btn = "inline-flex h-9 min-w-0 items-center justify-start gap-2 rounded-lg border border-sol-border bg-sol-bg px-3.5 text-[13px] text-sol-text hover:border-sol-yellow/60 hover:bg-sol-bg-alt";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8" data-vault-empty>
      <div className="grid w-full max-w-[34rem] grid-cols-2 gap-2">
        <button type="button" className={btn} onClick={() => onPick({ kind: "key" })}>
          <KindGlyph kind="key" size={13} /> Add key
        </button>
        <button type="button" className={btn} onClick={() => onPick({ import: "" })}>
          <FileUp size={15} className="text-sol-text-muted" /> Import .env
        </button>
        <button type="button" className={btn} onClick={() => onPick({ kind: "login" })}>
          <KindGlyph kind="login" size={13} /> Add login
        </button>
        <button type="button" className={btn} onClick={() => onPick({ kind: "signin" })}>
          <KindGlyph kind="signin" size={13} /> Save a browser sign-in
        </button>
      </div>
      <RequestsLandHere />
    </div>
  );
}

/**
 * Where agents' requests will show, drawn as the shape one takes: a dim
 * heading and an empty card, bars where the name and asker go, with its
 * field, dashed and dim so it reads as a slot and never as a request. The command an agent runs is folded under it, for scripts.
 */
function RequestsLandHere() {
  return (
    <section className="w-full max-w-[34rem]" aria-label="Agent requests appear here, to fill" data-vault-requests-slot>
      <h2 className="mb-1.5 text-[12px] font-medium text-sol-text-dim">Agent requests</h2>
      <div aria-hidden className="select-none rounded-lg border border-dashed border-sol-border/60 px-3 py-2.5 opacity-60">
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span className="size-6 shrink-0 rounded-md bg-sol-border/40" />
          <span className="h-2.5 w-24 rounded bg-sol-border/70" />
          <span className="ml-auto h-2 w-12 rounded bg-sol-border/50" />
        </div>
        <div className="mt-2 flex items-center gap-2 pl-[34px]">
          <span className="h-[30px] flex-1 rounded-md border border-sol-border/70" />
          <span className="inline-flex h-[30px] items-center rounded-md bg-sol-border/60 px-3 text-[12.5px] font-semibold text-sol-text-dim">Save</span>
        </div>
      </div>
      <div className="mt-1.5">
        <CommandDisclosure label="For scripts" text={REQUEST_LINE} data-vault-request-command />
      </div>
    </section>
  );
}

/** Row-shaped placeholders while the first answer is on its way, so a Vault with secrets never paints as empty. */
function ListLoading() {
  return (
    <ul aria-hidden className="pt-2" data-vault-loading>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex h-11 items-center gap-3 border-b border-sol-border/30 px-5">
          <span className="size-6 shrink-0 rounded-md bg-sol-border/40" />
          <span className="h-2.5 rounded bg-sol-border/60" style={{ width: `${[28, 20, 34, 24][i]}%` }} />
        </li>
      ))}
    </ul>
  );
}

/** Beside the list when there is room for both; over its rows, under the header, when there isn't. */
function DetailSlot({ fit, children }: { fit: Fit; children: ReactNode }) {
  if (fit === "narrow") return <div className="absolute inset-0 z-20 min-h-0 shadow-2xl">{children}</div>;
  return <div className={`${fit === "wide" ? "w-[min(440px,40%)]" : "w-[440px]"} shrink-0 min-h-0`}>{children}</div>;
}

export function VaultPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fit = useDerivedSize(rootRef, (w) => fitFor(w), () => fitFor(typeof window === "undefined" ? 1400 : window.innerWidth));
  return (
    <div ref={rootRef} className="h-full min-h-0">
      <VaultBody fit={fit} />
    </div>
  );
}

function VaultBody({ fit }: { fit: Fit }) {
  const router = useRouter();
  const params = useSearchParams();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const isTabActive = useTabActive();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useSecrets();
  const loaded = useSecretsLoaded();
  const vaultScope = useVaultScope();
  const keys = { team: vaultScope.team?.key ?? null, personal: vaultScope.personal };
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [attention, setAttention] = useState(false);
  const now = useCoarseNow(60_000);
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [cursor, setCursor] = useState(0);
  // The cursor row is lit only once the keys have moved it; the mouse puts it away.
  const [keyed, setKeyed] = useState(false);
  const [filled, setFilled] = useState<Filled | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const shown = useMemo(() => filterSecrets(rows, { query, scope, team: keys.team, personal: keys.personal, attention, now }), [rows, query, scope, keys.team, keys.personal, attention, now]);
  const attentionCount = useMemo(
    () => filterSecrets(rows, { query: "", scope, team: keys.team, personal: keys.personal, attention: true, now }).filter((r) => r.status === "ready").length,
    [rows, scope, keys.team, keys.personal, now],
  );
  // A request just filled reads ready at once; its card stays in place until it has said where the value went.
  const held = (r: SecretMeta) => r._id === filled?.id;
  const requests = shown.filter((r) => r.status === "requested" || held(r));
  const ready = shown.filter((r) => r.status === "ready" && !held(r));
  const order = [...requests, ...ready];
  const mixedScopes = new Set(ready.map((r) => r.workspace)).size > 1;
  // Counts are of stored secrets; open requests count under Asked for.
  const stored = useMemo(() => rows.filter((r) => r.status === "ready"), [rows]);
  const counts = useMemo(
    () => ({ all: stored.length, team: stored.filter((r) => r.workspace === keys.team).length, personal: stored.filter((r) => r.workspace === keys.personal).length }),
    [stored, keys.team, keys.personal],
  );
  // The scope filter shows only when it can change the list: both buckets hold something.
  const scopeFilterUseful = !!vaultScope.team && counts.team > 0 && counts.personal > 0;
  useWatchEffect(() => {
    if (!scopeFilterUseful) setScope("all");
  }, [scopeFilterUseful]);

  // ?s= names the open secret by short id; a just-created one is named by its name until its short id lands.
  const openKey = params.get("s");
  const open = openKey ? rows.find((r) => r.short_id === openKey || r._id === openKey) ?? rows.find((r) => r.name === openKey) : undefined;
  // Below wide, the detail takes 440px beside the list, so the rows take the narrow grid in what is left.
  const listFit: Fit = open && fit !== "wide" ? "narrow" : fit;
  // The scope column shows while the rows span both workspaces and there is room for it.
  const scopeColumn = mixedScopes && listFit !== "narrow";
  const cols = rowCols({ fit: listFit, scoped: scopeColumn });
  // In a team workspace a personal row is always told apart: by the column when it shows, else by a mark beside its name.
  const markOnlyMe = (r: SecretMeta) => !!vaultScope.team && !scopeColumn && r.workspace === keys.personal;
  const go = (key: string | null) => router.replace(key ? `/vault?s=${encodeURIComponent(key)}` : "/vault");
  const openRow = (r: SecretMeta) => {
    setCursor(Math.max(0, order.indexOf(r)));
    go(keyOf(r));
  };

  useWatchEffect(() => {
    if (!filled?.sent) return;
    const t = setTimeout(() => {
      if (!filled.leaving) return setFilled({ ...filled, leaving: true });
      setFilled(null);
      setFlashId(filled.id);
      const row = useInboxStore.getState().secrets[filled.id] as SecretMeta | undefined;
      if (row?.status === "ready") go(keyOf(row));
    }, filled.leaving ? 200 : 1800);
    return () => clearTimeout(t);
  }, [filled]);
  useWatchEffect(() => {
    if (cursor >= order.length) setCursor(Math.max(0, order.length - 1));
  }, [order.length]);
  // The keys pick up from the open secret, however it was opened (a click, ?s=, a fill).
  useWatchEffect(() => {
    const i = open ? order.indexOf(open) : -1;
    if (i >= 0) setCursor(i);
  }, [open?._id]);
  useWatchEffect(() => {
    listRef.current?.querySelector("[data-cursor]")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // j/k or arrows move, Enter opens, / searches, Esc closes the panel. Fields and dialogs keep their own keys.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!isTabActive || adding || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("[role=dialog]")) return;
    if (keyBelongsElsewhere(target)) {
      if (e.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      } else if ((e.key === "ArrowDown" || e.key === "Enter") && target === searchRef.current && order.length) {
        e.preventDefault();
        if (e.key === "Enter") openRow(order[0]!);
        else {
          searchRef.current?.blur();
          setCursor(0);
          setKeyed(true);
        }
      }
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(order.length - 1, c + 1));
      setKeyed(true);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
      setKeyed(true);
    } else if (e.key === "Enter" && order[cursor] && !target?.closest?.("button, a[href]")) {
      e.preventDefault();
      openRow(order[cursor]!);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      go(null);
    }
  });

  const header = (
    <div ref={titlebarRef} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-sol-border/40 px-5 pb-2.5 pt-4">
      <h1 className="text-xl font-semibold text-sol-text">Vault</h1>
      {loaded || rows.length > 0 ? <span className="pt-1 text-[13px] tabular-nums text-sol-text-dim">{stored.length}</span> : null}
      {rows.length > 0 && (
        <div className={`flex items-center gap-2 ${fit === "narrow" ? "order-last basis-full" : "ml-auto"}`}>
          <AttentionFilter on={attention} count={attentionCount} onChange={setAttention} />
          {scopeFilterUseful && <ScopeFilter value={scope} onChange={setScope} counts={counts} />}
          <label className={`relative ${fit === "narrow" ? "min-w-0 flex-1" : "w-56"}`}>
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              // A search box, so the browser never mistakes it for the username of a password field on the page.
              type="search"
              name="vault-search"
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              className="w-full rounded-md border border-sol-border/60 bg-sol-bg py-1 pl-8 pr-7 text-[13px] text-sol-text outline-none transition-colors placeholder:text-sol-text-dim focus:border-sol-yellow"
              data-vault-search
            />
            {!query && (
              <span className="pointer-events-none absolute right-1.5 top-1/2 hidden -translate-y-1/2 sm:block">
                <KeyCap size="xs">/</KeyCap>
              </span>
            )}
          </label>
        </div>
      )}
      <div className={fit === "narrow" || rows.length === 0 ? "ml-auto" : ""}>
        <AddMenu onPick={setAdding} compact={fit === "narrow"} />
      </div>
    </div>
  );

  const detail = open && <SecretDetail key={open._id} row={open} rows={rows} team={vaultScope.team ? { id: vaultScope.team.id, name: vaultScope.team.name } : null} over={fit === "narrow"} onClose={() => go(null)} />;

  return (
    <div className="relative flex h-full min-h-0" data-vault-page>
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {rows.length === 0 ? (
            loaded ? <EmptyVault onPick={setAdding} /> : <ListLoading />
          ) : (
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-6" onMouseMove={() => keyed && setKeyed(false)}>
              {requests.length > 0 && (
                <section className="px-5 pb-1 pt-3" data-vault-requests>
                  <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-sol-magenta">
                    <span className="size-1.5 rounded-full bg-sol-magenta" />
                    Asked for <span className="tabular-nums">{requests.length}</span>
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {requests.map((r, i) => (
                      <RequestCard
                        key={r._id}
                        row={r}
                        active={open?._id === r._id || (keyed && cursor === i)}
                        filled={held(r) ? filled! : undefined}
                        onOpen={() => openRow(r)}
                        onStart={() => setFilled({ id: r._id })}
                        onSent={(delivered) => setFilled({ id: r._id, sent: { delivered } })}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {ready.length > 0 && (
                <section className="pt-2">
                  {listFit !== "narrow" && (
                    <div className="grid gap-3 px-5 pb-1 text-[11px] text-sol-text-dim [&>span]:truncate [&>span]:whitespace-nowrap" style={{ gridTemplateColumns: cols }}>
                      <span />
                      <span>Name</span>
                      <span>Env var or site</span>
                      {scopeColumn && <span>Shared with</span>}
                      <span className="text-right">Last used</span>
                    </div>
                  )}
                  <ul>
                    {ready.map((r, i) => (
                      <SecretRow key={r._id} row={r} teamName={vaultScope.team?.name ?? "Team"} showScope={scopeColumn} onlyMe={markOnlyMe(r)} cols={cols} detailOpen={!!open} fit={listFit} now={now} active={open?._id === r._id} cursor={keyed && cursor === requests.length + i} flash={flashId === r._id} onOpen={() => openRow(r)} />
                    ))}
                  </ul>
                </section>
              )}
              {order.length === 0 && <div className="px-5 py-10 text-center text-[13px] text-sol-text-dim">No match</div>}
            </div>
          )}
          {/* Over the rows only, so the header (filters, search, Add) stays whole. */}
          {open && fit === "narrow" && <DetailSlot fit={fit}>{detail}</DetailSlot>}
        </div>
      </div>

      {open && fit !== "narrow" && <DetailSlot fit={fit}>{detail}</DetailSlot>}

      {adding && ("kind" in adding && adding.kind === "signin" ? (
        <SaveSigninDialog scope={vaultScope} rows={rows} onClose={() => setAdding(null)} onSaved={(shortId) => (setAdding(null), go(shortId))} />
      ) : (
        <AddSecretDialog mode={adding} scope={vaultScope} rows={rows} onClose={() => setAdding(null)} onSignin={() => setAdding({ kind: "signin" })} onCreated={(name) => go(name)} />
      ))}
    </div>
  );
}
