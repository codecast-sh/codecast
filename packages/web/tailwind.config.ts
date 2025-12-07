import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
    darkMode: ["class"],
    content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
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
  				cyan: '#2aa198',
  				green: '#859900',
  				bg: 'var(--sol-bg)',
  				'bg-alt': 'var(--sol-bg-alt)',
  				'bg-highlight': 'var(--sol-bg-highlight)',
  				border: 'var(--sol-border)',
  				text: 'var(--sol-text)',
  				'text-secondary': 'var(--sol-text-secondary)',
  				'text-muted': 'var(--sol-text-muted)',
  				'text-dim': 'var(--sol-text-dim)'
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
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
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
