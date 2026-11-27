import { useRef } from "react";
import { useWatchEffect } from "./useWatchEffect";

/** Run `fn` each time a store request counter moves past the value this
 *  component mounted with. The counter is how a store asks a page to do
 *  something only the page owns (open its tree, its side panel); a request
 *  made before the page mounted is not replayed. */
export function useOnRequest(request: number, fn: () => void): void {
  const seen = useRef(request);
  useWatchEffect(() => {
    if (seen.current === request) return;
    seen.current = request;
    fn();
  }, [request]);
}
