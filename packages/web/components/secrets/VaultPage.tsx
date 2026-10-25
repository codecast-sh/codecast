"use client";
// The team Vault (docs/architecture/vault.md): keys, logins, files and saved
// sign-ins every agent in the team can use, and the requests agents made for
// ones that are missing. Open requests pin to the top with their field
// inline; the list shows what each secret is for, who used it last and its
// health (vaultModel secretHealth), with a filter for the ones that need a
// look; a row opens its detail beside the list (?s=sec-N). Metadata comes
// from the store; values never do. An agent's tab sees the sample Vault
// (sampleVault.ts) instead of the person's.

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, ChevronLeft, FileUp, Globe, Plus, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { useLinkedSecret, useSecrets, useSecretsLoaded, useVaultScope } from "../../hooks/useSyncSecrets";
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
import { CommandDisclosure, KindGlyph, RequestHead, ScopeMark } from "./parts";
import { KIND, VAULT_PRIMARY } from "../../lib/secretLook";
import { HEALTH, envPairLabel, filterSecrets, formatIn, isStub, secretHealth, whereUsed, type Scope } from "./vaultModel";
import { useSampleVault } from "./sampleVault";
import { VaultSource } from "./VaultSource";

type Fit = "narrow" | "medium" | "wide";
const fitFor = (width: number): Fit => (width < 720 ? "narrow" : width < 1120 ? "medium" : "wide");

const REQUEST_LINE = 'cast vault request stripe-test --why "…"';

const keyOf = (r: SecretMeta) => r.short_id || r._id;

// Glyph, name and note, what it injects or opens, who can use it, and when it was last used.
// Who can use it is left out while every row shown lives in one workspace. The last column is always there,
// so a secret's first use fills a cell instead of moving the grid. At medium the name gives up width to the env chips.
const rowCols = ({ fit, scoped }: { fit: Fit; scoped: boolean }) =>
  ["24px", fit === "medium" ? "minmax(9rem,1.4fr)" : "minmax(12rem,1.7fr)", "minmax(0,1fr)", scoped && "minmax(4.5rem,7rem)", "minmax(7rem,9rem)"].filter(Boolean).join(" ");

