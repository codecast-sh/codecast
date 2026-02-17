import { useQuery } from "convex/react";
import { useEffect } from "react";
import { getCached, setCached } from "../store/queryCache";

const fnNameSym = Symbol.for("functionName");

export function queryCacheKey(query: any, args: any): string {
  const name: string = query?.[fnNameSym] ?? "unknown";
  return `${name}::${JSON.stringify(args)}`;
}

export function useCachedQuery<T = any>(
  query: any,
  args: any
): T | undefined {
  const skip = args === "skip";
  const key = skip ? "" : queryCacheKey(query, args);
  const cached = skip ? undefined : getCached<T>(key);
  const live = useQuery(query, args);

  useEffect(() => {
    if (live !== undefined && !skip) {
      setCached(key, live);
    }
  }, [live, key, skip]);

  return live !== undefined ? live : cached;
}
