// Quoting for a POSIX shell (sh, bash, zsh): a value printed for eval or
// $(…), a command line sh runs, or one a person copies.

/** Always single-quoted: safe inside eval, $(…) and a `bash -c` body. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bare when it is a plain word, else shellQuote: the readable form of a command line. */
export function shellArg(value: string): string {
  if (value === "") return "''";
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : shellQuote(value);
}
