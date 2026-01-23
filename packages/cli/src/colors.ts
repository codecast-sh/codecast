const isColorSupported = process.stdout.isTTY !== false && process.env.NO_COLOR === undefined;

const raw = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
};

const none = Object.fromEntries(Object.keys(raw).map(k => [k, ""])) as typeof raw;
const codes = isColorSupported ? raw : none;

export const c = codes;

export const fmt = {
  label: (text: string) => `${c.dim}${text}${c.reset}`,
  value: (text: string) => text,
  success: (text: string) => `${c.green}${text}${c.reset}`,
  warning: (text: string) => `${c.yellow}${text}${c.reset}`,
  error: (text: string) => `${c.red}${text}${c.reset}`,
  muted: (text: string) => `${c.dim}${text}${c.reset}`,
  accent: (text: string) => `${c.cyan}${text}${c.reset}`,
  highlight: (text: string) => `${c.bold}${text}${c.reset}`,
  cmd: (text: string) => `${c.cyan}${text}${c.reset}`,
  path: (text: string) => `${c.blue}${text}${c.reset}`,
  number: (text: string | number) => `${c.yellow}${text}${c.reset}`,
  id: (text: string) => `${c.magenta}${text}${c.reset}`,
};

export const icons = {
  check: isColorSupported ? "●" : "*",
  cross: isColorSupported ? "○" : "x",
  dot: isColorSupported ? "·" : "-",
  arrow: isColorSupported ? "→" : "->",
  bullet: isColorSupported ? "•" : "-",
};
