import s from "./Dots.module.css";

/** Three hopping dots: someone is typing, or the shell is reconnecting. */
export function Dots({ size = 6, light = false }: { size?: number; light?: boolean }) {
  return (
    <span className={`${s.dots} ${light ? s.light : ""}`} style={{ ["--d" as string]: `${size}px` }} aria-hidden>
      <i /><i /><i />
    </span>
  );
}
