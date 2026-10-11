import { forwardRef, type ButtonHTMLAttributes } from "react";
import { useOffline, WAITING_AFTER_MS } from "../lib/connection";
import { Spinner } from "./Spinner";
import s from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "quiet" | "text" | "ink" | "accent";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
};

/** A plain button (DESIGN 5): quiet, text, ink (the neutral primary) or
 *  accent (starts Clay's work). Press nudges it down a pixel. Busy, it spins;
 *  busy through a long connection drop, it says what it is waiting for. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "quiet", size = "sm", busy = false, className = "", children, disabled, ...rest },
  ref,
) {
  const stalled = useOffline(WAITING_AFTER_MS) && busy;
  return (
    <button ref={ref} className={`${s.btn} ${s[variant]} ${s[size]} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner className={s.spinner} />}
      {stalled ? "Waiting for connection" : children}
    </button>
  );
});

/** A square tool button with an icon and a label for screen readers. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number }>(
  function IconButton({ label, size = 30, className = "", children, ...rest }, ref) {
    return (
      <button ref={ref} className={`${s.icon} ${className}`} style={{ width: size, height: size }} aria-label={label} title={label} {...rest}>
        {children}
      </button>
    );
  },
);
