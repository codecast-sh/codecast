"use client";
// Pieces the Vault page, its detail panel and its add dialog share: the kind
// glyphs, the reveal hook that holds a value in component state only, a masked
// field with reveal and copy, a typing field that hides what is typed, the
// live 2FA code, the labeled row they all sit in, and a request's head line.
// Anything showing a value carries data-private, which keeps it out of the
// error replay's page outline (platform analytics replay.ts).

import { useState, type ReactNode } from "react";
import { Check, ChevronRight, CircleHelp, Copy, Eye, EyeOff, Fingerprint, Loader2, Lock, RefreshCw, UserRound, Users, X } from "lucide-react";
import { totp, type EnvNameIssue, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { DROP_OVER, FIELD_MONO, KIND } from "../../lib/secretLook";
import { useCopy } from "../../hooks/useCopy";
import type { FileDrop } from "../../hooks/useFileDrop";

export function KindGlyph({ kind, size = 14 }: { kind: SecretKind; size?: number }) {
  const k = KIND[kind];
  const Icon = k.icon;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md"
      style={{ width: size + 10, height: size + 10, color: k.tone, background: `color-mix(in srgb, ${k.tone} 13%, transparent)` }}
      title={k.label}
    >
      <Icon size={size} />
    </span>
  );
}

/**
 * Copy text and show a check, or an ×, for a moment, in a fixed square so the
 * row around it never moves; the words go to screen readers and the title.
 * `withLabel` also shows them, where the button sits in a line of text.
 * `get` may fetch the text first. `held` disables it and says who copies it
 * instead (lib/agentTabGuard); `gated` says the fetch asks for Touch ID.
 */
export function CopyButton({ get, label = "Copy", className = "", withLabel, held, gated }: { get: () => Promise<string | undefined> | string | undefined; label?: string; className?: string; withLabel?: boolean; held?: string; gated?: boolean }) {
  const { state, copy } = useCopy();
  const words = state === "copied" ? "Copied" : state === "failed" ? "Not copied" : "";
  const glyph = (on: boolean) => `transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${on ? "opacity-100 scale-100" : "opacity-0 scale-75"}`;
  return (
    <button
      type="button"
      onClick={() => void copy(get)}
      disabled={!!held}
      title={held ?? (words || (gated ? `${label} with Touch ID` : label))}
      aria-label={label}
      className={`inline-flex h-6 shrink-0 items-center justify-center rounded text-[11px] transition-[color,background-color,transform] duration-150 active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${withLabel ? "px-1.5" : "w-6"} ${held ? "text-sol-text-dim" : state === "copied" ? "text-sol-green" : state === "failed" ? "text-sol-red" : "text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"} ${className}`}
      data-vault-copy
    >
      <span aria-hidden className="grid [&>*]:col-start-1 [&>*]:row-start-1">
        <Copy size={13} className={glyph(state === "idle")} />
        <Check size={13} className={glyph(state === "copied")} />
        <X size={13} className={glyph(state === "failed")} />
      </span>
      <span aria-live="polite" className={withLabel ? (words ? "ml-1" : "") : "sr-only"}>
        {words}
      </span>
    </button>
  );
}

/** Commands for whoever scripts it, folded behind a small label and copyable while folded; whole when opened. */
export function CommandDisclosure({ label, text, ...rest }: { label: string; text: string } & Record<`data-${string}`, unknown>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0" {...rest}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] text-sol-text-dim hover:text-sol-text">
          <ChevronRight size={12} className={`transition-transform duration-[120ms] ease-out ${open ? "rotate-90" : ""}`} />
          {label}
        </button>
        <CopyButton get={() => text} label={text.includes("\n") ? "Copy commands" : "Copy command"} withLabel />
      </div>
      {open && <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-sol-border/70 bg-sol-bg-alt/50 px-2 py-1.5 font-mono text-[12px] leading-snug text-sol-text">{text}</pre>}
    </div>
  );
}


const DOTS = "••••••••••••";

/** The eye that shows a value, or hides it again; a fingerprint where showing it asks for Touch ID (`gated`); where `held` says who reveals it instead, a disabled lock. */
export function RevealButton({ shown, label, onClick, held, gated, disabled, ...rest }: { shown?: boolean; label: string; onClick: () => void; held?: string; gated?: boolean; disabled?: boolean } & Record<`data-${string}`, unknown>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !!held}
      title={held ?? (shown ? "Hide" : gated ? "Reveal with Touch ID" : "Reveal")}
      aria-label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-sol-text-dim"
      {...rest}
    >
      {held ? <Lock size={13} /> : shown ? <EyeOff size={13} /> : gated ? <Fingerprint size={13} /> : <Eye size={13} />}
    </button>
  );
}

