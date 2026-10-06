import s from "./Blob.module.css";

/** Clay: a tomato squircle with two ink eyes. The brand mark and the builder's face. */
export function Blob({ size = 46, wobble = false, squash = false, down = false, className = "" }: { size?: number; wobble?: boolean; squash?: boolean; down?: boolean; className?: string }) {
  return (
    <span
      className={`${s.blob} ${wobble ? s.wobble : ""} ${squash ? s.squash : ""} ${down ? s.down : ""} ${className}`}
      style={{ width: size, height: size, ["--u" as string]: `${size / 46}` }}
      aria-hidden
    />
  );
}
