import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";
import s from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "paper" | "make" | "live" | "fork" | "ink";
  size?: "sm" | "md" | "lg";
  busy?: boolean;
};

/** A chunky toy button that squashes into its shadow when pressed. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "paper", size = "md", busy = false, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`${s.btn} ${s[variant]} ${s[size]} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Spinner size={size === "lg" ? 26 : 18} />}
      {children}
    </button>
  );
});

/** A square tool button with an icon and a label for screen readers. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number }>(
  function IconButton({ label, size = 36, className = "", children, ...rest }, ref) {
    return (
      <button ref={ref} className={`${s.icon} ${className}`} style={{ width: size, height: size }} aria-label={label} title={label} {...rest}>
        {children}
      </button>
    );
  },
);
