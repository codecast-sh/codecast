// The house style, hand drawn under ROLE_ICON_LANGUAGE and checked at 18,
// 22 and 44 px on both themes. The generator shows these to the model as
// siblings it must match in weight and density, and tests and the render
// gallery draw them as fixtures.
import type { RoleIcon } from "./roleIcon";

export const ROLE_ICON_EXAMPLES: readonly { title: string; icon: RoleIcon }[] = [
  {
    "title": "Head of People",
    "icon": {
      "v": 1,
      "concept": "org chart",
      "accent": "violet",
      "shapes": [
        {
          "t": "rect",
          "x": 9,
          "y": 3,
          "width": 6,
          "height": 5,
          "rx": 1.5
        },
        {
          "t": "rect",
          "x": 3,
          "y": 16,
          "width": 6,
          "height": 5,
          "rx": 1.5
        },
        {
          "t": "rect",
          "x": 15,
          "y": 16,
          "width": 6,
          "height": 5,
          "rx": 1.5
        },
        {
          "t": "path",
          "d": "M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"
        }
      ]
    }
  },
  {
    "title": "Resourcing lead",
    "icon": {
      "v": 1,
      "concept": "parcel",
      "accent": "orange",
      "shapes": [
        {
          "t": "path",
          "d": "M12 3l8 4.5v9L12 21l-8-4.5v-9z"
        },
        {
          "t": "path",
          "d": "M4 7.5l8 4.5 8-4.5M12 12v9"
        }
      ]
    }
  },
  {
    "title": "Finances lead",
    "icon": {
      "v": 1,
      "concept": "coin",
      "accent": "yellow",
      "shapes": [
        {
          "t": "circle",
          "cx": 12,
          "cy": 12,
          "r": 9
        },
        {
          "t": "path",
          "d": "M15 9.2c-.6-1-1.8-1.6-3-1.6-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.4 0 1.3-1.3 2.2-3 2.2-1.3 0-2.5-.6-3.1-1.6"
        },
        {
          "t": "path",
          "d": "M12 6v1.6M12 16.4V18"
        }
      ]
    }
  },
  {
    "title": "Intellectual lead",
    "icon": {
      "v": 1,
      "concept": "open book",
      "accent": "blue",
      "shapes": [
        {
          "t": "path",
          "d": "M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z"
        },
        {
          "t": "path",
          "d": "M12 6.5v13"
        }
      ]
    }
  },
  {
    "title": "Upkeep lead",
    "icon": {
      "v": 1,
      "concept": "wrench",
      "accent": "green",
      "shapes": [
        {
          "t": "path",
          "d": "M14.5 4.2a5 5 0 0 0-5.6 6.9L3.6 16.4a2 2 0 0 0 2.8 2.8l5.3-5.3a5 5 0 0 0 6.9-5.6l-3 3-2.8-.4-.4-2.8z"
        }
      ]
    }
  },
  {
    "title": "Infrastructure lead",
    "icon": {
      "v": 1,
      "concept": "database",
      "accent": "cyan",
      "shapes": [
        {
          "t": "ellipse",
          "cx": 12,
          "cy": 5.5,
          "rx": 7,
          "ry": 2.5
        },
        {
          "t": "path",
          "d": "M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"
        },
        {
          "t": "path",
          "d": "M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"
        }
      ]
    }
  },
  {
    "title": "Distractedness specialist",
    "icon": {
      "v": 1,
      "concept": "target",
      "accent": "red",
      "shapes": [
        {
          "t": "circle",
          "cx": 12,
          "cy": 12,
          "r": 9
        },
        {
          "t": "circle",
          "cx": 12,
          "cy": 12,
          "r": 5
        },
        {
          "t": "circle",
          "cx": 12,
          "cy": 12,
          "r": 1.5,
          "fill": true
        }
      ]
    }
  },
  {
    "title": "Plans lead",
    "icon": {
      "v": 1,
      "concept": "calendar",
      "accent": "blue",
      "shapes": [
        {
          "t": "rect",
          "x": 3.5,
          "y": 5,
          "width": 17,
          "height": 15.5,
          "rx": 2.5
        },
        {
          "t": "path",
          "d": "M3.5 10h17M8 3v4M16 3v4"
        },
        {
          "t": "circle",
          "cx": 8.5,
          "cy": 14.5,
          "r": 1.2,
          "fill": true
        }
      ]
    }
  },
  {
    "title": "Social lead",
    "icon": {
      "v": 1,
      "concept": "two people",
      "accent": "magenta",
      "shapes": [
        {
          "t": "circle",
          "cx": 9,
          "cy": 8,
          "r": 3.5
        },
        {
          "t": "path",
          "d": "M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"
        },
        {
          "t": "path",
          "d": "M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3c2.1.8 3.5 2.9 3.5 5.7"
        }
      ]
    }
  },
  {
    "title": "Romance lead",
    "icon": {
      "v": 1,
      "concept": "heart",
      "accent": "red",
      "shapes": [
        {
          "t": "path",
          "d": "M12 20s-8-4.6-8-10.4A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8 2.6C20 15.4 12 20 12 20z"
        }
      ]
    }
  },
  {
    "title": "Aesthetics lead",
    "icon": {
      "v": 1,
      "concept": "palette",
      "accent": "violet",
      "shapes": [
        {
          "t": "path",
          "d": "M12 3a9 9 0 0 0 0 18c1.4 0 2-1 1.6-2.2-.5-1.4.3-2.8 1.8-2.8H18a3 3 0 0 0 3-3c0-5.5-4-10-9-10z"
        },
        {
          "t": "circle",
          "cx": 7.5,
          "cy": 11,
          "r": 1.2,
          "fill": true
        },
        {
          "t": "circle",
          "cx": 10.5,
          "cy": 7,
          "r": 1.2,
          "fill": true
        },
        {
          "t": "circle",
          "cx": 15.5,
          "cy": 8,
          "r": 1.2,
          "fill": true
        }
      ]
    }
  },
  {
    "title": "Adventures lead",
    "icon": {
      "v": 1,
      "concept": "mountain flag",
      "accent": "orange",
      "shapes": [
        {
          "t": "path",
          "d": "M2.5 20l7-11 4 6 2.5-3.5 5.5 8.5z"
        },
        {
          "t": "path",
          "d": "M16 12V3.5l4 1.8-4 1.8"
        }
      ]
    }
  },
  {
    "title": "Aliveness lead",
    "icon": {
      "v": 1,
      "concept": "sprout",
      "accent": "green",
      "shapes": [
        {
          "t": "path",
          "d": "M12 21v-9"
        },
        {
          "t": "path",
          "d": "M12 12c0-4-3-6.5-7-6.5 0 4 3 6.5 7 6.5z"
        },
        {
          "t": "path",
          "d": "M12 14.5c0-3.5 2.6-6 6.5-6 0 3.5-2.6 6-6.5 6z"
        }
      ]
    }
  }
];
