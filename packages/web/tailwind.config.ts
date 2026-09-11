import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

// A theme colour that lives in a CSS variable (light and dark swap the value
// at runtime) AND honours Tailwind's opacity modifier. A plain `var(--x)`
// colour cannot: Tailwind has no channels to put an alpha on, so it emits
// NOTHING for `bg-sol-bg-alt/95`, and the class silently does not exist.
// Resolved at build time through color-mix instead, which the browser
// evaluates against whichever value the variable holds when it paints.
//
// The bare class must stay byte-identical to what it always was. Tailwind
// hands the base utility its own `var(--tw-bg-opacity)` slot, so a literal
// number is the only case that mixes; a variable slot returns the plain
// colour, exactly as before.
//
// Typed as a string because Tailwind's Config type predates function colours;
// the runtime has accepted them since 3.1.
const themed = (variable: string): string =>
  (({ opacityValue }: { opacityValue?: string | number }) => {
    // The gradient plugin hands its transparent stop over as the number 0.
    const alpha = opacityValue === undefined ? undefined : String(opacityValue);
    return alpha === undefined || alpha.startsWith("var(")
      ? `var(${variable})`
      : `color-mix(in srgb, var(${variable}) calc(${alpha} * 100%), transparent)`;
  }) as unknown as string;

const config: Config = {
    darkMode: ["class"],
    content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    // hooks/ renders markup too — useCallRing draws the whole huddle ring
    // toast and useChatToasts the whole chat card. Leaving it out meant any
    // class used ONLY here was silently never generated, so those two files
    // worked by coincidence: whatever they shared with a scanned file applied,
    // and whatever they did not, did not. The ring toast's responsive layout
    // was half-built for exactly this reason (`sm:flex-none` never existed, so
    // its two buttons stayed flex-1 at desktop width and squeezed to 49px).
    "./hooks/**/*.{js,ts,jsx,tsx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
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
  				amber: '#b66f20',
  				red: '#dc322f',
  				magenta: '#d33682',
  				violet: '#6c71c4',
  				blue: '#268bd2',
  				cyan: 'rgb(42 161 152 / <alpha-value>)',
  				green: '#859900',
  				bg: themed('--sol-bg'),
  				'bg-alt': themed('--sol-bg-alt'),
  				'bg-inset': themed('--sol-bg-inset'),
  				'bg-highlight': themed('--sol-bg-highlight'),
  				card: themed('--sol-card'),
  				'card-hover': themed('--sol-card-hover'),
  				border: themed('--sol-border'),
  				text: themed('--sol-text'),
  				'text-secondary': themed('--sol-text-secondary'),
  				'text-muted': themed('--sol-text-muted'),
  				'text-dim': themed('--sol-text-dim')
  			},
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			}
  		},
  		fontFamily: {
  			mono: [
  				'var(--font-mono)',
  				'monospace'
  			],
  			sans: [
				'var(--font-ui)',
				'sans-serif'
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
					fontFamily: 'var(--font-ui), sans-serif',
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
					fontFamily: 'var(--font-ui), sans-serif'
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
