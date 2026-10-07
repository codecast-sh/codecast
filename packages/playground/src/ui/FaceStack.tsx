import { useEffect, useRef, useState } from "react";
import { Face, type Person } from "./Face";
import s from "./FaceStack.module.css";

const ARRIVE_MS = 320;
const LEAVE_MS = 150;

/** Overlapping faces, each ringed in the color behind them (`--ring`), then
 *  "+N". Someone arriving fades up, someone leaving fades out, and a new
 *  `hop` (the go-live moment) makes everyone hop once, staggered. */
export function FaceStack({ people, max = 4, size = 24, typing, hop = 0 }: { people: Person[]; max?: number; size?: number; typing?: Set<string>; hop?: number }) {
  const shown = useComings(people.slice(0, max));
  const rest = people.length - Math.min(people.length, max);
  // Hop for a go-live that happens while mounted, not one from before.
  const [mountedAt] = useState(hop);
  const hopping = hop !== mountedAt;
  return (
    <span className={s.stack} data-hop={hopping || undefined} key={hopping ? hop : 0}>
      {shown.map(({ person: p, phase }, i) => (
        <span key={p.id} className={`${s.slot} ${phase ? s[phase] : ""}`} style={{ animationDelay: phase ? undefined : `${i * 50}ms` }}>
          <Face person={p} size={size} typing={typing?.has(p.id)} />
        </span>
      ))}
      {rest > 0 && <span className={s.more}>+{rest}</span>}
    </span>
  );
}

type Shown = { person: Person; phase: "arriving" | "leaving" | null };

/** The faces to draw: who is here, newcomers marked for a beat, and who just
 *  left kept where they were until they have glided out. Whoever is here on
 *  the first render is simply here. */
function useComings(people: Person[]): Shown[] {
  const [, rerender] = useState(0);
  const arrived = useRef<Map<string, number> | null>(null);
  const leaving = useRef(new Map<string, { person: Person; at: number; index: number }>());
  const last = useRef<Person[]>(people);

  const now = Date.now();
  if (!arrived.current) arrived.current = new Map(people.map((p) => [p.id, 0]));
  const ids = new Set(people.map((p) => p.id));
  for (const p of people) {
    if (!arrived.current.has(p.id)) arrived.current.set(p.id, now);
    leaving.current.delete(p.id);
  }
  last.current.forEach((p, index) => {
    if (!ids.has(p.id) && !leaving.current.has(p.id)) leaving.current.set(p.id, { person: p, at: now, index });
  });
  for (const [id] of arrived.current) if (!ids.has(id)) arrived.current.delete(id);
  for (const [id, l] of leaving.current) if (now - l.at >= LEAVE_MS) leaving.current.delete(id);
  last.current = people;

  // Clear the marks once their motion is over.
  const pending = leaving.current.size > 0 || [...arrived.current.values()].some((t) => now - t < ARRIVE_MS);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => rerender((n) => n + 1), LEAVE_MS);
    return () => clearTimeout(t);
  });

  const out: Shown[] = people.map((p) => ({ person: p, phase: now - (arrived.current!.get(p.id) ?? 0) < ARRIVE_MS ? "arriving" : null }));
  for (const l of [...leaving.current.values()].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(l.index, out.length), 0, { person: l.person, phase: "leaving" });
  }
  return out;
}
