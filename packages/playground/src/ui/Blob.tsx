import s from "./Blob.module.css";

/** Clay's face: a persimmon squircle with two dark eyes (DESIGN 2). */
export function Blob({ size = 22, down = false, faint = false, className = "" }: { size?: number; down?: boolean; faint?: boolean; className?: string }) {
  return (
    <span
      className={`${s.blob} ${down ? s.down : ""} ${faint ? s.faint : ""} ${className}`}
      style={{ width: size, height: size, ["--size" as string]: `${size}px` }}
      aria-hidden
    />
  );
}
