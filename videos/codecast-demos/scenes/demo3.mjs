// 03 · Fork & Spawn — parallelize. Beats map 1:1 to vo/demo3.timing.json.
export default {
  id: "demo3",
  audio: "../vo/demo3.wav",
  introTitle: "Branch & Parallelize",
  introSub: "Fork one conversation, or spawn many — explore every direction at once",
  badge: "03 · Fork & Spawn",
  outroTitle: "Codecast",
  outroSub: "Stop picking one path. Run them all.",
  images: {
    fork: "../assets/term-fork.png",
    spawn: "../assets/term-spawn.png",
    sessions: "../assets/sessions.png",
  },
  beats: [
    { img: "fork", tgt: [0.37, 0.50, 1.05] },
    { img: "fork", tgt: [0.37, 0.52, 1.45], spot: [0.115, 0.47, 0.53, 0.20], spotLabel: "3 branches" },
    { img: "spawn", tgt: [0.37, 0.50, 1.38], spot: [0.115, 0.46, 0.53, 0.17], spotLabel: "cast spawn" },
    { img: "spawn", tgt: [0.37, 0.56, 1.62] },
    { img: "sessions", tgt: [0.17, 0.145, 1.85], spot: [0.012, 0.055, 0.44, 0.15], spotLabel: "64 live sessions" },
    { img: "sessions", tgt: [0.22, 0.55, 1.12] },
  ],
};
