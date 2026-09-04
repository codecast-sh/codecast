// Colour only when a person is looking at a terminal. A pipe has `isTTY`
// undefined (not false), so the test is `=== true`; agents reading through a
// Bash tool get plain text. FORCE_COLOR opts back in; NO_COLOR wins.
export const isColorSupported =
  process.env.NO_COLOR === undefined &&
  (process.stdout.isTTY === true || !!process.env.FORCE_COLOR);

const raw = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const none = Object.fromEntries(Object.keys(raw).map((k) => [k, ""])) as typeof raw;
export const c = isColorSupported ? raw : none;

export const fmt = {
  muted: (text: string) => `${c.dim}${text}${c.reset}`,
  bold: (text: string) => `${c.bold}${text}${c.reset}`,
  success: (text: string) => `${c.green}${text}${c.reset}`,
  warning: (text: string) => `${c.yellow}${text}${c.reset}`,
  error: (text: string) => `${c.red}${text}${c.reset}`,
  accent: (text: string) => `${c.cyan}${text}${c.reset}`,
  cmd: (text: string) => `${c.cyan}${text}${c.reset}`,
  path: (text: string) => `${c.blue}${text}${c.reset}`,
  id: (text: string) => `${c.magenta}${text}${c.reset}`,
};

export const icons = {
  check: isColorSupported ? "●" : "*",
  dot: isColorSupported ? "·" : "-",
  unread: isColorSupported ? "●" : "*",
  star: isColorSupported ? "★" : "*",
  clip: isColorSupported ? "⎘" : "@",
  bullet: isColorSupported ? "•" : "-",
};
