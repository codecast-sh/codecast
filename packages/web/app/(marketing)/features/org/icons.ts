// Drawn role icons, exported from real roles (cast role ls --json). Each is the
// validated shape list roleIconSvg draws; the page pairs them with its own
// illustrative role titles.
import type { RoleIcon } from "@codecast/shared/contracts/roleIcon";

export const ICONS = {
  "org chart": {
    "accent": "orange",
    "concept": "org chart",
    "shapes": [
      {"height": 5, "rx": 2, "t": "rect", "width": 6, "x": 9, "y": 3},
      {"height": 5, "rx": 2, "t": "rect", "width": 6, "x": 3, "y": 16},
      {"height": 5, "rx": 2, "t": "rect", "width": 6, "x": 15, "y": 16},
      {"d": "M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2", "t": "path"}
    ],
    "v": 1
  },
  "rising trend": {
    "accent": "violet",
    "concept": "rising trend",
    "shapes": [
      {"d": "M3 3v18h18", "t": "path"},
      {"points": [7, 15, 11, 11, 14, 14, 20, 8], "t": "polyline"},
      {"points": [16, 8, 20, 8, 20, 12], "t": "polyline"}
    ],
    "v": 1
  },
  "envelope": {
    "accent": "magenta",
    "concept": "envelope",
    "shapes": [
      {"height": 13, "rx": 2.5, "t": "rect", "width": 18, "x": 3, "y": 5.5},
      {"d": "M3.5 7.5l8.5 6 8.5-6", "t": "path"}
    ],
    "v": 1
  },
  "megaphone": {
    "accent": "red",
    "concept": "megaphone",
    "shapes": [
      {"d": "M4 9.5h3l9-5v15l-9-5H4z", "t": "path"},
      {"d": "M8 15v3.5a1.5 1.5 0 0 0 3 0v-1.8", "t": "path"},
      {"d": "M19 9a4 4 0 0 1 0 6", "t": "path"}
    ],
    "v": 1
  },
  "clipboard check": {
    "accent": "blue",
    "concept": "clipboard check",
    "shapes": [
      {"height": 16.5, "rx": 2.5, "t": "rect", "width": 14, "x": 5, "y": 4.5},
      {"height": 3.5, "rx": 1.5, "t": "rect", "width": 6, "x": 9, "y": 3},
      {"points": [8.5, 13.5, 11, 16, 15.5, 11], "t": "polyline"}
    ],
    "v": 1
  },
  "phone handset": {
    "accent": "red",
    "concept": "phone handset",
    "shapes": [
      {"d": "M21 16.43v2.7a1.8 1.8 0 0 1-1.96 1.8 17.8 17.8 0 0 1-7.77-2.76 17.55 17.55 0 0 1-5.4-5.4 17.8 17.8 0 0 1-2.76-7.8A1.8 1.8 0 0 1 4.9 3h2.7a1.8 1.8 0 0 1 1.8 1.55 11.56 11.56 0 0 0 .63 2.53 1.8 1.8 0 0 1-.4 1.9L8.48 10.12a14.4 14.4 0 0 0 5.4 5.4l1.14-1.14a1.8 1.8 0 0 1 1.9-.4 11.56 11.56 0 0 0 2.53.63A1.8 1.8 0 0 1 21 16.43z", "t": "path"}
    ],
    "v": 1
  },
  "padlock": {
    "accent": "orange",
    "concept": "padlock",
    "shapes": [
      {"height": 10, "rx": 2.5, "t": "rect", "width": 14, "x": 5, "y": 11},
      {"d": "M8 11V7.5a4 4 0 0 1 8 0V11", "t": "path"},
      {"cx": 12, "cy": 15.5, "fill": true, "r": 1.5, "t": "circle"},
      {"d": "M12 16v2", "t": "path"}
    ],
    "v": 1
  },
  "briefcase": {
    "accent": "cyan",
    "concept": "briefcase",
    "shapes": [
      {"height": 13, "rx": 2.5, "t": "rect", "width": 18, "x": 3, "y": 7},
      {"d": "M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7", "t": "path"},
      {"d": "M3 13h7M14 13h7", "t": "path"},
      {"height": 3, "rx": 1, "t": "rect", "width": 4, "x": 10, "y": 11.5}
    ],
    "v": 1
  },
  "mailbox": {
    "accent": "violet",
    "concept": "mailbox",
    "shapes": [
      {"d": "M7.5 4.5H17a4 4 0 0 1 4 4v6H3V9a4.5 4.5 0 0 1 4.5-4.5z", "t": "path"},
      {"d": "M12 14.5V9a4.5 4.5 0 0 0-4.5-4.5", "t": "path"},
      {"d": "M16.5 14.5V20", "t": "path"},
      {"d": "M15 11V8h3", "t": "path"}
    ],
    "v": 1
  },
  "rocket launch": {
    "accent": "red",
    "concept": "rocket launch",
    "shapes": [
      {"d": "M12 3C9.5 5 8.5 8 8.5 11v5h7v-5c0-3-1-6-3.5-8z", "t": "path"},
      {"d": "M8.5 12.5L6 15v3l2.5-2", "t": "path"},
      {"d": "M15.5 12.5L18 15v3l-2.5-2", "t": "path"},
      {"cx": 12, "cy": 9.5, "r": 1.75, "t": "circle"},
      {"d": "M12 18.5V21", "t": "path"}
    ],
    "v": 1
  },
  "warning triangle": {
    "accent": "yellow",
    "concept": "warning triangle",
    "shapes": [
      {"d": "M12 4L21 20H3z", "t": "path"},
      {"t": "line", "x1": 12, "x2": 12, "y1": 9.5, "y2": 13.5},
      {"cx": 12, "cy": 16.8, "fill": true, "r": 1.2, "t": "circle"}
    ],
    "v": 1
  },
  "funnel": {
    "accent": "blue",
    "concept": "funnel",
    "shapes": [
      {"d": "M3 4h18l-7 8.5V19l-4 2v-8.5z", "t": "path"},
      {"d": "M6.3 8h11.4", "t": "path"}
    ],
    "v": 1
  },
  "speed gauge": {
    "accent": "cyan",
    "concept": "speed gauge",
    "shapes": [
      {"d": "M5.6 19.4A9 9 0 1 1 18.4 19.4", "t": "path"},
      {"d": "M12 13l4-4", "t": "path"},
      {"d": "M12 4.5v2M3.5 13h2M18.5 13h2", "t": "path"},
      {"cx": 12, "cy": 13, "fill": true, "r": 1.6, "t": "circle"}
    ],
    "v": 1
  },
  "server rack": {
    "accent": "green",
    "concept": "server rack",
    "shapes": [
      {"height": 7, "rx": 2, "t": "rect", "width": 18, "x": 3, "y": 3.5},
      {"height": 7, "rx": 2, "t": "rect", "width": 18, "x": 3, "y": 13.5},
      {"cx": 7, "cy": 7, "fill": true, "r": 1.2, "t": "circle"},
      {"cx": 7, "cy": 17, "fill": true, "r": 1.2, "t": "circle"},
      {"t": "line", "x1": 11, "x2": 17, "y1": 7, "y2": 7},
      {"t": "line", "x1": 11, "x2": 17, "y1": 17, "y2": 17}
    ],
    "v": 1
  },
  "lab flask": {
    "accent": "orange",
    "concept": "lab flask",
    "shapes": [
      {"d": "M9.5 3v6.5L4.5 18.3a1.8 1.8 0 0 0 1.6 2.7h11.8a1.8 1.8 0 0 0 1.6-2.7L14.5 9.5V3", "t": "path"},
      {"t": "line", "x1": 8, "x2": 16, "y1": 3, "y2": 3},
      {"t": "line", "x1": 7, "x2": 17, "y1": 15, "y2": 15},
      {"cx": 13.5, "cy": 18, "fill": true, "r": 1, "t": "circle"}
    ],
    "v": 1
  },
  "billboard": {
    "accent": "magenta",
    "concept": "billboard",
    "shapes": [
      {"height": 11, "rx": 2.5, "t": "rect", "width": 18, "x": 3, "y": 3},
      {"t": "line", "x1": 7, "x2": 13, "y1": 7, "y2": 7},
      {"t": "line", "x1": 7, "x2": 17, "y1": 10, "y2": 10},
      {"t": "line", "x1": 8, "x2": 8, "y1": 14, "y2": 21},
      {"t": "line", "x1": 16, "x2": 16, "y1": 14, "y2": 21}
    ],
    "v": 1
  },
  "ad click": {
    "accent": "magenta",
    "concept": "ad click",
    "shapes": [
      {"d": "M9 9l4.5 12 2-5.5 5.5-2z", "t": "path"},
      {"t": "line", "x1": 9, "x2": 9, "y1": 3, "y2": 5},
      {"t": "line", "x1": 3, "x2": 5, "y1": 9, "y2": 9},
      {"t": "line", "x1": 4.8, "x2": 6.2, "y1": 4.8, "y2": 6.2}
    ],
    "v": 1
  },
  "share nodes": {
    "accent": "orange",
    "concept": "share nodes",
    "shapes": [
      {"cx": 18, "cy": 6, "r": 3, "t": "circle"},
      {"cx": 6, "cy": 12, "r": 3, "t": "circle"},
      {"cx": 18, "cy": 18, "r": 3, "t": "circle"},
      {"t": "line", "x1": 8.7, "x2": 15.3, "y1": 10.7, "y2": 7.3},
      {"t": "line", "x1": 8.7, "x2": 15.3, "y1": 13.3, "y2": 16.7}
    ],
    "v": 1
  },
  "lightbulb": {
    "accent": "violet",
    "concept": "lightbulb",
    "shapes": [
      {"d": "M9 17.5V16c0-.8-.6-1.4-1.5-2A6 6 0 1 1 16.5 14c-.9.6-1.5 1.2-1.5 2v1.5", "t": "path"},
      {"d": "M9 17.5h6M10 20.5h4", "t": "path"}
    ],
    "v": 1
  },
  "code brackets": {
    "accent": "cyan",
    "concept": "code brackets",
    "shapes": [
      {"points": [8, 7, 3, 12, 8, 17], "t": "polyline"},
      {"points": [16, 7, 21, 12, 16, 17], "t": "polyline"},
      {"t": "line", "x1": 14, "x2": 10, "y1": 4, "y2": 20}
    ],
    "v": 1
  },
  "cloud": {
    "accent": "blue",
    "concept": "cloud",
    "shapes": [
      {"d": "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z", "t": "path"}
    ],
    "v": 1
  },
  "compass": {
    "accent": "red",
    "concept": "compass",
    "shapes": [
      {"cx": 12, "cy": 12, "r": 9, "t": "circle"},
      {"points": [16.5, 7.5, 14, 14, 7.5, 16.5, 10, 10], "t": "polygon"}
    ],
    "v": 1
  },
  "app layout": {
    "accent": "yellow",
    "concept": "app layout",
    "shapes": [
      {"height": 16, "rx": 2.5, "t": "rect", "width": 18, "x": 3, "y": 4},
      {"t": "line", "x1": 9, "x2": 9, "y1": 4, "y2": 20},
      {"t": "line", "x1": 9, "x2": 21, "y1": 12, "y2": 12}
    ],
    "v": 1
  },
  "smartphone": {
    "accent": "green",
    "concept": "smartphone",
    "shapes": [
      {"height": 18, "rx": 2.5, "t": "rect", "width": 11, "x": 6.5, "y": 3},
      {"t": "line", "x1": 10.5, "x2": 13.5, "y1": 6, "y2": 6},
      {"cx": 12, "cy": 17.5, "fill": true, "r": 1.2, "t": "circle"}
    ],
    "v": 1
  },
  "customer check": {
    "accent": "orange",
    "concept": "customer check",
    "shapes": [
      {"cx": 9.5, "cy": 7.5, "r": 3.5, "t": "circle"},
      {"d": "M3 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6", "t": "path"},
      {"points": [15.5, 11, 17.5, 13, 21.5, 9], "t": "polyline"}
    ],
    "v": 1
  },
  "dialogue bubbles": {
    "accent": "cyan",
    "concept": "dialogue bubbles",
    "shapes": [
      {"d": "M5.5 9h7a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3.5V17A2.5 2.5 0 0 1 3 14.5v-3A2.5 2.5 0 0 1 5.5 9z", "t": "path"},
      {"d": "M9 9V5.5A2.5 2.5 0 0 1 11.5 3h7A2.5 2.5 0 0 1 21 5.5v4a2.5 2.5 0 0 1-2.5 2.5H18v3l-3-3", "t": "path"}
    ],
    "v": 1
  },
  "party popper": {
    "accent": "magenta",
    "concept": "party popper",
    "shapes": [
      {"d": "M3.5 20.5L8 9l7 7z", "t": "path"},
      {"t": "line", "x1": 12.5, "x2": 13.5, "y1": 7, "y2": 3.5},
      {"t": "line", "x1": 17, "x2": 20.5, "y1": 11.5, "y2": 10.5},
      {"cx": 17, "cy": 7, "fill": true, "r": 1.2, "t": "circle"},
      {"cx": 20.5, "cy": 4, "fill": true, "r": 1.2, "t": "circle"}
    ],
    "v": 1
  },
  "storefront": {
    "accent": "red",
    "concept": "storefront",
    "shapes": [
      {"d": "M3 9l1.5-5h15L21 9", "t": "path"},
      {"d": "M3 9a3 3 0 0 0 6 0a3 3 0 0 0 6 0a3 3 0 0 0 6 0", "t": "path"},
      {"d": "M5 12v8h14v-8", "t": "path"},
      {"d": "M10 20v-4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20", "t": "path"}
    ],
    "v": 1
  },
  "pull request": {
    "accent": "cyan",
    "concept": "pull request",
    "shapes": [
      {"cx": 6, "cy": 6, "r": 2.5, "t": "circle"},
      {"cx": 6, "cy": 18, "r": 2.5, "t": "circle"},
      {"cx": 18, "cy": 18, "r": 2.5, "t": "circle"},
      {"d": "M6 8.5v7", "t": "path"},
      {"d": "M18 15.5V9a3 3 0 0 0-3-3h-3", "t": "path"},
      {"d": "M14.5 3.5L12 6l2.5 2.5", "t": "path"}
    ],
    "v": 1
  },
  "gauge": {
    "accent": "magenta",
    "concept": "gauge",
    "shapes": [
      {"d": "M4.2 17.5A9 9 0 1 1 19.8 17.5", "t": "path"},
      {"d": "M12 13l4-4.5", "t": "path"},
      {"cx": 12, "cy": 13, "fill": true, "r": 1.6, "t": "circle"},
      {"d": "M8 20h8", "t": "path"}
    ],
    "v": 1
  },
  "speech bubbles": {
    "accent": "green",
    "concept": "speech bubbles",
    "shapes": [
      {"d": "M15 10a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z", "t": "path"},
      {"d": "M18 9h1a2 2 0 0 1 2 2v10l-4-4h-6a2 2 0 0 1-2-2v-.5", "t": "path"}
    ],
    "v": 1
  },
  "terminal window": {
    "accent": "violet",
    "concept": "terminal window",
    "shapes": [
      {"height": 15, "rx": 2.5, "t": "rect", "width": 18, "x": 3, "y": 4.5},
      {"points": [7, 9.5, 10, 12, 7, 14.5], "t": "polyline"},
      {"t": "line", "x1": 12, "x2": 17, "y1": 15, "y2": 15}
    ],
    "v": 1
  }
} satisfies Record<string, RoleIcon>;

export type IconKey = keyof typeof ICONS;
