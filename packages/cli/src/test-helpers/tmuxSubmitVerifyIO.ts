import type { TmuxSubmitVerifyIO } from "../daemon.js";

// The prompt both verifier test files paste.
export const PROMPT = "settings ui looks like crap - also it is";

// Builds an IO whose capture() walks through `frames` (sticking on the last),
// recording every action the loop takes. `extra` adds the optional evidence
// sources; a pane with none of them is the shape the pane-reading tests use.
export function scriptedIO(frames: string[], extra: Partial<TmuxSubmitVerifyIO> = {}) {
  const actions: string[] = [];
  let i = 0;
  const io: TmuxSubmitVerifyIO = {
    capture: async () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i++;
      return frame;
    },
    sendEnter: async () => {
      actions.push("enter");
    },
    rePaste: async () => {
      actions.push("repaste");
    },
    sleep: async () => {},
    log: () => {},
  };
  return { io: { ...io, ...extra }, actions };
}
