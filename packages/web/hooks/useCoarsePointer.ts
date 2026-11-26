import { useMediaQuery } from "./useMediaQuery";

/** The main pointer is a finger: no hover, no Shift key, so anything that
 *  needs either offers a press and hold instead. */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
