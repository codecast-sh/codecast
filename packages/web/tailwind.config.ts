import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// Tailwind can't inject alpha into a bare var() color, so `/NN` opacity modifiers
// on these tokens silently emit NO css rule at all (transparent backgrounds,
// inherited text colors). color-mix defers the alpha math to the browser;
// <alpha-value> resolves to 1 when no modifier is given, so plain usage is unchanged.
const solVar = (name: string) =>
  `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;

const config: Config = {
    darkMode: ["class"],
    content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts}",
  ],
  theme: {
  	extend: {
  		colors: {
  			sol: {
  				base03: '#002b36',
  				base02: '#073642',
  				base01: '#586e75',
  				base00: '#657b83',
  				base0: '#839496',
  				base1: '#93a1a1',
  				base2: '#eee8d5',
  				base3: '#fdf6e3',
  				yellow: '#b58900',
  				orange: '#cb4b16',
  				red: '#dc322f',
  				magenta: '#d33682',
  				violet: '#6c71c4',
  				blue: '#268bd2',
  				cyan: 'rgb(42 161 152 / <alpha-value>)',
  				green: '#859900',
  				bg: solVar('--sol-bg'),
  				'bg-alt': solVar('--sol-bg-alt'),
  				'bg-inset': solVar('--sol-bg-inset'),
  				'bg-highlight': solVar('--sol-bg-highlight'),
  				card: solVar('--sol-card'),
  				'card-hover': solVar('--sol-card-hover'),
  				border: solVar('--sol-border'),
  				text: solVar('--sol-text'),
  				'text-secondary': solVar('--sol-text-secondary'),
  				'text-muted': solVar('--sol-text-muted'),
  				'text-dim': solVar('--sol-text-dim')
  			},
  			background: 'hsl(var(--background) / <alpha-value>)',
  			foreground: 'hsl(var(--foreground) / <alpha-value>)',
  			card: {
  				DEFAULT: 'hsl(var(--card) / <alpha-value>)',
  				foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
  				foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
  				foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
  				foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
  				foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
  				foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
  				foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
  			},
  			border: 'hsl(var(--border) / <alpha-value>)',
  			input: 'hsl(var(--input) / <alpha-value>)',
  			ring: 'hsl(var(--ring) / <alpha-value>)',
  			chart: {
  				'1': 'hsl(var(--chart-1) / <alpha-value>)',
  				'2': 'hsl(var(--chart-2) / <alpha-value>)',
  				'3': 'hsl(var(--chart-3) / <alpha-value>)',
  				'4': 'hsl(var(--chart-4) / <alpha-value>)',
  				'5': 'hsl(var(--chart-5) / <alpha-value>)'
  			}
  		},
  		fontFamily: {
  			mono: [
  				'var(--font-mono)',
  				'monospace'
  			],
  			sans: [
  				'var(--font-mono)',
  				'monospace'
  			],
  			serif: [
  				'var(--font-serif)',
  				'Georgia',
  				'serif'
  			]
  		},
  		typography: {
  			DEFAULT: {
  				css: {
  					fontFamily: 'var(--font-mono), monospace',
  					code: {
  						fontFamily: 'var(--font-mono), monospace'
  					},
  					pre: {
  						fontFamily: 'var(--font-mono), monospace'
  					}
  				}
  			},
  			invert: {
  				css: {
  					fontFamily: 'var(--font-mono), monospace'
  				}
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			},
  			'fadeSlideIn': {
  				'0%': {
  					opacity: '0',
  					transform: 'translateY(8px)'
  				},
  				'100%': {
  					opacity: '1',
  					transform: 'translateY(0)'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'fadeSlideIn': 'fadeSlideIn 0.3s ease-out'
  		}
  	}
  },
  plugins: [
    require("@tailwindcss/typography"),
    plugin(function ({ addVariant }) {
      addVariant("light", ".light &");
    }),
      require("tailwindcss-animate")
],
};
export default config;
