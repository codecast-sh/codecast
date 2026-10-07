import s from "./Spinner.module.css";

/** A 13px ring turning: Clay is at work (DESIGN 4.4). */
export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`${s.spin} ${className}`} aria-hidden />;
}
