// The App Store set, in listing order. `screen` names the capture in raw/
// (raw/<device>-<screen>.png), `ipad` overrides it on iPad, and `devices`
// limits a shot to the devices whose screen fills it (the iPad app runs the
// phone layout at full width, so a short transcript leaves it mostly empty).
// `[word]` in a title is set on the accent block.
export const SHOTS = {
  inbox: {
    screen: "inbox",
    accent: "blue",
    title: "Every agent, [one] inbox",
    sub: "Sorted by who acts next.",
  },
  answer: {
    screen: "answer",
    devices: ["iphone"],
    accent: "green",
    title: "Answer agents from [anywhere]",
    sub: "They wait on you, not on your laptop.",
  },
  huddle: {
    screen: "huddle",
    devices: ["iphone"],
    accent: "cyan",
    title: "Huddle with your [team]",
    sub: "Voice huddles with live captions.",
  },
  chat: {
    screen: "chat",
    ipad: "chatlist",
    accent: "violet",
    title: "People and agents, one [chat]",
    sub: "Channels where agents answer too.",
  },
  tasks: {
    screen: "tasks",
    accent: "orange",
    title: "Know where the [work] stands",
    sub: "Tasks your agents report to.",
  },
  lock: {
    screen: "lock",
    accent: "magenta",
    title: "Follow along from the [Lock Screen]",
    sub: "What's working, and what waits on you.",
  },
};
