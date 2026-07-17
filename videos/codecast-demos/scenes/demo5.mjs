// 05 · Triggers & Workflows — async + orchestration. Beats map 1:1 to vo/demo5.timing.json.
export default {
  id: "demo5",
  audio: "../vo/demo5.wav",
  introTitle: "Agents That Never Sleep",
  introSub: "Triggers and workflows — running on their own, at scale",
  badge: "05 · Triggers & Workflows",
  outroTitle: "Codecast",
  outroSub: "Command your agents — even when you're not there.",
  images: {
    triggers: "../assets/triggers.png",
    workflows: "../assets/workflows.png",
  },
  beats: [
    { img: "triggers", tgt: [0.22, 0.50, 1.05] },
    { img: "triggers", tgt: [0.20, 0.165, 1.45], spot: [0.012, 0.115, 0.42, 0.055], spotLabel: "10 active" },
    { img: "triggers", tgt: [0.21, 0.315, 1.7], spot: [0.016, 0.268, 0.41, 0.088], spotLabel: "Next 24 hours" },
    { img: "triggers", tgt: [0.21, 0.62, 1.55] },
    { img: "workflows", tgt: [0.35, 0.42, 1.10] },
    { img: "workflows", tgt: [0.30, 0.175, 1.55], spot: [0.018, 0.115, 0.72, 0.06], spotLabel: "104 agents" },
    { img: "workflows", tgt: [0.35, 0.45, 1.05] },
  ],
};
