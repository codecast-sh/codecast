// One question at the terminal, answered on stdin. Ctrl C at the prompt reads
// as an empty answer, so a `[y/N]` question it interrupts reads as no.
import * as readline from "node:readline";

/** The line typed in answer to `question`, untrimmed; "" on Ctrl C. */
export async function askLine(question: string): Promise<string> {
  const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      iface.on("SIGINT", () => resolve(""));
      iface.question(question, resolve);
    });
  } finally {
    iface.close();
  }
}

/** A `[y/N]` question (the caller writes the suffix): true only for y or yes. */
export async function askYesNo(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await askLine(question)).trim());
}
