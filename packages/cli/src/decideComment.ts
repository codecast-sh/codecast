// `cast decide comment <sd-N> "words"`: a comment in a decision's team thread
// (convex decisionThread.ts). From a plain shell it is the person's: the
// decision's owner, the thread's people and anyone @mentioned are told, and a
// session or role it @mentions is asked. From inside a session the thread
// asked (or the decision's own), it is that session's answer in the thread.
import * as fs from "fs";
import { fmt } from "./colors.js";

type Post = (body: Record<string, unknown>, route: string) => Promise<any>;

/** The words: the arguments after the id, or stdin for `-`. */
export function commentWords(words: string[], readStdin: () => string = () => fs.readFileSync(0, "utf8")): string {
  const joined = words.length === 1 && words[0] === "-" ? readStdin() : words.join(" ");
  return joined.trim();
}

export async function commentOnDecision(post: Post, target: string, words: string[], options: { json?: boolean }, sessionId: string | null): Promise<void> {
  const text = commentWords(words);
  if (!text) {
    console.error(fmt.error('Usage: cast decide comment <sd-N> "what you want to say" (or - to read it from stdin)'));
    process.exit(1);
  }
  const result = await post({ decision_id: target, text, ...(sessionId ? { session_id: sessionId } : {}) }, "/cli/decide/comment");
  if (options.json) return void console.log(JSON.stringify(result, null, 2));
  const ref = result.short_id ?? target;
  console.log(`${fmt.success("Commented:")} on ${ref}.`);
  const asked = (result.asked ?? []).length;
  console.log(fmt.muted(`  Its owner and the thread's people are told.${asked ? ` ${asked === 1 ? "The session" : `${asked} sessions`} you named ${asked === 1 ? "was" : "were"} asked, and the answer lands in the thread.` : ""}`));
}
