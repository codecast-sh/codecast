import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
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
