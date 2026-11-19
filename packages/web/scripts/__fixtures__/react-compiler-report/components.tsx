// Fixture components for scripts/react-compiler-report.test.ts. Never imported by the app.
import { useCallback } from "react";
import { useForwardedAge, useFormatters, useFrozenAge, useMovingAge, usePair, useRowReader } from "./hooks";

export function Frozen({ ts }: { ts: number }) {
  const age = useFrozenAge();
  return <span>{age(ts)}</span>;
}

export function Moving({ ts }: { ts: number }) {
  const age = useMovingAge();
  return <span>{age(ts)}</span>;
}

export function FromObject({ ts }: { ts: number }) {
  const { age, name } = useFormatters();
  return <span>{age(ts)}{name(" x ")}</span>;
}

export function FromMember({ ts }: { ts: number }) {
  const format = useFormatters();
  return <span>{format.age(ts)}</span>;
}

export function FromArray({ ts }: { ts: number }) {
  const [age] = usePair();
  return <span>{age(ts)}</span>;
}

export function Forwarded({ ts }: { ts: number }) {
  const age = useForwardedAge();
  return <span>{age(ts)}</span>;
}

export function InHandler({ ts, onAge }: { ts: number; onAge: (age: string) => void }) {
  const age = useFrozenAge();
  return <button onClick={() => onAge(age(ts))}>age</button>;
}

export function LocalCallback({ ts }: { ts: number }) {
  const age = useCallback((t: number) => String(Date.now() - t), []);
  return <span>{age(ts)}</span>;
}

export function StoreRow({ id }: { id: string }) {
  const read = useRowReader();
  return <span>{read(id)}</span>;
}
