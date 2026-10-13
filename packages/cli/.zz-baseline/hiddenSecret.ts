import { readStdinBody } from "./sendBody.js";

// Reading a secret at the terminal: provider keys, setup tokens, pasted
// connector tokens. One implementation, so every command that takes a secret
// keeps it off argv (and out of `ps` and shell history) the same way.

/** Read a secret from the tty with echo suppressed, so a pasted key never shows on
 *  screen or lands in shell history. Falls back to piped stdin for scripting. */
export async function promptHiddenSecret(promptText: string, readStdin: () => string = () => readStdinBody()): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped or redirected from a file: read the first line of stdin. A
    // synchronous read of fd 0 sees a regular file too; Bun's process.stdin
    // stream ends at once on a file fd after the CLI's startup.
    return readStdin().split("\n")[0].trim();
  }
  process.stdout.write(promptText);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = "";
  return await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf-8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode?.(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        } else if (ch === "\x03") { // Ctrl-C
          stdin.setRawMode?.(wasRaw ?? false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\x7f" || ch === "\x08") { // DEL / backspace
          value = value.slice(0, -1);
        } else if (ch >= " ") { // append printable, ignore stray control chars
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
