import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        sol: {
          base03: "#002b36",
          base02: "#073642",
          base01: "#586e75",
          base00: "#657b83",
          base0: "#839496",
          base1: "#93a1a1",
          base2: "#eee8d5",
          base3: "#fdf6e3",
          yellow: "#b58900",
          orange: "#cb4b16",
          red: "#dc322f",
          magenta: "#d33682",
          violet: "#6c71c4",
          blue: "#268bd2",
          cyan: "#2aa198",
          green: "#859900",
          bg: "var(--sol-bg)",
          "bg-alt": "var(--sol-bg-alt)",
          border: "var(--sol-border)",
          text: "var(--sol-text)",
          "text-secondary": "var(--sol-text-secondary)",
          "text-muted": "var(--sol-text-muted)",
          "text-dim": "var(--sol-text-dim)",
        },
      },
      fontFamily: {
        mono: ["var(--font-mono)", "monospace"],
        sans: ["var(--font-mono)", "monospace"],
      },
      typography: {
        DEFAULT: {
          css: {
            fontFamily: "var(--font-mono), monospace",
            code: {
              fontFamily: "var(--font-mono), monospace",
            },
            pre: {
              fontFamily: "var(--font-mono), monospace",
            },
          },
        },
        invert: {
          css: {
            fontFamily: "var(--font-mono), monospace",
          },
        },
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
    plugin(function ({ addVariant }) {
      addVariant("light", ".light &");
    }),
  ],
};
export default config;
