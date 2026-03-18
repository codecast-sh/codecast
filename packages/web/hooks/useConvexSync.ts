import { useEffect } from "react";

export function useConvexSync<T>(data: T | undefined, sync: (data: T) => void): void {
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (data !== undefined) sync(data);
  }, [data, sync]); // eslint-disable-line react-hooks/exhaustive-deps
}
