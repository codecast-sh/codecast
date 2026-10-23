"use client";
// Pieces the Vault page, its detail panel and its add dialog share: the kind
// glyphs, the reveal hook that holds a value in component state only, a masked
// field with reveal and copy, a typing field that hides what is typed, the
// live 2FA code, the labeled row they all sit in, and a request's head line.
// Anything showing a value carries data-private, which keeps it out of the
// error replay's page outline (platform analytics replay.ts).

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, ChevronRight, Copy, Eye, EyeOff, FileText, Globe, KeyRound, UserRound, Users, type LucideIcon } from "lucide-react";
import { totp, type LoginPayload, type SecretKind, type SecretMeta, type SecretPayload } from "@codecast/shared/contracts/secrets";
import { useEventListener } from "../../hooks/useEventListener";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { EntityIdPill } from "../EntityIdPill";

export const KIND: Record<SecretKind, { icon: LucideIcon; tone: string; label: string }> = {
  key: { icon: KeyRound, tone: "var(--sol-yellow)", label: "Key" },
  login: { icon: UserRound, tone: "var(--sol-blue)", label: "Username and password" },
  file: { icon: FileText, tone: "var(--sol-violet)", label: "File" },
  signin: { icon: Globe, tone: "var(--sol-cyan)", label: "Browser sign-in" },
};

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

/** How long revealed text stays in memory with no reveal or copy touching it. */
export const REVEAL_IDLE_MS = 45_000;

/**
 * A secret's value, held in this component's state only (never the store). The
 * value fields drop after REVEAL_IDLE_MS without a reveal or copy, when the
 * window loses focus, and when the component goes or moves to another secret.
 * A login's 2FA seed stays for the component's life, so its code keeps ticking
 * while the panel is open; `seed` is undefined until fetched, null when the
 * login has none. Each fetch records a reveal on the server before the value
 * leaves it.
 */
export function useReveal(id: string) {
  const reveal = useAction(api.secrets.reveal);
  const [payload, setPayload] = useState<SecretPayload | null>(null);
  const [seed, setSeed] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<SecretPayload | null> | null>(null);
  // Bumped by every drop, so a fetch that lands after one is handed to its caller but not kept.
  const generation = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shownId = useRef(id);
  shownId.current = id;
  const drop = useCallback(() => {
    clearTimeout(idle.current);
    generation.current++;
    setPayload(null);
    inflight.current = null;
  }, []);
  const touch = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(drop, REVEAL_IDLE_MS);
  }, [drop]);
  useWatchEffect(() => {
    setSeed(undefined);
    setError(null);
    return drop;
  }, [id]);
  useEventListener("blur", drop);
  const load = useCallback(async (): Promise<SecretPayload | null> => {
    if (payload) {
      touch();
      return payload;
    }
    if (inflight.current) return inflight.current;
    const gen = generation.current;
    setLoading(true);
    setError(null);
    inflight.current = reveal({ ref: id })
      .then((res: any) => {
        if (res?.error) {
          setError(res.error);
          return null;
        }
        const p = res.payload as SecretPayload;
        // A blur mid-fetch keeps the seed; moving to another secret does not.
        if (id === shownId.current) setSeed((p as LoginPayload).totp_seed ?? null);
        if (gen === generation.current) {
          setPayload(p);
          touch();
        }
        return p;
      })
      .catch((err: Error) => {
        setError(err.message);
        return null;
      })
      .finally(() => {
        setLoading(false);
        if (gen === generation.current) inflight.current = null;
      });
    return inflight.current;
  }, [id, payload, reveal, touch]);
  return { payload, seed, error, loading, load, drop };
}

