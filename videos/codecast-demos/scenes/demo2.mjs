// 02 · Messaging — talk to your fleet. Beats map 1:1 to vo/demo2.timing.json.
export default {
  id: "demo2",
  audio: "../vo/demo2.wav",
  introTitle: "Talk to Your Fleet",
  introSub: "Message any session like a teammate — boss or peer",
  badge: "02 · Messaging",
  outroTitle: "Codecast",
  outroSub: "Your whole fleet. One conversation.",
  images: {
    inbox: "../assets/inbox.png",
    send: "../assets/term-send.png",
    feed: "../assets/feed.png",
  },
  beats: [
    { img: "inbox", tgt: [0.52, 0.50, 1.02] },
    { img: "send", tgt: [0.37, 0.39, 1.35], spot: [0.115, 0.345, 0.53, 0.075], spotLabel: "cast send" },
    { img: "send", tgt: [0.37, 0.55, 1.42], spot: [0.115, 0.465, 0.53, 0.17], spotLabel: "Reply" },
    { img: "inbox", tgt: [0.855, 0.345, 2.0], spot: [0.708, 0.305, 0.286, 0.07], spotLabel: "Resumes" },
    { img: "inbox", tgt: [0.855, 0.55, 1.55] },
    { img: "feed", tgt: [0.34, 0.44, 1.14] },
    { img: "feed", tgt: [0.30, 0.30, 1.55] },
  ],
};