function AddMenu({ onPick, compact }: { onPick: (m: AddMode) => void; compact?: boolean }) {
  const kinds: SecretKind[] = ["key", "login", "file", "signin"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Add to Vault" className={`inline-flex h-7 items-center gap-1.5 rounded-md pl-2.5 pr-2 text-[12.5px] ${VAULT_PRIMARY}`} data-vault-add-menu>
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
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 transition-colors ${value === o.id ? "bg-sol-bg-alt text-sol-text shadow-[inset_0_0_0_1px_var(--sol-border)]" : "text-sol-text-muted hover:text-sol-text"}`}
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
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-[3px] text-[12px] transition-colors ${on ? "border-sol-orange/60 bg-sol-orange/10 text-sol-text" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text"}`}
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

/** Height that opens from nothing when it `arrives` and folds away when `leaving`, so what is below slides instead of jumping. */
function Grow({ as: Tag = "div", arrives, leaving, children, ...rest }: { as?: "div" | "li"; arrives: boolean; leaving?: boolean; children: ReactNode } & Record<`data-${string}`, unknown>) {
  const [grown, setGrown] = useState(!arrives);
  const ref = useRef<HTMLElement>(null);
  // Flush the collapsed style once, then open: the track transitions from it. No animation frame, so a hidden tab never strands it closed.
  useLayoutEffect(() => {
    if (grown) return;
    void ref.current?.offsetHeight;
    setGrown(true);
  }, []);
  return (
    <Tag ref={ref as any} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${leaving || !grown ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"}`} {...rest}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </Tag>
  );
}

/** An agent asked for a secret: who, why, where it lands, and the field to fill it, right here. */
function RequestCard({ row, active, compact, filled, arrives, onOpen, onStart, onSent }: { row: SecretMeta; active: boolean; compact: boolean; filled?: Filled; arrives: boolean; onOpen: () => void; onStart: () => void; onSent: (delivered: boolean) => void }) {
  const sent = filled?.sent;
  return (
    <Grow as="li" arrives={arrives} leaving={filled?.leaving}>
    <div
      className={`rounded-lg border bg-sol-bg px-3 py-2.5 transition-colors animate-in fade-in-0 duration-200 motion-reduce:animate-none ${sent ? "border-sol-green/60" : active ? "border-sol-magenta/70" : "border-[color-mix(in_srgb,var(--sol-magenta)_35%,var(--sol-border))]"}`}
      data-vault-request={row.name}
      data-vault-request-state={sent ? "sent" : "open"}
    >
      <RequestHead
        row={row}
        kind={row.kind}
        compact={compact}
        name={
          <button type="button" onClick={onOpen} className="-mx-1 min-w-0 px-1 text-left font-mono text-[13px] font-semibold [overflow-wrap:anywhere] text-sol-text outline-none hover:underline underline-offset-2 focus-visible:bg-sol-bg-alt/70 focus-visible:shadow-[inset_2px_0_0_var(--sol-yellow)]">
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
                  <EntityIdPill id={row.requested_from_conversation} type="session" wide />
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
    </Grow>
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
      ) : (
        <span className="shrink-0">{fit === "narrow" ? "never" : "Never used"}</span>
      )}
    </>
  );
}

type Chip = { x: string; look: "env" | "implied" | "site"; title?: string };

const CHIP_GAP = 4;
/** The +N chip's width: px-1 around "+" and its digits in 11px mono. */
const moreWidth = (n: number) => 8 + Math.ceil(6.7 * (1 + String(n).length));

/**
 * What a row fills and opens, as whole chips in order: as many as the column
 * holds, the rest behind +N. Each chip is measured with every chip laid out,
 * before paint: per chip set, and again once the webfont is in; a resize only recounts.
 */
function RowChips({ chips, cols }: { chips: Chip[]; cols: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const widths = useRef<number[]>([]);
  const sig = chips.map((c) => c.x).join("\n");
  const [fit, setFit] = useState<{ sig: string; count: number } | null>(null);
  const count = fit?.sig === sig ? fit.count : chips.length;
  const recount = () => {
    const room = ref.current?.clientWidth ?? 0;
    const w = widths.current;
    let k = w.length;
    const need = (k: number) => w.slice(0, k).reduce((sum, x, i) => sum + x + (i ? CHIP_GAP : 0), 0) + (k < w.length ? (k ? CHIP_GAP : 0) + moreWidth(w.length - k) : 0);
    while (k > 0 && need(k) > room) k--;
    setFit((prev) => (prev?.sig === sig && prev.count === k ? prev : { sig, count: k }));
  };
  const recountRef = useRef(recount);
  recountRef.current = recount;
  // Measuring lays every chip out again (fit unset) and reads them before paint.
  const [epoch, setEpoch] = useState(0);
  const remeasure = () => {
    setFit(null);
    setEpoch((n) => n + 1);
  };
  const remeasureRef = useRef(remeasure);
  remeasureRef.current = remeasure;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    widths.current = Array.from(el.querySelectorAll<HTMLElement>("[data-vault-chip]"), (c) => c.offsetWidth);
    recount();
  }, [sig, epoch]);
  // Widths taken before the webfont arrives are the fallback face's.
  useLayoutEffect(() => {
    if (!document.fonts || document.fonts.status === "loaded") return;
    let live = true;
    void document.fonts.ready.then(() => live && remeasureRef.current());
    return () => {
      live = false;
    };
  }, []);
  // A new grid template (the fit changing after the first layout) resizes the column in this same pass, where a hidden tab would deliver no ResizeObserver callback.
  useLayoutEffect(() => recountRef.current(), [cols]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // A width of 0 was taken while the row was hidden: unmeasured.
    const ro = new ResizeObserver(() => (widths.current.includes(0) ? remeasureRef.current() : recountRef.current()));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rest = chips.slice(count);
  return (
    <span ref={ref} className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
      {chips.slice(0, count).map((c) =>
        c.look === "site" ? (
          <span key={c.x} className="inline-flex shrink-0 items-center gap-1 rounded bg-sol-bg-alt px-1.5 py-[1px] text-[11px] text-sol-text-muted" title={c.x} data-vault-chip data-vault-row-site>
            <Globe size={10} className="shrink-0" />
            {c.x}
          </span>
        ) : (
          <span key={c.x} className={`shrink-0 whitespace-nowrap rounded border border-sol-border/70 px-1.5 py-[1px] font-mono text-[11px] ${c.look === "implied" ? "border-dashed text-sol-text-dim" : "text-sol-text-muted"}`} title={c.title} data-vault-chip>
            {c.x}
          </span>
        ),
      )}
      {rest.length ? (
        <span className="shrink-0 rounded px-1 font-mono text-[11px] tabular-nums text-sol-text-dim" title={rest.map((c) => c.title ?? c.x).join(", ")} data-vault-chips-more>
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}

function SecretRow({ row, teamName, showScope, onlyMe, cols, detailOpen, active, cursor, flash, fit, now, onOpen }: { row: SecretMeta; teamName: string; showScope: boolean; onlyMe: boolean; cols: string; detailOpen: boolean; active: boolean; cursor: boolean; flash: boolean; fit: Fit; now: number; onOpen: () => void }) {
  const { named, implied, sites } = whereUsed(row);
  const env: Chip[] = [...named.map((x) => ({ x, look: "env" as const })), ...implied.map((x) => ({ x, look: "implied" as const }))];
  // A login's username and password vars share their prefix, so it is said once.
  const pair = row.kind === "login" ? envPairLabel(env.map((c) => c.x)) : null;
  const envChips: Chip[] = pair ? [{ x: pair, look: env[0]!.look, title: env.map((c) => c.x).join(", ") }] : env;
  // A login is known by its site, so the site leads; a key or file by the vars it fills.
  const groups: Chip[][] = [envChips, sites.map((x) => ({ x, look: "site" as const }))];
  if (row.kind === "login") groups.reverse();
  const chips = groups.flat();
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
          {onlyMe ? (
            <span className="shrink-0 text-sol-text-dim" title="Only me" data-vault-scope-mark="personal">
              <UserRound size={12} />
            </span>
          ) : null}
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
            <span className="ml-0.5 min-w-0 flex-[1_1_0%] truncate font-mono text-[11px] text-sol-text-dim" data-vault-row-where>{groups.map((g) => g.map((c) => c.x).join(" ")).filter(Boolean).join(" · ")}</span>
          ) : null}
        </span>
        {fit !== "narrow" && <RowChips chips={chips} cols={cols} />}
        {showScope && <ScopeMark row={row} teamName={teamName} quietTeam />}
        <span className="flex min-w-0 items-center justify-end gap-1.5 text-[11.5px] text-sol-text-dim">
          <UsedCell row={row} fit={fit} now={now} detailOpen={detailOpen} />
        </span>
      </button>
    </li>
  );
}

function EmptyVault({ onPick }: { onPick: (m: AddMode) => void }) {
  const more = "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-sol-border bg-sol-bg px-2.5 text-[12.5px] text-sol-text-muted hover:border-sol-yellow/60 hover:text-sol-text";
  return (
    <div className="flex h-full flex-col items-center justify-center px-8" data-vault-empty>
      <div className="flex w-full max-w-[30rem] flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <ShieldCheck size={22} className="text-sol-yellow" />
          <h2 className="text-[14px] font-semibold text-sol-text">Keys and logins for your agents</h2>
          <p className="text-[12.5px] text-sol-text-muted">Agents use them at run time; values stay out of transcripts.</p>
        </div>
        <button
          type="button"
          onClick={() => onPick({ kind: "key" })}
          className={`inline-flex h-9 items-center gap-2 rounded-md px-4 text-[13px] ${VAULT_PRIMARY}`}
          data-vault-empty-primary
        >
          <Plus size={15} /> Add key
        </button>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className={more} onClick={() => onPick({ import: "" })}>
            <FileUp size={13} /> Import .env
          </button>
          <button type="button" className={more} onClick={() => onPick({ kind: "login" })}>
            <KindGlyph kind="login" size={12} /> Add login
          </button>
          <button type="button" className={more} onClick={() => onPick({ kind: "signin" })}>
            <KindGlyph kind="signin" size={12} /> Save a browser sign-in
          </button>
        </div>
        <section className="mt-3 flex w-full flex-col items-center gap-1 border-t border-sol-border/40 pt-3" data-vault-requests-slot>
          <span className="flex items-center gap-1.5 text-[12px] text-sol-text-dim">
            <span className="size-1.5 rounded-full bg-sol-magenta/60" />
            Agent requests for missing keys show up here
          </span>
          <CommandDisclosure label="For scripts" text={REQUEST_LINE} data-vault-request-command />
        </section>
      </div>
    </div>
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

/** A link named a secret that no workspace of the viewer's holds: deleted, or in a team they are not in. */
function SecretMissing({ refName, over, onClose }: { refName: string; over: boolean; onClose: () => void }) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-sol-border/50 bg-sol-bg" data-vault-detail-missing={refName}>
      {over && (
        <button type="button" onClick={onClose} className="flex h-9 shrink-0 items-center gap-1 border-b border-sol-border/50 px-2.5 text-[12.5px] text-sol-text-muted hover:text-sol-text">
          <ChevronLeft size={15} />
          All secrets
        </button>
      )}
      <header className="flex items-start gap-3 border-b border-sol-border/50 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[15px] font-semibold text-sol-text">{refName}</div>
          <div className="mt-0.5 text-[11.5px] text-sol-text-muted">Not in your workspaces</div>
        </div>
        {!over && (
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex shrink-0 items-center gap-1 rounded p-1 text-sol-text-dim hover:text-sol-text">
            <span className="hidden sm:inline-flex">
              <KeyCap size="xs">esc</KeyCap>
            </span>
            <X size={15} />
          </button>
        )}
      </header>
    </aside>
  );
}

export function VaultPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fit = useDerivedSize(rootRef, (w) => fitFor(w), () => fitFor(typeof window === "undefined" ? 1400 : window.innerWidth));
  return (
    <div ref={rootRef} className="h-full min-h-0">
      <VaultSource>
        <VaultBody fit={fit} />
      </VaultSource>
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
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const sample = !!useSampleVault();
  const loaded = useSecretsLoaded();
  const vaultScope = useVaultScope();
  const keys = { team: vaultScope.team?.key ?? null, personal: vaultScope.personal };
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
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
  // The requests on screen when the pointer came over the rows: one that arrives meanwhile waits until it leaves, so no row moves under a click.
  const [pointerSaw, setPointerSaw] = useState<Set<string> | null>(null);
  const requests = shown.filter((r) => (r.status === "requested" && (!pointerSaw || pointerSaw.has(r._id))) || held(r));
  // The requests the page opened with appear in place; any after them grow in.
  const openedWith = useRef<Set<string> | null>(null);
  if (!openedWith.current && (loaded || rows.length)) openedWith.current = new Set(rows.filter((r) => r.status === "requested").map((r) => r._id));
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

  // ?s= names the open secret by short id; a just-created one is named by its name until its short id lands. One in another team switches to it.
  const openKey = params.get("s");
  const { row: open, missing } = useLinkedSecret(rows, openKey);
  const panelOpen = !!open || missing;
  // Below wide, the detail takes 440px beside the list, so the rows take the narrow grid in what is left.
  const listFit: Fit = panelOpen && fit !== "wide" ? "narrow" : fit;
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
      const row = rowsRef.current.find((r) => r._id === filled.id);
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
    } else if (e.key === "Escape" && panelOpen) {
      e.preventDefault();
      go(null);
    }
  });

  // Narrow, the filters keep their words and Search waits as an icon until it is focused (a click or /), then takes a line of its own.
  const searchShut = fit === "narrow" && !searching && !query;
  const header = (
    <div ref={titlebarRef} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-sol-border/40 px-5 pb-2.5 pt-4">
      <h1 className="text-xl font-semibold text-sol-text">Vault</h1>
      {sample && (
        <span className="self-center rounded border border-sol-violet/50 px-1.5 text-[11px] font-medium leading-[18px] text-sol-violet" data-vault-sample>
          Sample
        </span>
      )}
      {loaded || rows.length > 0 ? <span className="pt-1 text-[13px] tabular-nums text-sol-text-dim">{stored.length}</span> : null}
      {rows.length > 0 && (
        <div className={`flex items-center gap-2 ${fit === "narrow" ? "flex-wrap" : ""} ${listFit === "narrow" ? "order-last basis-full" : "ml-auto"}`}>
          <AttentionFilter on={attention} count={attentionCount} onChange={setAttention} />
          {scopeFilterUseful && <ScopeFilter value={scope} onChange={setScope} counts={counts} />}
          <label className={`relative ${searchShut ? "w-7 shrink-0 cursor-pointer" : fit === "narrow" ? "min-w-[12rem] flex-1" : listFit === "narrow" ? "min-w-0 flex-1" : "w-56"}`} title={searchShut ? "Search" : undefined}>
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearching(true)}
              onBlur={() => setSearching(false)}
              aria-label="Search"
              placeholder={searchShut ? undefined : "Search"}
              // A search box, so the browser never mistakes it for the username of a password field on the page.
              type="search"
              name="vault-search"
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              className={`w-full rounded-md border border-sol-border/60 bg-sol-bg py-1 text-[13px] text-sol-text outline-none transition-colors placeholder:text-sol-text-dim focus:border-sol-yellow ${searchShut ? "cursor-pointer pl-7 pr-0 hover:border-sol-border" : "pl-8 pr-7"}`}
              data-vault-search
            />
            {!query && !searchShut && (
              <span className="pointer-events-none absolute right-1.5 top-1/2 hidden -translate-y-1/2 sm:block">
                <KeyCap size="xs">/</KeyCap>
              </span>
            )}
          </label>
        </div>
      )}
      <div className={listFit === "narrow" || rows.length === 0 ? "ml-auto" : ""}>
        <AddMenu onPick={setAdding} compact={fit === "narrow"} />
      </div>
    </div>
  );

  const detail = open ? (
    <SecretDetail key={open._id} row={open} rows={rows} team={vaultScope.team ? { id: vaultScope.team.id, name: vaultScope.team.name } : null} over={fit === "narrow"} onClose={() => go(null)} />
  ) : missing ? (
    <SecretMissing refName={openKey!} over={fit === "narrow"} onClose={() => go(null)} />
  ) : null;

  return (
    <div className="relative flex h-full min-h-0" data-vault-page>
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {rows.length === 0 ? (
            loaded ? <EmptyVault onPick={setAdding} /> : <ListLoading />
          ) : (
            <div
              ref={listRef}
              className="min-h-0 flex-1 overflow-y-auto pb-6"
              onMouseMove={() => keyed && setKeyed(false)}
              onMouseEnter={() => setPointerSaw(new Set(requests.map((r) => r._id)))}
              onMouseLeave={() => setPointerSaw(null)}
            >
              {requests.length > 0 && (
                <Grow arrives={requests.some((r) => !openedWith.current?.has(r._id))}>
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
                        compact={panelOpen || fit === "narrow"}
                        filled={held(r) ? filled! : undefined}
                        arrives={!openedWith.current?.has(r._id)}
                        onOpen={() => openRow(r)}
                        onStart={() => setFilled({ id: r._id })}
                        onSent={(delivered) => setFilled({ id: r._id, sent: { delivered } })}
                      />
                    ))}
                  </ul>
                </section>
                </Grow>
              )}
              {ready.length > 0 && (
                <section className="pt-2">
                  {listFit !== "narrow" && (
                    <div className="grid gap-3 px-5 pb-1 text-[11px] text-sol-text-dim [&>span]:truncate [&>span]:whitespace-nowrap" style={{ gridTemplateColumns: cols }}>
                      <span />
                      <span>Name</span>
                      <span>Env vars · sites</span>
                      {scopeColumn && <span>Shared with</span>}
                      <span className="text-right">Last used</span>
                    </div>
                  )}
                  <ul>
                    {ready.map((r, i) => (
                      <SecretRow key={r._id} row={r} teamName={vaultScope.team?.name ?? "Team"} showScope={scopeColumn} onlyMe={markOnlyMe(r)} cols={cols} detailOpen={panelOpen} fit={listFit} now={now} active={open?._id === r._id} cursor={keyed && cursor === requests.length + i} flash={flashId === r._id} onOpen={() => openRow(r)} />
                    ))}
                  </ul>
                </section>
              )}
              {order.length === 0 && <div className="px-5 py-10 text-center text-[13px] text-sol-text-dim">No match</div>}
            </div>
          )}
          {/* Over the rows only, so the header (filters, search, Add) stays whole. */}
          {detail && fit === "narrow" && <DetailSlot fit={fit}>{detail}</DetailSlot>}
        </div>
      </div>

      {detail && fit !== "narrow" && <DetailSlot fit={fit}>{detail}</DetailSlot>}

      {adding && ("kind" in adding && adding.kind === "signin" ? (
        <SaveSigninDialog scope={vaultScope} rows={rows} onClose={() => setAdding(null)} onSaved={(shortId) => (setAdding(null), go(shortId))} />
      ) : (
        <AddSecretDialog mode={adding} scope={vaultScope} rows={rows} onClose={() => setAdding(null)} onSignin={() => setAdding({ kind: "signin" })} onCreated={(name) => go(name)} />
      ))}
    </div>
  );
}
