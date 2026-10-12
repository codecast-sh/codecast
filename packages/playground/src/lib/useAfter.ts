import { useEffect, useState } from "react";

/** False until `ms` after mount, then true: for states that should only
 *  show when something is slow. */
export function useAfter(ms: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPast(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return past;
}
