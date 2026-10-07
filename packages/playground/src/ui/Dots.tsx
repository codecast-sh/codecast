import s from "./Dots.module.css";

/** Three hopping dots in the current color: someone is typing, or the shell is reconnecting. */
export function Dots({ size = 4 }: { size?: number }) {
  return (
    <span className={s.dots} style={{ ["--d" as string]: `${size}px` }} aria-hidden>
      <i /><i /><i />
    </span>
  );
}