/** One field of a secret: masked until the eye is pressed; copy works without showing it. */
export function MaskedField({
  label,
  value,
  load,
  hint,
  multiline,
  plain,
  replace,
  held,
  gated,
}: {
  label: string;
  /** The field's value once revealed, else undefined. */
  value: string | undefined;
  /** Fetches the payload and returns this field's value. */
  load: () => Promise<string | undefined>;
  /** What identifies it while masked (a fingerprint). */
  hint?: string;
  multiline?: boolean;
  /** Not secret (a username): dim dots and the same eye, and once loaded it stays shown. */
  plain?: boolean;
  /** The field that takes a new value: its replace button, and the editor shown in place of the value while replacing. */
  replace?: Replace;
  /** Who reveals and copies it instead of this tab, when not this tab. */
  held?: string;
  /** Revealing and copying it ask for Touch ID. */
  gated?: boolean;
}) {
  const [shown, setShown] = useState(false);
  // A dropped value comes back masked: a later copy fetches it without showing it.
  useWatchEffect(() => {
    if (value === undefined) setShown(false);
  }, [value]);
  const visible = value !== undefined && (shown || plain);
  const toggle = async () => {
    if (shown) return setShown(false);
    if ((await load()) !== undefined) setShown(true);
  };
  if (replace?.editor) {
    return (
      <Row label={label} align="input" data-vault-field={label}>
        {replace.editor}
      </Row>
    );
  }
  return (
    <Row
      label={label}
      data-vault-field={label}
      actions={
        <>
          {replace && <ReplaceButton onClick={replace.start} saving={replace.saving} />}
          {!(plain && visible) && <RevealButton shown={shown} label={shown ? `Hide ${label}` : `Reveal ${label}`} onClick={() => void toggle()} held={held} gated={gated} data-vault-reveal />}
          <CopyButton get={load} label={`Copy ${label}`} held={held} gated={gated} />
        </>
      }
    >
      {visible ? (
        multiline ? (
          <pre data-private className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sol-bg-alt/60 px-2 py-1.5 font-mono text-[12px] text-sol-text">{value}</pre>
        ) : (
          <span data-private className="block select-all break-all pt-0.5 font-mono text-[12.5px] text-sol-text">{value}</span>
        )
      ) : plain ? (
        // Not secret, so short middle dots, which never read as a second password.
        <span className="pt-0.5 font-mono text-[12.5px] text-sol-text-dim">·····</span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-2 pt-0.5 font-mono text-[12.5px]">
          <span className="tracking-[0.15em] text-sol-text-dim">{DOTS}</span>
          {hint ? <span className="truncate text-[11px] text-sol-text-muted">{hint}</span> : null}
        </span>
      )}
    </Row>
  );
}

/** `saving` while a value swap pressed here waits on the server. */
export type Replace = { start: () => void; editor: ReactNode; saving?: boolean };

/** Opens a field's replace editor, in the row's trailing column beside reveal and copy; it spins, and waits, while a swap is saving. */
export function ReplaceButton({ onClick, saving }: { onClick: () => void; saving?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      aria-busy={saving || undefined}
      title={saving ? "Saving" : "Replace value"}
      aria-label={saving ? "Saving" : "Replace value"}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text disabled:cursor-default disabled:hover:bg-transparent"
      data-vault-rotate={saving ? "saving" : ""}
    >
      {saving ? <Loader2 size={13} className="animate-spin text-sol-yellow motion-reduce:animate-none" /> : <RefreshCw size={13} />}
    </button>
  );
}

