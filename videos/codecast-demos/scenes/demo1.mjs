// 01 · The Inbox — mission control. Beats map 1:1 to vo/demo1.timing.json.
export default {
  id: "demo1",
  audio: "../vo/demo1.wav",
  introTitle: "Mission Control",
  introSub: "Your entire agent fleet — in one command center",
  badge: "01 · The Inbox",
  outroTitle: "Codecast",
  outroSub: "Every agent. One screen. Nothing slips.",
  images: { inbox: "../assets/inbox.png" },
  beats: [
    { img: "inbox", tgt: [0.52, 0.50, 1.02] },
    { img: "inbox", tgt: [0.80, 0.50, 1.18] },
    { img: "inbox", tgt: [0.855, 0.27, 1.70], spot: [0.706, 0.255, 0.288, 0.055], spotLabel: "Needs input" },
    { img: "inbox", tgt: [0.855, 0.55, 1.62] },
    { img: "inbox", tgt: [0.845, 0.345, 1.95], spot: [0.706, 0.305, 0.288, 0.075], spotLabel: "One session" },
    { img: "inbox", tgt: [0.80, 0.075, 1.75], spot: [0.706, 0.05, 0.29, 0.052], spotLabel: "Projects" },
    { img: "inbox", tgt: [0.52, 0.50, 1.0] },
  ],
};
