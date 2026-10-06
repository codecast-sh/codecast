import s from "./Spinner.module.css";

/** The orbiting paper disc with a tomato dot: work in progress. */
export function Spinner({ size = 26 }: { size?: number }) {
  return <span className={s.spin} style={{ width: size, height: size }} aria-hidden />;
}
