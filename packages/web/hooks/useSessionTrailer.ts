import { useMemo } from "react";
import { splitSessionTrailer } from "@codecast/shared/blame";

/** The message without its Codecast-Session trailer, and the session it names
 *  (the same parser the server trusts takes the line out). */
export function useSessionTrailer(message: string | null | undefined) {
  return useMemo(() => splitSessionTrailer(message), [message]);
}