/** Copy text and show a check, or a refusal, for a moment. `get` may fetch the text first. */
export function CopyButton({ get, label = "Copy", className = "" }: { get: () => Promise<string | undefined> | string | undefined; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useMountEffect(() => () => clearTimeout(reset.current));
  const show = (next: "copied" | "failed") => {
    setState(next);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setState("idle"), 1400);
  };
  const copy = async () => {
    const text = await get();
    if (!text) return show("failed");
    await navigator.clipboard.writeText(text).then(
      () => show("copied"),
      () => show("failed"),
    );
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={label}
      aria-label={label}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${state === "copied" ? "text-sol-green" : state === "failed" ? "text-sol-red" : "text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"} ${className}`}
      data-vault-copy
    >
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
      {state === "copied" ? "Copied" : state === "failed" ? "Not copied" : null}
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
        <CopyButton get={() => text} label={text.includes("\n") ? "Copy commands" : "Copy command"} />
      </div>
      {open && <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-sol-border/70 bg-sol-bg-alt/50 px-2 py-1.5 font-mono text-[12px] leading-snug text-sol-text">{text}</pre>}
    </div>
  );
}

const DOTS = "••••••••••••";

/** One field of a secret: masked until the eye is pressed; copy works without showing it. */
export function MaskedField({
  label,
  value,
  load,
  hint,
  multiline,
  plain,
}: {
  label: string;
  /** The field's value once revealed, else undefined. */
  value: string | undefined;
  /** Fetches the payload and returns this field's value. */
  load: () => Promise<string | undefined>;
  /** What identifies it while masked (a fingerprint). */
  hint?: string;
  multiline?: boolean;
  /** Not secret (a username): shown as soon as it is loaded. */
  plain?: boolean;
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
  return (
    <Row
      label={label}
      data-vault-field={label}
      actions={
        <>
          {!(plain && value !== undefined) && (
            <button
              type="button"
              onClick={() => void toggle()}
              title={shown ? "Hide" : "Reveal"}
              aria-label={shown ? `Hide ${label}` : `Reveal ${label}`}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
              data-vault-reveal
            >
              {shown ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          )}
          <CopyButton get={load} label={`Copy ${label}`} />
        </>
      }
    >
      {visible ? (
        multiline ? (
          <pre data-private className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sol-bg-alt/60 px-2 py-1.5 font-mono text-[12px] text-sol-text">{value}</pre>
        ) : (
          <span data-private className="block select-all break-all pt-0.5 font-mono text-[12.5px] text-sol-text">{value}</span>
        )
      ) : (
        <span className="flex min-w-0 items-baseline gap-2 pt-0.5 font-mono text-[12.5px]">
          <span className="tracking-[0.15em] text-sol-text-dim">{DOTS}</span>
          {hint ? <span className="truncate text-[11px] text-sol-text-muted">{hint}</span> : null}
        </span>
      )}
    </Row>
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
}: {
  value: string;
  onChange: (v: string) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  placeholder?: string;
  autoFocus?: boolean;
  multiline?: boolean;
  name?: string;
}) {
  const [shown, setShown] = useState(false);
  const cls = "w-full min-w-0 rounded-md border border-sol-border bg-sol-bg px-2 py-1.5 font-mono text-[12.5px] text-sol-text outline-none placeholder:text-sol-text-dim focus:border-sol-yellow";
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
          // A file's text is masked by blurring it rather than by a password field, which can't hold lines.
          className={`${cls} resize-y pr-8 ${shown || !value ? "" : "text-transparent [text-shadow:0_0_6px_var(--sol-text-muted)]"}`}
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
          className={`${cls} pr-8`}
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

/** The 2FA row for a seed: the current code, ticking each second, with a ring that empties as it runs out, and copy in the actions column. */
export function TotpCode({ seed }: { seed: string }) {
  const [now, setNow] = useState(() => ({ code: "", remaining: 30, period: 30, refill: false }));
  const [broken, setBroken] = useState(false);
  useWatchEffect(() => {
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
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = now.remaining / now.period;
  const urgent = now.remaining <= 5;
  const tone = urgent ? "var(--sol-red)" : "var(--sol-green)";
  const half = Math.ceil(now.code.length / 2);
  return (
    <Row label="2FA code" actions={<CopyButton get={() => now.code} label="Copy code" />}>
      <span className="-mt-0.5 inline-flex items-center gap-2" data-vault-totp>
        <span data-private className="font-mono text-[17px] font-semibold tabular-nums tracking-[0.08em]" style={{ color: urgent ? "var(--sol-red)" : "var(--sol-text)", transition: "color 150ms ease-out" }}>
          {now.code ? `${now.code.slice(0, half)} ${now.code.slice(half)}` : "··· ···"}
        </span>
        <svg width={20} height={20} viewBox="0 0 20 20" aria-label={`${now.remaining} seconds left`} className="-rotate-90">
          <circle cx={10} cy={10} r={r} fill="none" stroke="var(--sol-border)" strokeWidth={2.5} />
          <circle cx={10} cy={10} r={r} fill="none" stroke={tone} strokeWidth={2.5} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" style={{ transition: now.refill ? "none" : "stroke-dashoffset 1s linear" }} />
        </svg>
        <span className="w-5 text-[11px] tabular-nums text-sol-text-dim">{now.remaining}s</span>
      </span>
    </Row>
  );
}

/**
 * A labeled row in the detail panel or the add form. `actions` adds a trailing
 * column (reveal, copy) that lines up across rows; `align="input"` drops the
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
      {actions ? <span className="flex items-center gap-0.5">{actions}</span> : null}
    </div>
  );
}

/** Where a secret lands, said the same on a request card and a row: every agent in the team, or only yours. */
export function ScopeMark({ row, teamName, className = "" }: { row: SecretMeta; teamName?: string; className?: string }) {
  const team = row.workspace.startsWith("team:");
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 text-[11px] text-sol-text-muted ${className}`} title={team ? "Every agent in the team" : "Only you and your agents"} data-vault-scope-mark={team ? "team" : "personal"}>
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
 * where it lands, the env vars it fills, and who asked when. Before the row
 * has synced only the glyph, name and kind show, and `fallback` takes the
 * asker's place.
 */
export function RequestHead({ row, kind, name, fallback }: { row?: SecretMeta; kind: SecretKind; name: ReactNode; fallback?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <KindGlyph kind={kind} />
      {name}
      <span className="shrink-0 text-[11.5px] text-sol-text-dim">{KIND[kind].label}</span>
      {row ? (
        <>
          <ScopeTag row={row} />
          {row.env?.length ? <span className="hidden min-w-0 truncate font-mono text-[11px] text-sol-text-dim sm:inline">{row.env.join(" ")}</span> : null}
          <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 text-[11.5px] text-sol-text-muted">
            {row.requested_from_conversation ? (
              <span className="min-w-0 truncate">
                <EntityIdPill id={row.requested_from_conversation} type="session" />
              </span>
            ) : (
              <span className="truncate">{row.requested_by_name ?? "Someone"}</span>
            )}
            <span className="shrink-0 tabular-nums text-sol-text-dim" title={formatFullTimestamp(row.updated_at)}>{formatRelativeTime(row.updated_at)}</span>
          </span>
        </>
      ) : fallback ? (
        <span className="ml-auto shrink-0">{fallback}</span>
      ) : null}
    </div>
  );
}
