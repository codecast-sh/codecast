"use client";
// Pieces the Vault page, its detail panel and its add dialog share: the kind
// glyphs, the reveal hook that holds a value in component state only, a masked
// field with reveal and copy, a typing field that hides what is typed, and the
// live 2FA code.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, Copy, Eye, EyeOff, FileText, Globe, KeyRound, UserRound, type LucideIcon } from "lucide-react";
import { totp, type SecretKind, type SecretPayload } from "@codecast/shared/contracts/secrets";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export const KIND: Record<SecretKind, { icon: LucideIcon; tone: string; label: string }> = {
  key: { icon: KeyRound, tone: "var(--sol-yellow)", label: "Key" },
  login: { icon: UserRound, tone: "var(--sol-blue)", label: "Login" },
  file: { icon: FileText, tone: "var(--sol-violet)", label: "File" },
  signin: { icon: Globe, tone: "var(--sol-cyan)", label: "Sign-in" },
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

/** How long a revealed value stays in memory after it was fetched. */
const REVEAL_MS = 45_000;

/**
 * A secret's value, held in this component's state only (never the store), and
 * dropped after REVEAL_MS, when the window loses focus, or when the component
 * goes. Each fetch records a reveal on the server before the value leaves it.
 */
export function useReveal(id: string) {
  const reveal = useAction(api.secrets.reveal);
  const [payload, setPayload] = useState<SecretPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<SecretPayload | null> | null>(null);
  const drop = useCallback(() => {
    setPayload(null);
    inflight.current = null;
  }, []);
  useWatchEffect(() => {
    drop();
    setError(null);
  }, [id]);
  useWatchEffect(() => {
    if (!payload) return;
    const t = setTimeout(drop, REVEAL_MS);
    return () => clearTimeout(t);
  }, [payload]);
  useEventListener("blur", drop);
  const load = useCallback(async (): Promise<SecretPayload | null> => {
    if (payload) return payload;
    if (inflight.current) return inflight.current;
    setLoading(true);
    setError(null);
    inflight.current = reveal({ ref: id })
      .then((res: any) => {
        if (res?.error) {
          setError(res.error);
          return null;
        }
        setPayload(res.payload);
        return res.payload as SecretPayload;
      })
      .catch((err: Error) => {
        setError(err.message);
        return null;
      })
      .finally(() => {
        setLoading(false);
        inflight.current = null;
      });
    return inflight.current;
  }, [id, payload, reveal]);
  return { payload, error, loading, load, drop };
}

/** Copy text and show a check for a moment. `get` may fetch the text first. */
export function CopyButton({ get, label = "Copy", className = "" }: { get: () => Promise<string | undefined> | string | undefined; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    const text = await get();
    if (!text) return setState("failed");
    await navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
    setTimeout(() => setState("idle"), 1400);
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
  const visible = value !== undefined && (shown || plain);
  const toggle = async () => {
    if (shown) return setShown(false);
    if ((await load()) !== undefined) setShown(true);
  };
  return (
    <div className="group/field grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-start gap-x-3 py-1.5" data-vault-field={label}>
      <span className="pt-0.5 text-[12px] text-sol-text-dim">{label}</span>
      {visible ? (
        multiline ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sol-bg-alt/60 px-2 py-1.5 font-mono text-[12px] text-sol-text">{value}</pre>
        ) : (
          <span className="select-all break-all pt-0.5 font-mono text-[12.5px] text-sol-text">{value}</span>
        )
      ) : (
        <span className="flex min-w-0 items-baseline gap-2 pt-0.5 font-mono text-[12.5px]">
          <span className="tracking-[0.15em] text-sol-text-dim">{DOTS}</span>
          {hint ? <span className="truncate text-[11px] text-sol-text-muted">{hint}</span> : null}
        </span>
      )}
      <span className="flex items-center gap-0.5">
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
      </span>
    </div>
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

/** The current 2FA code for a seed, ticking each second, with a ring that empties as it runs out. Click copies. */
export function TotpCode({ seed }: { seed: string }) {
  const [now, setNow] = useState(() => ({ code: "", remaining: 30, period: 30 }));
  const [broken, setBroken] = useState(false);
  useWatchEffect(() => {
    let alive = true;
    const tick = () =>
      totp(seed).then(
        (r) => alive && setNow(r),
        () => alive && setBroken(true),
      );
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [seed]);
  if (broken) return <span className="text-[12px] text-sol-red">Seed unreadable: rotate it</span>;
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = now.remaining / now.period;
  const urgent = now.remaining <= 5;
  const tone = urgent ? "var(--sol-red)" : "var(--sol-green)";
  const half = Math.ceil(now.code.length / 2);
  return (
    <span className="inline-flex items-center gap-2" data-vault-totp>
      <span className="font-mono text-[17px] font-semibold tabular-nums tracking-[0.08em]" style={{ color: urgent ? "var(--sol-red)" : "var(--sol-text)" }}>
        {now.code ? `${now.code.slice(0, half)} ${now.code.slice(half)}` : "··· ···"}
      </span>
      <svg width={20} height={20} viewBox="0 0 20 20" aria-label={`${now.remaining} seconds left`} className="-rotate-90">
        <circle cx={10} cy={10} r={r} fill="none" stroke="var(--sol-border)" strokeWidth={2.5} />
        <circle cx={10} cy={10} r={r} fill="none" stroke={tone} strokeWidth={2.5} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s linear" }} />
      </svg>
      <span className="w-5 text-[11px] tabular-nums text-sol-text-dim">{now.remaining}s</span>
      <CopyButton get={() => now.code} label="Copy code" />
    </span>
  );
}

/** A labeled row in the detail panel or the add form. */
export function Row({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 py-1.5 ${className}`}>
      <span className="pt-1 text-[12px] text-sol-text-dim">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
