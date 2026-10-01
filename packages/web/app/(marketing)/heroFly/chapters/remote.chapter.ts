/**
 * Chapter 13, Anywhere (82.3 to 88.8s): the API worker, running on a cloud
 * host, is opened from its inbox row beside the laptop's sessions, and its
 * conversation shows it driving a browser there. Views in ./remote.tsx, fed
 * by ../fixtures/remote.ts.
 */

import { WorkerHeader, WorkerTail } from "./remote";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "remote",
  parts: [
    { key: "header", region: "desk.header", order: 10, Component: WorkerHeader },
    { key: "tail", region: "desk.transcript", order: 60, Component: WorkerTail },
  ],
};