/** A text field for a value being typed: hidden by default, with an eye to check it. */
export function SecretInput({
  value,
  onChange,
  onPaste,
  placeholder,
  autoFocus,
  multiline,
  name,
  drop,
}: {
  value: string;
  onChange: (v: string) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  placeholder?: string;
  autoFocus?: boolean;
  multiline?: boolean;
  name?: string;
  /** A multiline field that takes a dropped file (useFileDrop). */
  drop?: FileDrop;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative flex min-w-0 flex-1 items-start">
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          rows={5}
          name={name}
          {...drop?.props}
          // A file's text is masked by blurring it rather than by a password field, which can't hold lines.
          className={`${FIELD_MONO} resize-y pr-8 ${drop?.over ? DROP_OVER : ""} ${shown || !value ? "" : "text-transparent [text-shadow:0_0_6px_var(--sol-text-muted)]"}`}
        />
      ) : (
        <input
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          placeholder={placeholder}
          autoFocus={autoFocus}
          // new-password keeps Chrome from filling a saved login into a secret being typed.
          autoComplete="new-password"
          spellCheck={false}
          name={name}
          data-1p-ignore
          className={`${FIELD_MONO} pr-8`}
        />
      )}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? "Hide" : "Show"}
        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded text-sol-text-dim hover:text-sol-text"
      >
        {shown ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

/**
 * A login's 2FA row. Before its seed is fetched the code is masked, with an
 * eye that fetches it; once fetched, the current code ticks each second with a
 * ring that empties as it runs out. Copy sits in the actions column either
 * way, and while masked it fetches the seed and copies the current code.
 */
export function TotpCode({ seed, fetchSeed, fetching, held, gated }: { seed: string | undefined; fetchSeed?: () => Promise<string | undefined>; fetching?: boolean; held?: string; gated?: boolean }) {
  const [now, setNow] = useState(() => ({ code: "", remaining: 30, period: 30, refill: false }));
  const [broken, setBroken] = useState(false);
  useWatchEffect(() => {
    if (!seed) return;
    let alive = true;
    setBroken(false);
    const tick = () =>
      totp(seed).then(
        // The first code and each new period set the ring at once; a tick can land past a period's first second, so a new period is any rise in the count.
        (r) => alive && setNow((prev) => ({ ...r, refill: !prev.code || r.remaining > prev.remaining })),
        () => alive && setBroken(true),
      );
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [seed]);
  if (broken) {
    return (
      <Row label="2FA code">
        <span className="block pt-0.5 text-[12px] text-sol-red">Seed unreadable: rotate it</span>
      </Row>
    );
  }
  const copy = async () => {
    if (seed) return now.code || (await totp(seed)).code;
    const fetched = await fetchSeed?.();
    return fetched ? (await totp(fetched)).code : undefined;
  };
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = now.remaining / now.period;
  const urgent = now.remaining <= 5;
  const tone = urgent ? "var(--sol-red)" : "var(--sol-green)";
  const half = Math.ceil(now.code.length / 2);
  return (
    <Row
      label="2FA code"
      actions={
        <>
          {!seed && <RevealButton label="Show 2FA code" onClick={() => void fetchSeed?.()} disabled={fetching} held={held} gated={gated} data-vault-show-code />}
          <CopyButton get={copy} label="Copy code" held={held} gated={!seed && gated} />
        </>
      }
    >
      {/* Masked, the dots are drawn the size of the code, so revealing swaps the text in place. */}
      <span className="-mt-0.5 inline-flex items-center gap-2" data-vault-totp={seed ? "" : "masked"}>
        <span data-private className="font-mono text-[17px] font-semibold tabular-nums tracking-[0.08em]" style={{ color: !seed ? "var(--sol-text-dim)" : urgent ? "var(--sol-red)" : "var(--sol-text)", transition: "color 150ms ease-out" }}>
          {seed && now.code ? `${now.code.slice(0, half)} ${now.code.slice(half)}` : "··· ···"}
        </span>
        {seed && (
          <>
            <svg width={20} height={20} viewBox="0 0 20 20" aria-label={`${now.remaining} seconds left`} className="-rotate-90">
              <circle cx={10} cy={10} r={r} fill="none" stroke="var(--sol-border)" strokeWidth={2.5} />
              <circle cx={10} cy={10} r={r} fill="none" stroke={tone} strokeWidth={2.5} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" style={{ transition: now.refill ? "none" : "stroke-dashoffset 1s linear" }} />
            </svg>
            <span className="w-5 text-[11px] tabular-nums text-sol-text-dim">{now.remaining}s</span>
          </>
        )}
      </span>
    </Row>
  );
}

/**
 * A labeled row in the detail panel or the add form. `actions` adds a trailing
 * column of up to three buttons, fixed in width and right-aligned, so copy
 * (always last) sits in the same place on every row; `align="input"` drops the
 * label to the text line of a bordered input beside it.
 */
export function Row({
  label,
  children,
  actions,
  align,
  className = "",
  ...rest
}: { label: string; children: ReactNode; actions?: ReactNode; align?: "input"; className?: string } & Record<`data-${string}`, unknown>) {
  return (
    <div className={`grid min-h-7 items-start gap-x-3 py-1.5 ${actions ? "grid-cols-[6.5rem_minmax(0,1fr)_auto]" : "grid-cols-[6.5rem_minmax(0,1fr)]"} ${className}`} {...rest}>
      <span className={`${align === "input" ? "pt-[7px]" : "pt-[3px]"} text-[12px] text-sol-text-dim`}>{label}</span>
      <div className="min-w-0">{children}</div>
      {actions ? <span className="flex min-w-[76px] items-center justify-end gap-0.5">{actions}</span> : null}
    </div>
  );
}

/** What is wrong with a field, in one line under it; a longer reason waits behind the help icon. */
export function FieldProblem({ issue, className = "mt-0.5" }: { issue: string | EnvNameIssue | null | undefined; className?: string }) {
  if (!issue) return null;
  const { problem, why } = typeof issue === "string" ? { problem: issue, why: undefined } : issue;
  return (
    <div className={`text-[11.5px] text-sol-red ${className}`} data-vault-field-problem>
      {problem}
      {why ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Why" className="ml-1 inline-flex rounded align-[-2px] text-sol-text-dim hover:text-sol-text focus-visible:text-sol-text">
                <CircleHelp size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[18rem] border border-sol-border/60 bg-sol-bg-alt px-2 py-1 text-[11px] text-sol-text shadow-md">
              {why}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

/** Where a secret lands, said the same on a request card and a row: every agent in the team, or only yours. */
/** `quietTeam` dims team rows, for a list where most rows are the team's and the personal ones are the exceptions to notice. */
export function ScopeMark({ row, teamName, className = "", quietTeam = false }: { row: SecretMeta; teamName?: string; className?: string; quietTeam?: boolean }) {
  const team = row.workspace.startsWith("team:");
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 text-[11px] ${team && quietTeam ? "text-sol-text-dim" : "text-sol-text-muted"} ${className}`} title={team ? "Every agent in the team" : "Only you and your agents"} data-vault-scope-mark={team ? "team" : "personal"}>
      {team ? <Users size={11} className="shrink-0" /> : <UserRound size={11} className="shrink-0" />}
      <span className="truncate">{team ? teamName ?? "Team" : "Only me"}</span>
    </span>
  );
}

export function ScopeTag({ row }: { row: SecretMeta }) {
  return <ScopeMark row={row} className="shrink-0 rounded border border-sol-border/70 px-1.5 py-[1px]" />;
}

/**
 * The head line of an agent's request, the same in the Vault and in the
 * conversation that asked: glyph, name (the caller's link or button), kind,
 * where it lands, the env vars it fills, and who asked when. The name is what
 * a person reads to decide, so it keeps its whole width (a name longer than
 * the line wraps, never truncates); the rest goes under it when the line is short. Before the row has synced only the glyph, name
 * and kind show, and `fallback` takes the asker's place. `compact`, for a
 * column too short for one line: the env vars go, and the asker moves under
 * the head where its session pill reads whole.
 */
export function RequestHead({ row, kind, name, fallback, compact = false }: { row?: SecretMeta; kind: SecretKind; name: ReactNode; fallback?: ReactNode; compact?: boolean }) {
  const asker = row && (
    <span className={`flex min-w-0 shrink items-center gap-1.5 text-[11.5px] text-sol-text-muted ${compact ? "mt-0.5 pl-[34px]" : "ml-auto"}`} data-vault-request-asker>
      {row.requested_from_conversation ? (
        <span className="min-w-0 truncate">
          <EntityIdPill id={row.requested_from_conversation} type="session" wide />
        </span>
      ) : (
        <span className="truncate">{row.requested_by_name ?? "Someone"}</span>
      )}
      <span className="shrink-0 tabular-nums text-sol-text-dim" title={formatFullTimestamp(row.updated_at)}>{formatRelativeTime(row.updated_at)}</span>
    </span>
  );
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <KindGlyph kind={kind} />
        <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5" data-vault-request-head>
          {name}
          <span className="flex min-w-0 flex-[1_1_15rem] items-center gap-2">
            <span className="shrink-0 text-[11.5px] text-sol-text-dim">{KIND[kind].short}</span>
            {row ? (
              <>
                <ScopeTag row={row} />
                {row.env?.length && !compact ? <span className="hidden min-w-0 truncate font-mono text-[11px] text-sol-text-dim sm:inline">{row.env.join(" ")}</span> : null}
                {compact ? null : asker}
              </>
            ) : fallback ? (
              <span className="ml-auto shrink-0">{fallback}</span>
            ) : null}
          </span>
        </div>
      </div>
      {compact ? asker : null}
    </>
  );
}
