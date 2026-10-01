/**
 * Chapter 7, Track (40 to 47s): the lead files a task from the conversation;
 * it falls onto the board, an agent claims it, and the plan advances.
 */

import { TaskBoard, TaskFiled, TaskFlyer } from "./work";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "work",
  parts: [
    { key: "files", region: "desk.transcript", order: 40, Component: TaskFiled },
    { key: "board", region: "board.main", order: 0, Component: TaskBoard },
  ],
  flyers: {
    "work.task": TaskFlyer,
  },
};
