// 04 · Tasks & Plans — structured work. Beats map 1:1 to vo/demo4.timing.json.
export default {
  id: "demo4",
  audio: "../vo/demo4.wav",
  introTitle: "Structured Work",
  introSub: "Turn loose sessions into tasks and plans you can follow",
  badge: "04 · Tasks & Plans",
  outroTitle: "Codecast",
  outroSub: "A thousand messages become one clear board.",
  images: { tasks: "../assets/tasks.png" },
  beats: [
    { img: "tasks", tgt: [0.30, 0.50, 1.02] },
    { img: "tasks", tgt: [0.30, 0.40, 1.22] },
    { img: "tasks", tgt: [0.28, 0.205, 1.78], spot: [0.012, 0.135, 0.57, 0.095], spotLabel: "Tasks" },
    { img: "tasks", tgt: [0.30, 0.29, 1.9], spot: [0.012, 0.25, 0.56, 0.06], spotLabel: "Plan" },
    { img: "tasks", tgt: [0.20, 0.52, 1.4], spot: [0.012, 0.53, 0.30, 0.05], spotLabel: "By owner" },
    { img: "tasks", tgt: [0.30, 0.50, 1.0] },
  ],
};
