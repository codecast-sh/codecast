import { Face, type Person } from "./Face";
import s from "./FaceStack.module.css";

/** Overlapping faces, then "+N" for the rest. */
export function FaceStack({ people, max = 4, size = 30, typing, hop = 0 }: { people: Person[]; max?: number; size?: number; typing?: Set<string>; hop?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className={s.stack} style={{ ["--size" as string]: `${size}px` }} data-hop={hop || undefined} key={hop}>
      {shown.map((p, i) => (
        <span key={p.id} className={s.slot} style={{ animationDelay: `${i * 40}ms` }}>
          <Face person={p} size={size} typing={typing?.has(p.id)} />
        </span>
      ))}
      {rest > 0 && <span className={s.more}>+{rest}</span>}
    </span>
  );
}
